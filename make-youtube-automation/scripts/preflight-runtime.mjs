import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getSecret, secretNames } from "../lib/secret-store.mjs";
import {
  buildRuntimeIncident,
  classifyRuntimeFailure,
  isAutoRepairableFailure,
  safeFailureMessage,
} from "../lib/runtime-health.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { config: "config.windows.json", repair: false, slot: "manual" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") args.config = argv[++index];
    else if (arg === "--repair") args.repair = true;
    else if (arg === "--slot") args.slot = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!/^[a-z0-9_-]{1,40}$/i.test(args.slot)) {
    throw new Error("--slot must contain only letters, numbers, underscores, or hyphens.");
  }
  return args;
}

function runCapture(command, args, { env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ ok: false, error }));
    child.on("close", (code) => resolve({
      ok: code === 0,
      code,
      stdout,
      stderr,
      error: code === 0 ? null : new Error(stderr.trim() || stdout.trim() || `${path.basename(command)} exited with code ${code}`),
    }));
  });
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tempPath, filePath);
}

async function currentCommit() {
  const result = await runCapture("git", ["rev-parse", "HEAD"]);
  return result.ok ? result.stdout.trim().slice(0, 40) : null;
}

async function probe(databaseUrl) {
  return runCapture(process.execPath, [path.join(__dirname, "probe-prisma-client.mjs")], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

async function generateClient(databaseUrl) {
  const prismaCli = path.join(rootDir, "node_modules", "prisma", "build", "index.js");
  await fs.access(prismaCli);
  return runCapture(process.execPath, [
    prismaCli,
    "generate",
    "--schema",
    path.join(rootDir, "prisma", "schema.prisma"),
  ], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

async function recordIncident({ config, args, error, classification, commit, autoRepairAttempted }) {
  const logsDir = path.resolve(rootDir, config.logsDir || "logs");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const incidentPath = path.join(logsDir, "incidents", `runtime-preflight-${args.slot}-${stamp}.json`);
  const incident = buildRuntimeIncident({
    slot: args.slot,
    stage: "runtime-preflight",
    error,
    classification,
    commit,
    autoRepairAttempted,
  });
  await writeJsonAtomic(incidentPath, incident);
  return incidentPath;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const configPath = path.resolve(rootDir, args.config);
  let config = null;
  let commit = null;
  let autoRepairAttempted = false;
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf8"));
    commit = await currentCommit();
    const databaseUrl = process.env.DATABASE_URL || await getSecret(config, secretNames(config).databaseUrl);
    if (!databaseUrl) throw new Error("Database URL is missing from secure storage.");

    let result = await probe(databaseUrl);
    let classification = result.ok ? null : classifyRuntimeFailure(result.error);
    let repaired = false;

    if (!result.ok && args.repair && isAutoRepairableFailure(classification)) {
      autoRepairAttempted = true;
      let generated;
      try {
        generated = await generateClient(databaseUrl);
      } catch (error) {
        generated = { ok: false, error };
      }
      if (!generated.ok) {
        result = generated;
        classification = "prisma-generate-failed";
      } else {
        result = await probe(databaseUrl);
        classification = result.ok ? "prisma-client-uninitialized" : classifyRuntimeFailure(result.error);
        repaired = result.ok;
      }
    }

    if (!result.ok) {
      const incidentPath = await recordIncident({
        config,
        args,
        error: result.error,
        classification,
        commit,
        autoRepairAttempted,
      });
      console.error(JSON.stringify({
        status: "error",
        classification,
        autoRepairAttempted,
        incidentPath,
        error: safeFailureMessage(result.error),
      }));
      process.exitCode = 1;
      return;
    }

    console.log(JSON.stringify({
      status: "ok",
      checkedAt: new Date().toISOString(),
      repaired,
      recoveredFrom: repaired ? classification : null,
      slot: args.slot,
      commit,
    }));
  } catch (error) {
    const classification = classifyRuntimeFailure(error);
    const incidentPath = config
      ? await recordIncident({
          config,
          args,
          error,
          classification,
          commit,
          autoRepairAttempted,
        }).catch(() => null)
      : null;
    console.error(JSON.stringify({
      status: "error",
      classification,
      autoRepairAttempted,
      incidentPath,
      error: safeFailureMessage(error),
    }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      status: "error",
      classification: classifyRuntimeFailure(error),
      error: safeFailureMessage(error),
    }));
    process.exitCode = 1;
  });
}
