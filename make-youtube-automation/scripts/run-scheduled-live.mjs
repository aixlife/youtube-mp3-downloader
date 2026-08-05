import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getSecret, secretNames } from "../lib/secret-store.mjs";
import {
  lessonMatchesTarget,
  manifestItemForLive,
  mergeResumableManifestItem,
  scheduledTarget,
  selectLiveForDate
} from "../lib/live-schedule.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = {
    config: "config.windows.json",
    doctor: false,
    sourceDate: null,
    kind: null,
    source: null,
    slot: "manual"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") args.config = argv[++i];
    else if (arg === "--doctor") args.doctor = true;
    else if (arg === "--date") args.sourceDate = argv[++i];
    else if (arg === "--kind") args.kind = argv[++i];
    else if (arg === "--source") args.source = argv[++i];
    else if (arg === "--slot") args.slot = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if ((args.sourceDate && !args.kind) || (!args.sourceDate && args.kind)) {
    throw new Error("--date and --kind must be provided together.");
  }
  if (args.kind && !["ai", "business"].includes(args.kind)) {
    throw new Error("--kind must be ai or business.");
  }
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, { capture = false, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env,
      windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

function sourceVideoId(source) {
  if (!source) return null;
  const match = source.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|live\/)|[?&]v=)([^?&#/\s]+)/);
  return match?.[1] || (/^[a-zA-Z0-9_-]{6,}$/.test(source) ? source : null);
}

async function googleContext(config) {
  const names = secretNames(config);
  const [clientText, tokenText] = await Promise.all([
    getSecret(config, names.oauthClient),
    getSecret(config, names.oauthToken)
  ]);
  if (!clientText || !tokenText) throw new Error("YouTube OAuth secrets are missing from secure storage.");
  const clientJson = JSON.parse(clientText);
  const token = JSON.parse(tokenText);
  const details = clientJson.installed || clientJson.web;
  if (!details?.client_id || !details?.client_secret) throw new Error("Stored YouTube OAuth client is invalid.");
  const { google } = await import("googleapis");
  const oauth = new google.auth.OAuth2(
    details.client_id,
    details.client_secret,
    details.redirect_uris?.[0] || "http://127.0.0.1"
  );
  oauth.setCredentials(token);
  return { oauth, youtube: google.youtube({ version: "v3", auth: oauth }) };
}

async function listRecentChannelVideos(youtube, maxPages = 3) {
  const channels = await youtube.channels.list({ part: ["id", "snippet", "contentDetails"], mine: true });
  const channel = channels.data.items?.[0];
  if (!channel) throw new Error("Authorized YouTube channel was not found.");
  const playlistId = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) throw new Error("Authorized YouTube channel has no uploads playlist.");

  const ids = [];
  let pageToken;
  let page = 0;
  do {
    const response = await youtube.playlistItems.list({
      part: ["contentDetails"],
      playlistId,
      maxResults: 50,
      pageToken
    });
    for (const item of response.data.items || []) {
      if (item.contentDetails?.videoId) ids.push(item.contentDetails.videoId);
    }
    pageToken = response.data.nextPageToken;
    page += 1;
  } while (pageToken && page < maxPages);

  const videos = [];
  for (let index = 0; index < ids.length; index += 50) {
    const response = await youtube.videos.list({
      part: ["id", "snippet", "liveStreamingDetails", "status"],
      id: ids.slice(index, index + 50)
    });
    videos.push(...(response.data.items || []));
  }
  return { channel, videos };
}

async function sourceVideo(youtube, videos, sourceDate, explicitSource) {
  const explicitId = sourceVideoId(explicitSource);
  if (explicitSource && !explicitId) throw new Error(`Invalid --source value: ${explicitSource}`);
  if (explicitId) {
    const cached = videos.find((video) => video.id === explicitId);
    if (cached) return { selected: cached, candidates: [cached] };
    const response = await youtube.videos.list({
      part: ["id", "snippet", "liveStreamingDetails", "status"],
      id: [explicitId]
    });
    return { selected: response.data.items?.[0] || null, candidates: response.data.items || [] };
  }
  return selectLiveForDate(videos, sourceDate);
}

async function prismaContext(config) {
  const databaseUrl = process.env.DATABASE_URL || await getSecret(config, secretNames(config).databaseUrl);
  if (!databaseUrl) throw new Error("Database URL is missing from secure storage.");
  const { PrismaClient } = await import("@prisma/client");
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

async function findRegisteredLesson(prisma, item) {
  const course = await prisma.course.findFirst({
    where: { title: item.courseTitle },
    include: { lessons: { orderBy: { sortOrder: "asc" } } }
  });
  const lesson = course?.lessons.find((candidate) => lessonMatchesTarget(candidate, item.sourceDate, item.title)) || null;
  return { course, lesson };
}

async function findEdgeExecutable(explicitPath = null) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  if (process.platform === "darwin") candidates.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  if (process.platform === "win32") {
    for (const base of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA]) {
      if (base) candidates.push(path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  }
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Continue through standard paths.
    }
  }
  throw new Error("Microsoft Edge executable was not found.");
}

async function exportBrowserCookies(config, sourceUrl, cookieFile) {
  if (process.platform === "win32" && config.cookieExportMode !== "yt-dlp") {
    await exportBrowserCookiesViaEdge(config, cookieFile);
    return;
  }

  const ytdlp = process.env.MAKE_YOUTUBE_YTDLP || config.ytDlp || "yt-dlp";
  const ytdlpArgs = [
    "--cookies-from-browser",
    config.cookiesFromBrowser || "edge:Default",
    "--cookies",
    cookieFile,
    "--simulate",
    "--skip-download",
    "--no-warnings",
    sourceUrl
  ];
  let closedEdge = null;
  try {
    await run(ytdlp, ytdlpArgs, { capture: true });
  } catch (error) {
    const cookieLocked = /Could not copy (?:Chrome|Chromium|Edge) cookie database/i.test(error.message);
    if (process.platform !== "win32" || config.closeEdgeForCookieExport === false || !cookieLocked) throw error;
    closedEdge = await closeEdgeForCookieExport(config);
    await fs.rm(cookieFile, { force: true });
    await run(ytdlp, ytdlpArgs, { capture: true });
  } finally {
    if (closedEdge?.hadVisibleWindow && config.restoreEdgeAfterCookieExport !== false) {
      await restoreEdgeWindow(closedEdge.edgePath);
    }
  }
  const stat = await fs.stat(cookieFile);
  if (stat.size < 100) throw new Error("Browser cookie export produced an unexpectedly small file.");
}

async function closeEdgeForCookieExport(config) {
  const edgePath = await findEdgeExecutable(config.edgeExecutablePath || null);
  const script = [
    "$processes=@(Get-Process msedge -ErrorAction SilentlyContinue)",
    "$hadVisible=@($processes | Where-Object {$_.MainWindowHandle -ne 0}).Count -gt 0",
    "$processes | Where-Object {$_.MainWindowHandle -ne 0} | ForEach-Object {[void]$_.CloseMainWindow()}",
    "Start-Sleep -Seconds 2",
    "Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
    "if($hadVisible){Write-Output 'visible'}else{Write-Output 'background'}"
  ].join(";");
  const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { capture: true });
  console.log("Edge was briefly closed so its cookie database could be copied safely.");
  return { edgePath, hadVisibleWindow: result.stdout.trim().endsWith("visible") };
}

async function restoreEdgeWindow(edgePath) {
  const script = "Start-Process -FilePath $env:MAKE_YOUTUBE_EDGE_PATH -ArgumentList '--restore-last-session'";
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    capture: true,
    env: { ...process.env, MAKE_YOUTUBE_EDGE_PATH: edgePath }
  });
  console.log("Edge was reopened with its previous session after cookie export.");
}

function edgeAutomationProfileDir(config) {
  const configured = config.edgeAutomationProfileDir || "edge-profile";
  return path.isAbsolute(configured) ? configured : path.resolve(rootDir, configured);
}

function isYouTubeGoogleCookie(cookie) {
  const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
  return domain === "youtube.com"
    || domain.endsWith(".youtube.com")
    || domain === "google.com"
    || domain.endsWith(".google.com");
}

function netscapeCookieText(cookies) {
  const lines = ["# Netscape HTTP Cookie File", "# Generated locally by AIMAX Live Replay", ""];
  for (const cookie of cookies) {
    const domain = cookie.httpOnly ? `#HttpOnly_${cookie.domain}` : cookie.domain;
    const includeSubdomains = String(cookie.domain || "").startsWith(".") ? "TRUE" : "FALSE";
    const expires = Number.isFinite(cookie.expires) && cookie.expires > 0 ? Math.floor(cookie.expires) : 0;
    lines.push([
      domain,
      includeSubdomains,
      cookie.path || "/",
      cookie.secure ? "TRUE" : "FALSE",
      expires,
      cookie.name,
      cookie.value
    ].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

async function findFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForEdgeCdp(port, child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Automation Edge exited before startup (code ${child.exitCode}).`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {
      // Edge is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("Automation Edge did not expose its local control port in time.");
}

async function copyIfPresent(source, destination) {
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function ensureEdgeAutomationProfile(config) {
  const profileDir = edgeAutomationProfileDir(config);
  const localState = path.join(profileDir, "Local State");
  const cookieDb = path.join(profileDir, "Default", "Network", "Cookies");
  const exists = await Promise.all([localState, cookieDb].map((filePath) => fs.stat(filePath)
    .then((stat) => stat.isFile())
    .catch(() => false)));
  if (exists.every(Boolean)) return { profileDir, bootstrapped: false };
  if (config.closeEdgeForCookieExport === false) {
    throw new Error("The dedicated Edge profile is missing and Edge closing is disabled for its one-time bootstrap.");
  }

  const edgeUserDataDir = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data");
  if (!process.env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is unavailable; the Edge profile cannot be located.");
  const closedEdge = await closeEdgeForCookieExport(config);
  try {
    await fs.mkdir(path.join(profileDir, "Default", "Network"), { recursive: true });
    const copied = await Promise.all([
      copyIfPresent(path.join(edgeUserDataDir, "Local State"), localState),
      copyIfPresent(path.join(edgeUserDataDir, "Default", "Network", "Cookies"), cookieDb),
      copyIfPresent(path.join(edgeUserDataDir, "Default", "Preferences"), path.join(profileDir, "Default", "Preferences")),
      copyIfPresent(path.join(edgeUserDataDir, "Default", "Secure Preferences"), path.join(profileDir, "Default", "Secure Preferences"))
    ]);
    if (!copied[0] || !copied[1]) {
      throw new Error("Edge's default profile did not contain the files needed for the dedicated automation profile.");
    }
    await writeJson(path.join(profileDir, "aimax-profile.json"), {
      createdAt: new Date().toISOString(),
      sourceProfile: "Edge Default",
      purpose: "AIMAX Live Replay YouTube Studio access"
    });
  } finally {
    if (closedEdge.hadVisibleWindow && config.restoreEdgeAfterCookieExport !== false) {
      await restoreEdgeWindow(closedEdge.edgePath);
    }
  }
  console.log("A dedicated local Edge profile was prepared for live replay automation.");
  return { profileDir, bootstrapped: true };
}

async function exportBrowserCookiesViaEdge(config, cookieFile) {
  const [{ chromium }, edgePath, profile] = await Promise.all([
    import("playwright-core"),
    findEdgeExecutable(config.edgeExecutablePath || null),
    ensureEdgeAutomationProfile(config)
  ]);
  const port = await findFreeLoopbackPort();
  const child = spawn(edgePath, [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile.profileDir}`,
    "--profile-directory=Default",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank"
  ], {
    cwd: rootDir,
    windowsHide: false,
    stdio: "ignore"
  });
  let browser;
  try {
    await waitForEdgeCdp(port, child);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error("Automation Edge opened without its persistent browser context.");
    const allCookies = await context.cookies();
    const cookies = allCookies.filter((cookie) => cookie.name && cookie.value && isYouTubeGoogleCookie(cookie));
    if (cookies.length === 0) {
      throw new Error("The dedicated Edge profile has no YouTube/Google login cookies. One-time browser login is required.");
    }

    if (profile.bootstrapped) {
      await context.clearCookies();
      await context.addCookies(cookies);
      await writeJson(path.join(profile.profileDir, "aimax-profile.json"), {
        createdAt: new Date().toISOString(),
        sanitizedAt: new Date().toISOString(),
        sourceProfile: "Edge Default",
        retainedDomains: ["youtube.com", "google.com"],
        purpose: "AIMAX Live Replay YouTube Studio access"
      });
    }

    await fs.writeFile(cookieFile, netscapeCookieText(cookies), { mode: 0o600 });
    const stat = await fs.stat(cookieFile);
    if (stat.size < 100) throw new Error("Edge cookie export produced an unexpectedly small file.");
    console.log(`YouTube/Google cookies were exported through the dedicated Edge profile (${cookies.length} cookies).`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null) child.kill();
  }
}

function parseNetscapeCookies(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line && (!line.startsWith("#") || line.startsWith("#HttpOnly_")))
    .map((line) => {
      const [rawDomain, , cookiePath, secure, expires, name, ...rest] = line.split("\t");
      return {
        name,
        value: rest.join("\t"),
        domain: rawDomain.replace(/^#HttpOnly_/, ""),
        path: cookiePath || "/",
        expires: Number(expires) > 0 ? Number(expires) : -1,
        httpOnly: rawDomain.startsWith("#HttpOnly_"),
        secure: secure === "TRUE"
      };
    })
    .filter((cookie) => cookie.name && cookie.value && /(?:youtube|google)\.com$/.test(cookie.domain.replace(/^\./, "")));
}

async function probeStudio(config, item, cookieFile) {
  const [{ chromium }, cookieText, edgePath] = await Promise.all([
    import("playwright-core"),
    fs.readFile(cookieFile, "utf8"),
    findEdgeExecutable(config.edgeExecutablePath || null)
  ]);
  const cookies = parseNetscapeCookies(cookieText);
  if (cookies.length === 0) throw new Error("No YouTube/Google cookies were available for the Studio check.");
  const browser = await chromium.launch({
    headless: true,
    executablePath: edgePath,
    args: ["--no-first-run", "--no-default-browser-check"]
  });
  try {
    const context = await browser.newContext();
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto(`https://studio.youtube.com/video/${item.sourceVideoId}/edit`, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
    await page.waitForTimeout(7000);
    const menu = page.locator("#overflow-menu-button");
    const studioAccess = await menu.count() === 1;
    if (!studioAccess) {
      return { studioAccess: false, processingReady: false, pageUrl: page.url(), pageTitle: await page.title() };
    }
    await menu.click({ force: true, timeout: 10000 });
    await page.waitForTimeout(1200);
    const processingReady = await page.evaluate(() => {
      const links = [];
      function walk(root) {
        for (const anchor of root.querySelectorAll('a[href*="download_my_video"]')) links.push(anchor.href);
        for (const element of root.querySelectorAll("*")) if (element.shadowRoot) walk(element.shadowRoot);
      }
      walk(document);
      return links.length > 0;
    });
    return { studioAccess: true, processingReady };
  } finally {
    await browser.close();
  }
}

async function acquireLock(lockPath) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
    return handle;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = await fs.stat(lockPath);
    const lockText = await fs.readFile(lockPath, "utf8").catch(() => "");
    const lockPid = Number(lockText.trim().split(/\s+/)[0]);
    let lockProcessAlive = Number.isInteger(lockPid) && lockPid > 0;
    if (lockProcessAlive) {
      try {
        process.kill(lockPid, 0);
      } catch (processError) {
        if (processError.code === "ESRCH") lockProcessAlive = false;
      }
    }
    if (!lockProcessAlive || Date.now() - stat.mtimeMs > 10 * 60 * 60 * 1000) {
      console.log(`Recovering stale runner lock${lockPid ? ` from pid ${lockPid}` : ""}.`);
      await fs.rm(lockPath, { force: true });
      return acquireLock(lockPath);
    }
    throw new Error("Another live replay run is already active.");
  }
}

async function runRepublish(args) {
  await run(process.execPath, ["scripts/republish-youtube-lives.mjs", ...args]);
}

async function assertManifestOk(manifestPath, stage) {
  const items = await readJson(manifestPath);
  const item = items?.[0];
  if (!item || item.status !== "ok") {
    throw new Error(`${stage} failed: ${item?.error || item?.status || "manifest item missing"}`);
  }
  return item;
}

async function doctor({ args, config, target, paths }) {
  const startedAt = new Date().toISOString();
  const names = secretNames(config);
  const secretChecks = Object.fromEntries(await Promise.all([
    ["oauthClient", names.oauthClient],
    ["oauthToken", names.oauthToken],
    ["databaseUrl", names.databaseUrl]
  ].map(async ([label, service]) => [label, Boolean(await getSecret(config, service))])));
  if (Object.values(secretChecks).some((present) => !present)) throw new Error("One or more secure credentials are missing.");

  const { youtube } = await googleContext(config);
  const { channel, videos } = await listRecentChannelVideos(youtube);
  const selection = await sourceVideo(youtube, videos, target.sourceDate, args.source);
  if (!selection.selected) throw new Error(`No YouTube live found for ${target.sourceDate}.`);
  const item = manifestItemForLive(selection.selected, target.sourceDate, target.kind);

  const prisma = await prismaContext(config);
  let registration;
  try {
    const { course, lesson } = await findRegisteredLesson(prisma, item);
    registration = {
      courseExists: Boolean(course),
      alreadyRegistered: Boolean(lesson),
      registeredUrl: lesson?.youtubeUrl || null
    };
  } finally {
    await prisma.$disconnect();
  }

  const ytdlp = process.env.MAKE_YOUTUBE_YTDLP || config.ytDlp || "yt-dlp";
  const ytdlpVersion = (await run(ytdlp, ["--version"], { capture: true })).stdout.trim();
  const edgePath = await findEdgeExecutable(config.edgeExecutablePath || null);
  const cookieFile = path.join(os.tmpdir(), `aimax-live-doctor-${process.pid}.cookies.txt`);
  let studio;
  try {
    await exportBrowserCookies(config, item.sourceUrl, cookieFile);
    studio = await probeStudio(config, item, cookieFile);
  } finally {
    await fs.rm(cookieFile, { force: true });
  }

  const report = {
    status: studio.studioAccess ? "ok" : "needs-browser-login",
    startedAt,
    finishedAt: new Date().toISOString(),
    mode: "doctor-no-upload",
    target,
    source: { videoId: item.sourceVideoId, title: item.title },
    channel: channel.snippet?.title || channel.id,
    candidatesForDate: selection.candidates.length,
    secureCredentials: secretChecks,
    database: registration,
    browser: {
      edgeFound: Boolean(edgePath),
      cookiesExported: true,
      studioAccess: studio.studioAccess,
      processingReady: studio.processingReady
    },
    tools: { ytdlpVersion }
  };
  const reportPath = path.join(paths.logsDir, `doctor-${target.sourceDate}-${target.kind}.json`);
  await writeJson(reportPath, report);
  console.log(JSON.stringify(report, null, 2));
  if (!studio.studioAccess) throw new Error("Edge is not signed in to the authorized YouTube Studio account.");
}

async function processScheduled({ args, config, configPath, target, paths }) {
  const statePath = path.join(paths.stateDir, `${target.sourceDate}-${target.kind}.json`);
  const existingState = await readJson(statePath).catch(() => null);
  if (existingState?.status === "complete") {
    console.log(`Already complete: ${target.sourceDate} ${target.kind} ${existingState.uploadedUrl || ""}`);
    return;
  }

  const saveState = async (status, extra = {}) => writeJson(statePath, {
    sourceDate: target.sourceDate,
    kind: target.kind,
    slot: args.slot,
    status,
    updatedAt: new Date().toISOString(),
    ...extra
  });

  await saveState("discovering");
  const { youtube } = await googleContext(config);
  const { videos } = await listRecentChannelVideos(youtube);
  const selection = await sourceVideo(youtube, videos, target.sourceDate, args.source);
  if (!selection.selected) {
    await saveState("waiting-source");
    console.log(`No live found yet for ${target.sourceDate}; the next scheduled slot may retry.`);
    return;
  }
  if (selection.candidates.length > 1) {
    console.log(`Found ${selection.candidates.length} lives for ${target.sourceDate}; selecting the latest start time.`);
  }

  const freshItem = manifestItemForLive(selection.selected, target.sourceDate, target.kind);
  const manifestPath = path.join(paths.manifestsDir, `${target.sourceDate}-${target.kind}.json`);
  const existingItems = await readJson(manifestPath).catch(() => null);
  const item = mergeResumableManifestItem(existingItems?.[0] || null, freshItem);
  await writeJson(manifestPath, [item]);

  const prisma = await prismaContext(config);
  try {
    const { lesson } = await findRegisteredLesson(prisma, item);
    if (lesson) {
      await saveState("complete", {
        sourceVideoId: item.sourceVideoId,
        uploadedUrl: lesson.youtubeUrl,
        completedBy: "existing-db-registration"
      });
      console.log(`Already registered in the lounge: ${lesson.youtubeUrl}`);
      return;
    }
  } finally {
    await prisma.$disconnect();
  }

  const cookieFile = path.join(os.tmpdir(), `aimax-live-${target.sourceDate}-${target.kind}-${process.pid}.cookies.txt`);
  try {
    let current = (await readJson(manifestPath))[0];
    const existingFile = current.filePath && await fs.stat(current.filePath).then((stat) => stat.isFile()).catch(() => false);
    if (!current.uploadedUrl && !existingFile) {
      await saveState("waiting-processing", { sourceVideoId: current.sourceVideoId });
      await exportBrowserCookies(config, current.sourceUrl, cookieFile);
      await runRepublish([
        "--config", configPath,
        "--manifest", manifestPath,
        "--extract-studio-links",
        "--download-studio",
        "--cookie-file", cookieFile
      ]);
      current = await assertManifestOk(manifestPath, "Studio download");
    }

    if (!current.uploadedUrl) {
      await saveState("uploading", { sourceVideoId: current.sourceVideoId });
    } else {
      await saveState("verifying-upload", { sourceVideoId: current.sourceVideoId, uploadedUrl: current.uploadedUrl });
    }
    await runRepublish(["--config", configPath, "--manifest", manifestPath, "--upload"]);
    current = await assertManifestOk(manifestPath, "YouTube upload/privacy verification");

    await saveState("applying-db", { sourceVideoId: current.sourceVideoId, uploadedUrl: current.uploadedUrl });
    await runRepublish(["--config", configPath, "--manifest", manifestPath, "--apply-db"]);

    const verifyPrisma = await prismaContext(config);
    try {
      const { lesson } = await findRegisteredLesson(verifyPrisma, current);
      if (!lesson || lesson.youtubeUrl !== current.uploadedUrl) {
        throw new Error("Lounge database verification did not find the newly uploaded URL.");
      }
    } finally {
      await verifyPrisma.$disconnect();
    }

    await runRepublish(["--config", configPath, "--manifest", manifestPath, "--cleanup-downloads"]);
    await saveState("complete", {
      sourceVideoId: current.sourceVideoId,
      uploadedUrl: current.uploadedUrl,
      completedAt: new Date().toISOString()
    });
    console.log(`Live replay complete: ${target.sourceDate} ${current.uploadedUrl}`);
  } catch (error) {
    const waiting = /Studio download link not found|Cannot find Studio overflow menu/i.test(error.message);
    await saveState(waiting ? "waiting-processing" : "error", { error: error.message });
    if (waiting) {
      console.log("YouTube is still processing the original live. The next scheduled slot will retry without duplicating uploads.");
      return;
    }
    throw error;
  } finally {
    await fs.rm(cookieFile, { force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const configPath = path.resolve(rootDir, args.config);
  const config = await readJson(configPath);
  const target = args.sourceDate ? { sourceDate: args.sourceDate, kind: args.kind } : scheduledTarget();
  const paths = {
    manifestsDir: path.resolve(rootDir, config.manifestsDir || "manifests"),
    stateDir: path.resolve(rootDir, config.stateDir || "state"),
    logsDir: path.resolve(rootDir, config.logsDir || "logs")
  };
  await Promise.all(Object.values(paths).map((dir) => fs.mkdir(dir, { recursive: true })));

  const lockPath = path.join(paths.stateDir, "runner.lock");
  const lock = await acquireLock(lockPath);
  try {
    if (args.doctor) await doctor({ args, config, target, paths });
    else await processScheduled({ args, config, configPath, target, paths });
  } finally {
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
