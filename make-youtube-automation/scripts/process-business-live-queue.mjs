import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { google } = require("googleapis");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const manifestPath = path.join(rootDir, "manifest.local.json");
const cookieFile = "/tmp/make-youtube-edge-cookies.txt";
const startAtDate = process.env.START_AT_DATE || null;

const queue = [
  { sourceDate: "2026-03-05", sourceVideoId: "q4WhUVHt3UQ" },
  { sourceDate: "2026-03-12", sourceVideoId: "BiCe9O3jVN0" },
  { sourceDate: "2026-03-19", sourceVideoId: "TATHz0_BROs" },
  { sourceDate: "2026-04-02", sourceVideoId: "JwDWZKrAJFc" },
  { sourceDate: "2026-04-09", sourceVideoId: "VIgJD8aM-34" },
  { sourceDate: "2026-04-16", sourceVideoId: "zj-hTToIXhU" },
  { sourceDate: "2026-04-23", sourceVideoId: "skwCsmXPLY0" },
  { sourceDate: "2026-05-07", sourceVideoId: "5KJq4x0q87M" },
  { sourceDate: "2026-05-14", sourceVideoId: "4eFg2JdTT3o" },
  { sourceDate: "2026-05-21", sourceVideoId: "EATeVgX65bA" },
  { sourceDate: "2026-05-28", sourceVideoId: "R8yM4Sx77h4" },
  { sourceDate: "2026-06-11", sourceVideoId: "x0jvpoc_JOI" },
  { sourceDate: "2026-06-18", sourceVideoId: "xtxmO_c9djg" },
  { sourceDate: "2026-06-25", sourceVideoId: "6oZpeb7lwrc" }
];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || rootDir,
      env: options.env || process.env,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function keychainGet(service) {
  const result = spawnSync("security", [
    "find-generic-password",
    "-a",
    "make-youtube",
    "-s",
    service,
    "-w"
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Missing Keychain service ${service}`);
  }
  return result.stdout.trim();
}

async function getYoutubeClient() {
  const clientJson = JSON.parse(keychainGet("make-youtube-oauth-client-json"));
  const token = JSON.parse(keychainGet("make-youtube-oauth-token-json"));
  const details = clientJson.installed || clientJson.web;
  const oauth2 = new google.auth.OAuth2(
    details.client_id,
    details.client_secret,
    details.redirect_uris?.[0] || "http://127.0.0.1"
  );
  oauth2.setCredentials(token);
  return google.youtube({ version: "v3", auth: oauth2 });
}

async function getVideoDetails(youtube, ids) {
  const response = await youtube.videos.list({
    part: ["id", "snippet"],
    id: ids
  });
  return new Map((response.data.items || []).map((video) => [video.id, video]));
}

async function writeSingleItemManifest(item) {
  await fs.writeFile(manifestPath, JSON.stringify([item], null, 2));
}

async function readSingleItemManifest() {
  const items = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (!Array.isArray(items) || items.length !== 1) {
    throw new Error("Expected manifest.local.json to contain exactly one item.");
  }
  return items[0];
}

async function assertCurrentItemOk(stage) {
  const item = await readSingleItemManifest();
  if (item.status !== "ok") {
    throw new Error(`${stage} failed for ${item.sourceDate} ${item.title}: ${item.error || item.status}`);
  }
  return item;
}

async function removePartialDownload(item) {
  const base = path.join(rootDir, "downloads", `${item.sourceDate}-${item.sourceVideoId}`);
  await Promise.all([
    fs.rm(`${base}.mp4`, { force: true }),
    fs.rm(`${base}.jpg`, { force: true })
  ]);
}

async function downloadWithRetries(item, maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      console.log(`download retry ${attempt}/${maxAttempts}: ${item.sourceDate} ${item.sourceVideoId}`);
    }
    await removePartialDownload(item);
    await writeSingleItemManifest(item);
    try {
      await run("node", [
        "scripts/republish-youtube-lives.mjs",
        "--manifest",
        "manifest.local.json",
        "--extract-studio-links",
        "--download-studio",
        "--cookie-file",
        cookieFile
      ]);
    } catch (error) {
      lastError = error;
      continue;
    }
    try {
      return await assertCurrentItemOk("download");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function refreshCookies(sourceUrl) {
  await run("yt-dlp", [
    "--cookies-from-browser",
    "edge:Default",
    "--cookies",
    cookieFile,
    "--simulate",
    sourceUrl
  ]);
}

async function main() {
  const youtube = await getYoutubeClient();
  let pendingQueue = queue;
  if (startAtDate) {
    const startIndex = queue.findIndex((item) => item.sourceDate === startAtDate);
    if (startIndex < 0) throw new Error(`START_AT_DATE not found in queue: ${startAtDate}`);
    pendingQueue = queue.slice(startIndex);
  }
  const videoMap = await getVideoDetails(youtube, pendingQueue.map((item) => item.sourceVideoId));

  const results = [];
  try {
    for (let index = 0; index < pendingQueue.length; index += 1) {
      const source = pendingQueue[index];
      const video = videoMap.get(source.sourceVideoId);
      if (!video) throw new Error(`YouTube source not found: ${source.sourceVideoId}`);

      const title = video.snippet?.title || `Live ${source.sourceDate}`;
      const item = {
        sourceDate: source.sourceDate,
        sourceVideoId: source.sourceVideoId,
        sourceUrl: `https://youtu.be/${source.sourceVideoId}`,
        courseTitle: "라이브 다시보기 - 비즈니스",
        courseCategory: "라이브 다시보기",
        courseIsFree: false,
        courseSortOrder: 1,
        createCourseIfMissing: true,
        title: `${source.sourceDate} ${title}`,
        description: video.snippet?.description || "",
        privacyStatus: "unlisted",
        copyThumbnail: true
      };

      console.log(`\n=== ${index + 1}/${pendingQueue.length} ${item.title} ===`);
      await refreshCookies(item.sourceUrl);
      await downloadWithRetries(item);

      await run("node", [
        "scripts/republish-youtube-lives.mjs",
        "--manifest",
        "manifest.local.json",
        "--upload",
        "--cleanup-downloads"
      ]);
      const uploaded = await assertCurrentItemOk("upload");

      await run("node", [
        "scripts/republish-youtube-lives.mjs",
        "--manifest",
        "manifest.local.json",
        "--apply-db"
      ]);

      results.push({
        sourceDate: uploaded.sourceDate,
        title: uploaded.title,
        sourceVideoId: uploaded.sourceVideoId,
        uploadedUrl: uploaded.uploadedUrl,
        videoId: uploaded.videoId
      });
      console.log(`=== done ${uploaded.sourceDate}: ${uploaded.uploadedUrl} ===`);
    }
  } finally {
    await fs.rm(cookieFile, { force: true });
  }

  console.log("\nBusiness live queue complete:");
  for (const result of results) {
    console.log(JSON.stringify(result));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
