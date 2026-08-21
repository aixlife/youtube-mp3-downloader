import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { monitorOutcome, monitorPlan } from "../lib/replay-monitor.mjs";
import {
  buildRuntimeIncident,
  classifyRuntimeFailure,
  safeFailureMessage,
} from "../lib/runtime-health.mjs";
import { scheduledTarget } from "../lib/live-schedule.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { config: "config.windows.json", sourceDate: null, kind: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") args.config = argv[++index];
    else if (arg === "--date") args.sourceDate = argv[++index];
    else if (arg === "--kind") args.kind = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if ((args.sourceDate && !args.kind) || (!args.sourceDate && args.kind)) {
    throw new Error("--date and --kind must be provided together.");
  }
  if (args.sourceDate && !/^\d{4}-\d{2}-\d{2}$/.test(args.sourceDate)) {
    throw new Error("--date must use YYYY-MM-DD.");
  }
  if (args.kind && !["ai", "business"].includes(args.kind)) {
    throw new Error("--kind must be ai or business.");
  }
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tempPath, filePath);
}

function run(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
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
      else reject(new Error(`${path.basename(command)} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

async function currentCommit() {
  try {
    const result = await run("git", ["rev-parse", "HEAD"], { capture: true });
    return result.stdout.trim().slice(0, 40) || null;
  } catch {
    return null;
  }
}

function liveRunnerArgs(configPath, target) {
  return [
    path.join(rootDir, "scripts", "run-scheduled-live.mjs"),
    "--config", configPath,
    "--slot", "monitor",
    "--date", target.sourceDate,
    "--kind", target.kind,
  ];
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const configPath = path.resolve(rootDir, args.config);
  const config = await readJson(configPath);
  const target = args.sourceDate ? { sourceDate: args.sourceDate, kind: args.kind } : scheduledTarget();
  const stateDir = path.resolve(rootDir, config.stateDir || "state");
  const logsDir = path.resolve(rootDir, config.logsDir || "logs");
  const statePath = path.join(stateDir, `${target.sourceDate}-${target.kind}.json`);
  const reportPath = path.join(stateDir, `${target.sourceDate}-${target.kind}-monitor.json`);
  const before = await readJson(statePath).catch(() => null);
  const plan = monitorPlan(before);
  const startedAt = new Date().toISOString();
  const commit = await currentCommit();
  let runnerError = null;

  if (plan.action === "resume") {
    try {
      await run(process.execPath, liveRunnerArgs(configPath, target));
    } catch (error) {
      runnerError = error;
    }
  }

  const after = await readJson(statePath).catch(() => null);
  const outcome = monitorOutcome(after, plan.action === "resume");
  const report = {
    version: 1,
    sourceDate: target.sourceDate,
    kind: target.kind,
    status: outcome.status,
    action: plan.action,
    reason: plan.reason,
    beforeStatus: plan.beforeStatus,
    afterStatus: outcome.afterStatus,
    runnerExitOk: !runnerError,
    commit,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(reportPath, report);
  console.log(JSON.stringify({ ...report, reportPath }));

  if (!outcome.ok) {
    const error = runnerError || new Error(`Replay remained ${outcome.afterStatus} after the Windows monitor pass.`);
    const classification = after?.failureClass || classifyRuntimeFailure(error);
    const incident = buildRuntimeIncident({
      sourceDate: target.sourceDate,
      kind: target.kind,
      slot: "monitor",
      stage: "windows-monitor",
      error,
      classification,
      commit,
      autoRepairAttempted: false,
    });
    const stamp = incident.occurredAt.replace(/[:.]/g, "-");
    const incidentPath = path.join(logsDir, "incidents", `monitor-${target.sourceDate}-${target.kind}-${stamp}.json`);
    await writeJsonAtomic(incidentPath, incident);
    throw new Error(`${safeFailureMessage(error)} Incident: ${incidentPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(safeFailureMessage(error));
    process.exitCode = 1;
  });
}
