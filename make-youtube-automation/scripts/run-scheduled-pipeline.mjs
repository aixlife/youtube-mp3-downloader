import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildPublisherArgs,
  cafeAppliesTo,
  isCafeTerminal,
  normalizeCafePublisherConfig,
  shouldCleanupReplay,
  stateFromPublisherResult,
} from "../lib/cafe-pipeline.mjs";
import { scheduledTarget } from "../lib/live-schedule.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = {
    config: "config.windows.json",
    doctor: false,
    sourceDate: null,
    kind: null,
    source: null,
    slot: "manual",
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
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tempPath, filePath);
}

function run(command, args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env,
      windowsHide: true,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with code ${code}.`));
    });
  });
}

async function acquireLock(lockPath) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    return await fs.open(lockPath, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const age = Date.now() - (await fs.stat(lockPath)).mtimeMs;
    if (age < 12 * 60 * 60 * 1000) {
      throw new Error(`Scheduled Cafe pipeline is already running: ${lockPath}`);
    }
    await fs.rm(lockPath, { force: true });
    return fs.open(lockPath, "wx");
  }
}

function liveRunnerArgs(args, configPath) {
  const result = [path.join(rootDir, "scripts", "run-scheduled-live.mjs"), "--config", configPath, "--slot", args.slot];
  if (args.doctor) result.push("--doctor");
  if (args.sourceDate) result.push("--date", args.sourceDate, "--kind", args.kind);
  if (args.source) result.push("--source", args.source);
  return result;
}

async function localVideoPath(item) {
  if (!item?.filePath) return null;
  const candidate = path.isAbsolute(item.filePath) ? item.filePath : path.resolve(rootDir, item.filePath);
  const usable = await fs.stat(candidate)
    .then((stat) => stat.isFile() && stat.size > 0)
    .catch(() => false);
  return usable ? candidate : null;
}

async function cleanupReplay(configPath, manifestPath, cafeStatePath, state) {
  await run(process.execPath, [
    path.join(rootDir, "scripts", "republish-youtube-lives.mjs"),
    "--config", configPath,
    "--manifest", manifestPath,
    "--cleanup-downloads",
  ]);
  const cleaned = {
    ...state,
    cleanup: { status: "complete", completedAt: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  };
  await writeJson(cafeStatePath, cleaned);
  console.log("Cafe publication is complete; the downloaded live source was cleaned up.");
  return cleaned;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const configPath = path.resolve(rootDir, args.config);
  const config = await readJson(configPath);
  const target = args.sourceDate ? { sourceDate: args.sourceDate, kind: args.kind } : scheduledTarget();
  const stateDir = path.resolve(rootDir, config.stateDir || "state");
  const manifestsDir = path.resolve(rootDir, config.manifestsDir || "manifests");
  const logsDir = path.resolve(rootDir, config.logsDir || "logs");
  await Promise.all([stateDir, manifestsDir, logsDir].map((dir) => fs.mkdir(dir, { recursive: true })));

  const lockPath = path.join(stateDir, "pipeline.lock");
  const lock = await acquireLock(lockPath);
  try {
    await run(process.execPath, liveRunnerArgs(args, configPath));
    if (args.doctor) return;

    const liveStatePath = path.join(stateDir, `${target.sourceDate}-${target.kind}.json`);
    const liveState = await readJson(liveStatePath).catch(() => null);
    if (liveState?.status !== "complete") {
      console.log(`Replay is not complete yet (${liveState?.status || "no-state"}); Cafe publishing will wait.`);
      return;
    }

    const cafe = normalizeCafePublisherConfig(config, rootDir);
    if (!cafe.enabled) {
      console.log("Cafe publisher is disabled; replay automation finished without a Cafe write.");
      return;
    }
    if (!cafeAppliesTo(cafe, target.kind)) {
      console.log(`Cafe publishing is not configured for ${target.kind} lives (kinds: ${cafe.kinds.join(", ")}).`);
      return;
    }

    const manifestPath = path.join(manifestsDir, `${target.sourceDate}-${target.kind}.json`);
    const manifest = await readJson(manifestPath);
    const item = manifest?.[0];
    if (!item?.uploadedUrl) throw new Error("Replay manifest has no verified uploadedUrl for Cafe publishing.");

    const cafeStatePath = path.join(stateDir, `${target.sourceDate}-${target.kind}-cafe.json`);
    const previous = await readJson(cafeStatePath).catch(() => null);
    if (isCafeTerminal(previous, cafe)) {
      if (shouldCleanupReplay(previous, cafe) && previous.cleanup?.status !== "complete") {
        await cleanupReplay(configPath, manifestPath, cafeStatePath, previous);
      } else {
        console.log(`Cafe pipeline already complete: ${previous.articleUrl || previous.previewPath || ""}`);
      }
      return;
    }

    const attemptId = `${Date.now()}-${process.pid}`;
    const resultPath = path.join(logsDir, "cafe-results", `${target.sourceDate}-${target.kind}-${attemptId}.json`);
    await writeJson(cafeStatePath, {
      ...(previous || {}),
      sourceDate: target.sourceDate,
      kind: target.kind,
      mode: cafe.mode,
      ok: false,
      status: "running",
      stage: "publisher",
      publisherResultPath: resultPath,
      updatedAt: new Date().toISOString(),
    });

    const videoFile = await localVideoPath(item);
    const publisherArgs = buildPublisherArgs({ cafe, item, target, resultPath, videoFile });
    let processError = null;
    try {
      await run(cafe.python, publisherArgs, {
        env: { ...process.env, PYTHONUTF8: "1" },
      });
    } catch (error) {
      processError = error;
    }

    const result = await readJson(resultPath).catch(() => ({
      ok: false,
      status: "error",
      stage: "publisher-process",
      error: processError?.message || "Publisher did not write its result JSON.",
    }));
    let state = stateFromPublisherResult({ target, cafe, item, result, resultPath, previous });
    await writeJson(cafeStatePath, state);

    if (processError || !result.ok) {
      throw new Error(result.error || processError?.message || "Cafe publisher failed.");
    }
    if (!isCafeTerminal(state, cafe)) {
      throw new Error(`Cafe publisher returned a non-terminal ${cafe.mode} result: ${state.status}.`);
    }
    if (shouldCleanupReplay(state, cafe)) {
      state = await cleanupReplay(configPath, manifestPath, cafeStatePath, state);
    }
    console.log(`Cafe pipeline complete: ${state.articleUrl || state.previewPath || ""}`);
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
