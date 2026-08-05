import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getSecret, secretNames, setSecret } from "../lib/secret-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const studioDownloadUrls = new Map();

const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly"
];

function parseArgs(argv) {
  const args = {
    config: "config.example.json",
    manifest: null,
    dryRun: false,
    auth: false,
    download: false,
    downloadStudio: false,
    extractStudioLinks: false,
    upload: false,
    applyDb: false,
    cleanupDownloads: false,
    importOAuthClient: null,
    buildManifestByDates: null,
    studioChannelName: null,
    cookieFile: path.join(os.tmpdir(), "make-youtube-edge-cookies.txt"),
    edgeExecutablePath: process.env.MAKE_YOUTUBE_EDGE_PATH || null,
    out: "manifest.local.json",
    limit: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") args.config = argv[++i];
    else if (arg === "--manifest") args.manifest = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--auth") args.auth = true;
    else if (arg === "--download") throw new Error("Use --extract-studio-links and --download-studio. Direct yt-dlp source downloads are disabled for this workflow.");
    else if (arg === "--download-studio") args.downloadStudio = true;
    else if (arg === "--extract-studio-links") args.extractStudioLinks = true;
    else if (arg === "--upload") args.upload = true;
    else if (arg === "--apply-db") args.applyDb = true;
    else if (arg === "--cleanup-downloads") args.cleanupDownloads = true;
    else if (arg === "--import-oauth-client") args.importOAuthClient = argv[++i];
    else if (arg === "--build-manifest-by-dates") args.buildManifestByDates = argv[++i];
    else if (arg === "--cookie-file") args.cookieFile = argv[++i];
    else if (arg === "--edge-executable-path") args.edgeExecutablePath = argv[++i];
    else if (arg === "--studio-channel-name") args.studioChannelName = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.auth && !args.importOAuthClient && !args.buildManifestByDates && !args.download && !args.downloadStudio && !args.extractStudioLinks && !args.upload && !args.applyDb && !args.cleanupDownloads) {
    args.dryRun = true;
  }

  return args;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(path.resolve(rootDir, filePath), "utf8"));
}

function withoutSensitiveFields(value) {
  if (Array.isArray(value)) return value.map((item) => withoutSensitiveFields(item));
  if (!value || typeof value !== "object") return value;

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "downloadUrl") continue;
    output[key] = withoutSensitiveFields(entry);
  }
  return output;
}

async function writeJsonSafe(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(withoutSensitiveFields(value), null, 2));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || rootDir,
      env: options.env || process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });

    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}${stderr ? `\n${stderr}` : ""}`));
    });
  });
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function validateOAuthClientJson(json) {
  const client = json.installed || json.web;
  if (!client?.client_id || !client?.client_secret) {
    throw new Error("OAuth client JSON must include installed.client_id/client_secret or web.client_id/client_secret.");
  }
}

async function importOAuthClient(config, filePath) {
  const jsonText = await fs.readFile(path.resolve(filePath), "utf8");
  const json = JSON.parse(jsonText);
  validateOAuthClientJson(json);
  const names = secretNames(config);
  await setSecret(config, names.oauthClient, JSON.stringify(json));
  console.log(`OAuth client JSON saved to secure storage: ${names.oauthClient}`);
}

async function loadGoogleApis() {
  try {
    const [{ google }, { authenticate }] = await Promise.all([
      import("googleapis"),
      import("@google-cloud/local-auth")
    ]);
    return { google, authenticate };
  } catch (error) {
    throw new Error(`Missing Google libraries. Run npm install in ${rootDir} first.\n${error.message}`);
  }
}

async function getOAuthClient(config, { forceAuth = false } = {}) {
  const names = secretNames(config);
  const clientJsonText = await getSecret(config, names.oauthClient);

  if (!clientJsonText) {
    throw new Error(`Missing OAuth client JSON in secure storage: ${names.oauthClient}.`);
  }

  const clientJson = JSON.parse(clientJsonText);
  validateOAuthClientJson(clientJson);

  const { google, authenticate } = await loadGoogleApis();
  const tokenText = await getSecret(config, names.oauthToken);

  if (tokenText && !forceAuth) {
    const details = clientJson.installed || clientJson.web;
    const redirectUri = details.redirect_uris?.[0] || "http://127.0.0.1";
    const oauth2Client = new google.auth.OAuth2(details.client_id, details.client_secret, redirectUri);
    oauth2Client.setCredentials(JSON.parse(tokenText));
    return oauth2Client;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "make-youtube-oauth-"));
  const keyfilePath = path.join(tempDir, "client_secret.json");
  await fs.writeFile(keyfilePath, JSON.stringify(clientJson), { mode: 0o600 });

  try {
    const client = await authenticate({
      keyfilePath,
      scopes: YOUTUBE_SCOPES
    });

    await setSecret(config, names.oauthToken, JSON.stringify(client.credentials));
    console.log(`OAuth token JSON saved to secure storage: ${names.oauthToken}`);
    return client;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function formatKstDate(dateLike) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(dateLike));
}

async function listUploadsPlaylistVideos(authClient, maxPages = 10) {
  const { google } = await loadGoogleApis();
  const youtube = google.youtube({ version: "v3", auth: authClient });

  const channels = await youtube.channels.list({
    part: ["id", "snippet", "contentDetails"],
    mine: true
  });
  const channel = channels.data.items?.[0];
  if (!channel) throw new Error("No YouTube channel found for the authorized account.");

  const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) throw new Error("Authorized channel has no uploads playlist.");

  const uploadedIds = [];
  let pageToken = undefined;
  let pageCount = 0;

  do {
    const page = await youtube.playlistItems.list({
      part: ["contentDetails"],
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      pageToken
    });

    for (const item of page.data.items || []) {
      const id = item.contentDetails?.videoId;
      if (id) uploadedIds.push(id);
    }

    pageToken = page.data.nextPageToken;
    pageCount += 1;
  } while (pageToken && pageCount < maxPages);

  const videos = [];
  for (let i = 0; i < uploadedIds.length; i += 50) {
    const chunk = uploadedIds.slice(i, i + 50);
    const details = await youtube.videos.list({
      part: ["id", "snippet", "liveStreamingDetails", "status"],
      id: chunk
    });
    videos.push(...(details.data.items || []));
  }

  return { channel, videos };
}

async function buildManifestByDates(config, datesCsv, outPath) {
  const targetDates = new Set(datesCsv.split(",").map((date) => date.trim()).filter(Boolean));
  const authClient = await getOAuthClient(config);
  const { channel, videos } = await listUploadsPlaylistVideos(authClient);

  const matches = videos
    .map((video) => {
      const bestDate = video.liveStreamingDetails?.actualStartTime;
      return {
        video,
        kstDate: bestDate ? formatKstDate(bestDate) : null
      };
    })
    .filter((entry) => entry.kstDate && targetDates.has(entry.kstDate))
    .sort((a, b) => a.kstDate.localeCompare(b.kstDate));

  const manifest = matches.map(({ video, kstDate }) => ({
    sourceDate: kstDate,
    sourceVideoId: video.id,
    sourceUrl: `https://youtu.be/${video.id}`,
    title: video.snippet?.title || `Live ${kstDate}`,
    description: video.snippet?.description || "",
    privacyStatus: "unlisted",
    copyThumbnail: true
  }));

  const missingDates = [...targetDates].filter((date) => !matches.some((match) => match.kstDate === date));
  const output = path.resolve(rootDir, outPath);
  await fs.writeFile(output, JSON.stringify(manifest, null, 2));

  console.log(`Channel: ${channel.snippet?.title || channel.id}`);
  console.log(`Matched ${manifest.length}/${targetDates.size} target dates.`);
  for (const item of manifest) {
    console.log(`  ${item.sourceDate}: ${item.title} (${item.sourceUrl})`);
  }
  if (missingDates.length > 0) {
    console.log(`Missing dates: ${missingDates.join(", ")}`);
  }
  console.log(`Manifest: ${output}`);
}

function videoIdFromItem(item) {
  if (item.sourceVideoId) return item.sourceVideoId;
  const url = item.sourceUrl || item.youtubeUrl || "";
  const patterns = [
    /youtu\.be\/([^?&#/\s]+)/,
    /youtube\.com\/(?:watch\?v=|live\/|embed\/|shorts\/)([^?&#/\s]+)/,
    /[?&]v=([^?&#/\s]+)/
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function parseNetscapeCookies(filePath) {
  const text = fsSyncRead(filePath);
  return text
    .split(/\r?\n/)
    .filter((line) => line && (!line.startsWith("#") || line.startsWith("#HttpOnly_")))
    .map((line) => {
      const [rawDomain, , cookiePath, secure, , name, ...rest] = line.split("\t");
      const value = rest.join("\t");
      const domain = rawDomain.startsWith("#HttpOnly_") ? rawDomain.replace("#HttpOnly_", "") : rawDomain;
      return {
        name,
        value,
        domain,
        path: cookiePath || "/",
        expires: -1,
        httpOnly: rawDomain.startsWith("#HttpOnly_"),
        secure: secure === "TRUE"
      };
    })
    .filter((cookie) => cookie.name && cookie.value && (cookie.domain.includes("youtube.com") || cookie.domain.includes("google.com")));
}

function fsSyncRead(filePath) {
  return requireFs().readFileSync(filePath, "utf8");
}

let fsSyncModule = null;
function requireFs() {
  if (!fsSyncModule) {
    fsSyncModule = globalThis.__makeYoutubeFs || null;
  }
  if (!fsSyncModule) {
    throw new Error("Synchronous fs module is not initialized.");
  }
  return fsSyncModule;
}

async function initializeSyncFs() {
  if (!globalThis.__makeYoutubeFs) {
    globalThis.__makeYoutubeFs = await import("node:fs");
  }
  fsSyncModule = globalThis.__makeYoutubeFs;
}

async function extractStudioDownloadLinks(args, items) {
  await initializeSyncFs();
  const { chromium } = await import("playwright-core");
  const cookies = parseNetscapeCookies(args.cookieFile);
  if (cookies.length === 0) throw new Error(`No YouTube/Google cookies found in ${args.cookieFile}`);

  const edgeExecutablePath = await findEdgeExecutable(args.edgeExecutablePath);

  const browser = await chromium.launch({
    headless: true,
    executablePath: edgeExecutablePath,
    args: ["--no-first-run", "--no-default-browser-check"]
  });

  try {
    const context = await browser.newContext({ acceptDownloads: true });
    await context.addCookies(cookies);
    const page = await context.newPage();

    // Studio의 /video/<id>/edit는 활성 채널 기준으로 해석된다. 계정에 채널이 여러 개면
    // 활성 채널이 다른 채널로 바뀌어 있을 수 있고, 그때 편집 페이지는 권한 오류를 낸다.
    // --studio-channel-name이 주어지면 먼저 해당 채널로 전환한다.
    if (args.studioChannelName) {
      await page.goto("https://www.youtube.com/channel_switcher", { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForTimeout(8000);
      const target = page
        .locator(`a:has-text("${args.studioChannelName}"), yt-formatted-string:has-text("${args.studioChannelName}")`)
        .first();
      if (await target.count()) {
        await target.click({ force: true, timeout: 15000 });
        await page.waitForTimeout(9000);
        console.log(`  switched channel: ${args.studioChannelName}`);
      } else {
        throw new Error(`Cannot find channel "${args.studioChannelName}" in the account's channel list.`);
      }
    }

    for (const item of items) {
      const videoId = videoIdFromItem(item);
      if (!videoId) throw new Error(`Cannot find source video id for ${item.title || item.sourceUrl}`);
      if (item.downloadUrl) {
        studioDownloadUrls.set(videoId, item.downloadUrl);
        delete item.downloadUrl;
      }
      if (studioDownloadUrls.has(videoId)) {
        console.log(`  existing link: ${videoId}`);
        continue;
      }

      const editUrl = `https://studio.youtube.com/video/${videoId}/edit`;
      await page.goto(editUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(7000);

      const menuCount = await page.locator("#overflow-menu-button").count();
      if (menuCount !== 1) {
        // 표면 증상은 항상 같지만 원인은 여러 개다(활성 채널 불일치 / 스로틀 / 권한).
        // 페이지 본문을 함께 남겨야 어느 쪽인지 바로 갈린다.
        const bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300);
        throw new Error(
          `Cannot find Studio overflow menu for ${videoId}. Page says: "${bodyText}" (${page.url()})`,
        );
      }

      await page.locator("#overflow-menu-button").click({ force: true, timeout: 10000 });
      await page.waitForTimeout(1500);

      const downloadUrl = await page.evaluate(() => {
        const links = [];
        function walk(root) {
          for (const anchor of root.querySelectorAll('a[href*="download_my_video"]')) links.push(anchor.href);
          for (const element of root.querySelectorAll("*")) {
            if (element.shadowRoot) walk(element.shadowRoot);
          }
        }
        walk(document);
        return links[0] || null;
      });

      if (!downloadUrl) throw new Error(`Studio download link not found for ${videoId}`);
      studioDownloadUrls.set(videoId, downloadUrl);
      console.log(`  studio link: ${videoId}`);
    }
  } finally {
    await browser.close();
  }
}

async function findEdgeExecutable(explicitPath = null) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  if (process.platform === "darwin") {
    candidates.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  }
  if (process.platform === "win32") {
    for (const base of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA]) {
      if (base) candidates.push(path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  }

  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Try the next standard location.
    }
  }
  throw new Error(`Microsoft Edge executable not found. Checked: ${candidates.join(", ") || "no known paths"}`);
}

async function downloadSourceThumbnail(item, outputBase) {
  const videoId = videoIdFromItem(item);
  if (!videoId) return null;
  const candidates = [
    `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  ];

  for (const url of candidates) {
    const res = await fetch(url);
    const contentType = res.headers.get("content-type") || "";
    if (!res.ok || !contentType.includes("image")) continue;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 1024) continue;
    const thumbnailPath = `${outputBase}.jpg`;
    await fs.writeFile(thumbnailPath, bytes);
    return thumbnailPath;
  }

  return null;
}

async function downloadStudioVideo(args, config, item) {
  const videoId = videoIdFromItem(item);
  if (!videoId) throw new Error(`Cannot find source video id for ${item.title || item.sourceUrl}`);
  if (item.downloadUrl) {
    studioDownloadUrls.set(videoId, item.downloadUrl);
    delete item.downloadUrl;
  }
  const downloadUrl = studioDownloadUrls.get(videoId);
  if (!downloadUrl) throw new Error(`Missing downloadUrl for ${videoId}. Run --extract-studio-links first.`);

  const downloadsDir = path.resolve(rootDir, config.downloadsDir || "downloads");
  await ensureDir(downloadsDir);
  const outputBase = path.join(downloadsDir, `${item.sourceDate || "source"}-${videoId}`);
  const outputPath = `${outputBase}.mp4`;

  await run(process.platform === "win32" ? "curl.exe" : "curl", [
    "-L",
    "-b",
    args.cookieFile,
    "-A",
    "Mozilla/5.0",
    "--fail",
    "--show-error",
    "--output",
    outputPath,
    downloadUrl
  ]);
  studioDownloadUrls.delete(videoId);

  const stat = await fs.stat(outputPath);
  if (stat.size < 1024 * 1024) {
    throw new Error(`Downloaded file is unexpectedly small: ${outputPath} (${stat.size} bytes)`);
  }

  const thumbnailPath = await downloadSourceThumbnail(item, outputBase);
  return { videoPath: outputPath, thumbnailPath };
}

async function downloadVideo(config, item) {
  if (!item.sourceUrl) throw new Error(`Missing sourceUrl for item ${item.title || item.lessonId}`);

  const downloadsDir = path.resolve(rootDir, config.downloadsDir || "downloads");
  await ensureDir(downloadsDir);

  const args = [
    "--cookies-from-browser",
    config.cookiesFromBrowser || "chrome",
    "--write-thumbnail",
    "--convert-thumbnails",
    "jpg",
    "--merge-output-format",
    "mp4",
    "--paths",
    downloadsDir,
    "--output",
    "%(id)s.%(ext)s",
    "--print",
    "after_move:filepath",
    item.sourceUrl
  ];

  const result = await run(config.ytDlp || "yt-dlp", args, { capture: true });
  const files = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const file = files.at(-1);

  if (!file) {
    throw new Error(`yt-dlp did not report a downloaded file for ${item.sourceUrl}.`);
  }

  return {
    videoPath: file,
    thumbnailPath: await findDownloadedThumbnail(file)
  };
}

async function findDownloadedThumbnail(videoPath) {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  const entries = await fs.readdir(dir);
  const candidates = entries
    .filter((entry) => entry.startsWith(`${base}.`))
    .filter((entry) => /\.(jpe?g|png)$/i.test(entry))
    .map((entry) => path.join(dir, entry));
  return candidates[0] || null;
}

function mimeTypeForImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  return null;
}

async function uploadVideo(config, authClient, item, filePath) {
  const { google } = await loadGoogleApis();
  const youtube = google.youtube({ version: "v3", auth: authClient });

  const title = item.title || path.basename(filePath, path.extname(filePath));
  const requestBody = {
    snippet: {
      title,
      description: item.description || "",
      categoryId: item.categoryId || config.categoryId || "27",
      tags: item.tags || []
    },
    status: {
      privacyStatus: item.privacyStatus || config.privacyStatus || "unlisted",
      selfDeclaredMadeForKids: item.selfDeclaredMadeForKids ?? config.selfDeclaredMadeForKids ?? false
    }
  };

  if (requestBody.status.privacyStatus !== "unlisted") {
    throw new Error(`Refusing to upload with privacyStatus=${requestBody.status.privacyStatus}. This workflow requires unlisted.`);
  }

  const response = await youtube.videos.insert({
    part: ["snippet", "status"],
    notifySubscribers: item.notifySubscribers ?? config.notifySubscribers ?? false,
    requestBody,
    media: {
      body: createReadStream(filePath)
    }
  });

  if (!response.data.id) throw new Error("YouTube upload completed without a video id.");
  return {
    videoId: response.data.id,
    url: `https://youtu.be/${response.data.id}`
  };
}

function uploadedVideoId(item) {
  if (item.videoId) return item.videoId;
  const url = item.uploadedUrl || "";
  const match = url.match(/(?:youtu\.be\/|[?&]v=)([^?&#/\s]+)/);
  return match?.[1] || null;
}

async function verifyUploadedVideoIsUnlisted(authClient, item) {
  const videoId = uploadedVideoId(item);
  if (!videoId) throw new Error(`Cannot verify uploaded video id for ${item.uploadedUrl || item.title || "item"}.`);
  const { google } = await loadGoogleApis();
  const youtube = google.youtube({ version: "v3", auth: authClient });
  const response = await youtube.videos.list({ part: ["id", "status"], id: [videoId] });
  const video = response.data.items?.[0];
  if (!video) throw new Error(`Uploaded video ${videoId} was not found during privacy verification.`);
  if (video.status?.privacyStatus !== "unlisted") {
    throw new Error(`Uploaded video ${videoId} privacy is ${video.status?.privacyStatus || "unknown"}; expected unlisted.`);
  }
  return videoId;
}

async function setThumbnail(config, authClient, item, videoId, thumbnailPath) {
  if (!thumbnailPath) return { skipped: true, reason: "thumbnail file not found" };
  if ((item.copyThumbnail ?? config.copyThumbnail ?? true) !== true) {
    return { skipped: true, reason: "copyThumbnail disabled" };
  }

  const mimeType = mimeTypeForImage(thumbnailPath);
  if (!mimeType) return { skipped: true, reason: "thumbnail must be jpg or png" };

  const stat = await fs.stat(thumbnailPath);
  if (stat.size > 2 * 1024 * 1024) {
    return { skipped: true, reason: "thumbnail exceeds YouTube 2MB limit" };
  }

  const { google } = await loadGoogleApis();
  const youtube = google.youtube({ version: "v3", auth: authClient });
  await youtube.thumbnails.set({
    videoId,
    media: {
      mimeType,
      body: createReadStream(thumbnailPath)
    }
  });

  return { skipped: false, thumbnailPath };
}

function isInsideDir(filePath, dirPath) {
  const resolvedFile = path.resolve(filePath);
  const resolvedDir = path.resolve(dirPath);
  return resolvedFile === resolvedDir || resolvedFile.startsWith(`${resolvedDir}${path.sep}`);
}

function addCleanupCandidate(candidates, filePath, clear) {
  if (!filePath) return;
  const resolved = path.resolve(filePath);
  if (!candidates.has(resolved)) candidates.set(resolved, []);
  candidates.get(resolved).push(clear);
}

async function cleanupDownloads(config, items, { dryRun = false } = {}) {
  const downloadsDir = path.resolve(rootDir, config.downloadsDir || "downloads");
  let deletedCount = 0;

  console.log("\nCleanup downloaded source files");
  for (const item of items) {
    const label = item.title || item.sourceUrl || item.lessonId || "untitled item";
    if (!item.uploadedUrl) {
      console.log(`  skip not uploaded: ${label}`);
      continue;
    }

    const candidates = new Map();
    addCleanupCandidate(candidates, item.filePath, () => {
      item.filePath = null;
    });
    addCleanupCandidate(candidates, item.thumbnailPath, () => {
      item.thumbnailPath = null;
    });
    addCleanupCandidate(candidates, item.thumbnail?.thumbnailPath, () => {
      item.thumbnail = { ...item.thumbnail, thumbnailPath: null };
    });

    if (candidates.size === 0) {
      console.log(`  skip no local files: ${label}`);
      continue;
    }

    const deletedFiles = [];
    const skippedFiles = [];

    for (const [filePath, clearCallbacks] of candidates.entries()) {
      if (!isInsideDir(filePath, downloadsDir)) {
        skippedFiles.push({
          path: filePath,
          reason: `outside downloads dir: ${downloadsDir}`
        });
        console.log(`  skip outside downloads: ${filePath}`);
        continue;
      }

      let stat = null;
      try {
        stat = await fs.stat(filePath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }

      if (!stat) {
        skippedFiles.push({ path: filePath, reason: "not found" });
        for (const clear of clearCallbacks) clear();
        console.log(`  already gone: ${filePath}`);
        continue;
      }

      if (!stat.isFile()) {
        skippedFiles.push({ path: filePath, reason: "not a file" });
        console.log(`  skip not a file: ${filePath}`);
        continue;
      }

      if (dryRun) {
        skippedFiles.push({ path: filePath, reason: "dry run" });
        console.log(`  would delete: ${filePath}`);
        continue;
      }

      await fs.rm(filePath, { force: true });
      deletedCount += 1;
      deletedFiles.push(path.relative(rootDir, filePath));
      for (const clear of clearCallbacks) clear();
      console.log(`  deleted: ${filePath}`);
    }

    if (deletedFiles.length > 0 || skippedFiles.length > 0) {
      item.cleanup = {
        cleanedAt: new Date().toISOString(),
        deletedFiles,
        skippedFiles
      };
    }
  }

  console.log(`Cleanup complete: ${deletedCount} file(s) deleted.`);
}

async function applyDbUpdates(config, items) {
  const updates = items.filter((item) => item.uploadedUrl);
  if (updates.length === 0) {
    console.log("No uploadedUrl values to apply.");
    return;
  }

  const inlineScript = `
    import { PrismaClient } from "@prisma/client";
    const prisma = new PrismaClient();
    const updates = JSON.parse(process.env.MAKE_YOUTUBE_UPDATES_JSON);
    const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

    try {
      for (const item of updates) {
        let lesson = null;
        let course = null;

        if (item.lessonId) {
          lesson = await prisma.lesson.findUnique({ where: { id: Number(item.lessonId) } });
          if (lesson) {
            course = await prisma.course.findUnique({
              where: { id: lesson.courseId },
              include: { lessons: { orderBy: { sortOrder: "asc" } } }
            });
          }
        } else if (item.courseTitle) {
          course = await prisma.course.findFirst({
            where: { title: item.courseTitle },
            include: { lessons: { orderBy: { sortOrder: "asc" } } }
          });

          if (!course && item.createCourseIfMissing) {
            const maxCourseOrder = await prisma.course.aggregate({ _max: { sortOrder: true } });
            const courseSortOrder = item.courseSortOrder != null
              ? Number(item.courseSortOrder)
              : (maxCourseOrder._max.sortOrder || 0) + 1;

            course = await prisma.course.create({
              data: {
                title: item.courseTitle,
                description: item.courseDescription || null,
                category: item.courseCategory || "라이브 다시보기",
                isFree: Boolean(item.courseIsFree),
                sortOrder: courseSortOrder
              },
              include: { lessons: { orderBy: { sortOrder: "asc" } } }
            });
            console.log("created course C" + course.id + " " + course.title);
          }

          if (course) {
            if (item.sortOrder != null) {
              lesson = course.lessons.find((candidate) => candidate.sortOrder === Number(item.sortOrder));
            }
            if (!lesson && item.uploadedUrl) {
              lesson = course.lessons.find((candidate) => candidate.youtubeUrl === item.uploadedUrl);
            }
            if (!lesson && item.title) {
              lesson = course.lessons.find((candidate) => candidate.title === item.title);
            }
          }
        }

        if (!lesson) {
          if (!course) {
            throw new Error("Lesson not found for " + JSON.stringify({
              lessonId: item.lessonId,
              courseTitle: item.courseTitle,
              sortOrder: item.sortOrder
            }));
          }

          const nextLessonOrder = item.sortOrder != null
            ? Number(item.sortOrder)
            : course.lessons.reduce((max, candidate) => Math.max(max, candidate.sortOrder || 0), 0) + 1;

          const created = await prisma.lesson.create({
            data: {
              courseId: course.id,
              title: item.title || "라이브 다시보기",
              description: has(item, "lessonDescription") ? (item.lessonDescription || null) : null,
              type: "VIDEO",
              youtubeUrl: item.uploadedUrl,
              videoUrl: null,
              pdfPath: null,
              sortOrder: nextLessonOrder,
              isFree: Boolean(item.isFree)
            }
          });
          console.log("created L" + created.id + " (#" + nextLessonOrder + ") -> " + item.uploadedUrl);
          continue;
        }

        const data = {
          type: "VIDEO",
          youtubeUrl: item.uploadedUrl,
          videoUrl: null,
          pdfPath: null
        };
        if (item.title) data.title = item.title;
        if (has(item, "lessonDescription")) {
          data.description = item.lessonDescription || null;
        }

        await prisma.lesson.update({
          where: { id: lesson.id },
          data
        });
        console.log("updated L" + lesson.id + " -> " + item.uploadedUrl);
      }
    } finally {
      await prisma.$disconnect();
    }
  `;

  const databaseUrl = process.env.DATABASE_URL || await getSecret(config, secretNames(config).databaseUrl);
  if (!databaseUrl) {
    throw new Error(`Missing database URL in secure storage: ${secretNames(config).databaseUrl}.`);
  }

  await run(process.execPath, ["--input-type=module", "-e", inlineScript], {
    cwd: rootDir,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      MAKE_YOUTUBE_UPDATES_JSON: JSON.stringify(updates)
    }
  });
}

async function checkLocalServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("make-youtube auth callback helper");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address));
    });
    server.on("error", () => resolve(null));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await readJson(args.config);

  if (args.importOAuthClient) {
    await importOAuthClient(config, args.importOAuthClient);
    return;
  }

  if (args.auth) {
    const localServer = await checkLocalServer();
    if (!localServer) {
      throw new Error("Could not bind a local OAuth callback server on 127.0.0.1.");
    }
    await getOAuthClient(config, { forceAuth: true });
    console.log("OAuth authorization is ready.");
    return;
  }

  if (args.buildManifestByDates) {
    await buildManifestByDates(config, args.buildManifestByDates, args.out);
    return;
  }

  if (!args.manifest) {
    throw new Error("Missing --manifest path.");
  }

  const runDir = path.resolve(rootDir, config.runsDir || "runs", nowStamp());
  await ensureDir(runDir);

  let items = await readJson(args.manifest);
  if (!Array.isArray(items)) throw new Error("Manifest must be a JSON array.");
  for (const item of items) {
    const videoId = videoIdFromItem(item);
    if (videoId && item.downloadUrl) {
      studioDownloadUrls.set(videoId, item.downloadUrl);
      delete item.downloadUrl;
    }
  }
  if (args.limit) items = items.slice(0, args.limit);

  const report = {
    startedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    privacyStatus: config.privacyStatus || "unlisted",
    items: []
  };

  let authClient = null;
  if (args.upload) {
    authClient = await getOAuthClient(config);
  }

  if (args.extractStudioLinks) {
    await extractStudioDownloadLinks(args, items);
  }

  for (const item of items) {
    const result = { ...item, status: "pending" };
    report.items.push(result);

    try {
      console.log(`\n${item.title || item.sourceUrl || item.lessonId}`);

      if (args.dryRun) {
        result.status = "dry-run";
        console.log(`  would download: ${item.sourceUrl || "(existing file)"}`);
        console.log(`  would upload as: ${item.privacyStatus || config.privacyStatus || "unlisted"}`);
        console.log(`  would update: ${item.lessonId ? `lessonId ${item.lessonId}` : `${item.courseTitle} #${item.sortOrder}`}`);
        continue;
      }

      let filePath = item.filePath;
      let thumbnailPath = item.thumbnailPath || null;
      if (args.download) {
        const download = await downloadVideo(config, item);
        filePath = download.videoPath;
        thumbnailPath = download.thumbnailPath;
        result.filePath = filePath;
        result.thumbnailPath = thumbnailPath;
        console.log(`  downloaded: ${filePath}`);
        if (thumbnailPath) console.log(`  thumbnail: ${thumbnailPath}`);
      }

      if (args.downloadStudio) {
        const download = await downloadStudioVideo(args, config, item);
        filePath = download.videoPath;
        thumbnailPath = download.thumbnailPath;
        result.filePath = filePath;
        result.thumbnailPath = thumbnailPath;
        console.log(`  downloaded: ${filePath}`);
        if (thumbnailPath) console.log(`  thumbnail: ${thumbnailPath}`);
      }

      if (args.upload) {
        if (item.uploadedUrl) {
          result.uploadedUrl = item.uploadedUrl;
          result.videoId = uploadedVideoId(item);
          console.log(`  already uploaded: ${item.uploadedUrl}`);
        } else {
          if (!filePath) throw new Error("Upload needs item.filePath or a successful --download-studio step.");
          const upload = await uploadVideo(config, authClient, item, filePath);
          result.videoId = upload.videoId;
          result.uploadedUrl = upload.url;
          console.log(`  uploaded: ${upload.url}`);

          try {
            const thumbnail = await setThumbnail(config, authClient, item, upload.videoId, thumbnailPath);
            result.thumbnail = thumbnail;
            console.log(thumbnail.skipped ? `  thumbnail skipped: ${thumbnail.reason}` : "  thumbnail copied");
          } catch (error) {
            result.thumbnail = { skipped: true, error: error.message };
            console.log(`  thumbnail failed: ${error.message}`);
          }
        }
        result.videoId = await verifyUploadedVideoIsUnlisted(authClient, result);
        result.uploadedUrl = `https://youtu.be/${result.videoId}`;
        result.privacyVerifiedAt = new Date().toISOString();
        console.log("  privacy verified: unlisted");
      }

      result.status = "ok";
    } catch (error) {
      result.status = "error";
      result.error = error.message;
      console.error(`  error: ${error.message}`);
    }

    Object.assign(item, result);
    if (!args.dryRun && !args.limit && (args.download || args.downloadStudio || args.upload)) {
      await writeJsonSafe(path.resolve(rootDir, args.manifest), items);
    }
  }

  if (args.applyDb) {
    if (args.dryRun) {
      console.log("\nDRY RUN: skipping DB updates.");
    } else {
      await applyDbUpdates(config, report.items);
    }
  }

  if (args.cleanupDownloads) {
    await cleanupDownloads(config, report.items, { dryRun: args.dryRun });
  }

  if (!args.dryRun && !args.limit && (args.extractStudioLinks || args.download || args.downloadStudio || args.upload || args.cleanupDownloads)) {
    const manifestPath = path.resolve(rootDir, args.manifest);
    await writeJsonSafe(manifestPath, report.items);
    console.log(`Manifest updated: ${manifestPath}`);
  }

  const reportPath = path.join(runDir, "report.json");
  report.finishedAt = new Date().toISOString();
  await writeJsonSafe(reportPath, report);
  console.log(`\nReport: ${reportPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
