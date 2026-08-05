import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function runCapture(command, args, { input = null, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...env }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

function serviceFileName(service) {
  if (!/^[a-zA-Z0-9._-]+$/.test(service)) {
    throw new Error(`Invalid secret service name: ${service}`);
  }
  return `${service}.dpapi`;
}

export function windowsSecretDir(config = {}) {
  if (config.windowsSecretDir) return path.resolve(config.windowsSecretDir);
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "AIMAX", "LiveReplay", "secrets");
}

export function secretNames(config = {}) {
  const settings = config.keychain || {};
  return {
    account: settings.account || "make-youtube",
    oauthClient: settings.oauthClientJsonService || "make-youtube-oauth-client-json",
    oauthToken: settings.oauthTokenJsonService || "make-youtube-oauth-token-json",
    databaseUrl: settings.databaseUrlService || "make-youtube-database-url"
  };
}

async function windowsSecretGet(config, service) {
  const filePath = path.join(windowsSecretDir(config), serviceFileName(service));
  try {
    await fs.access(filePath);
  } catch {
    return null;
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$bytes=[IO.File]::ReadAllBytes($env:MAKE_YOUTUBE_SECRET_PATH)",
    "Add-Type -AssemblyName System.Security",
    "$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
    "[Console]::Write([Text.Encoding]::UTF8.GetString($plain))"
  ].join(";");
  try {
    return await runCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { MAKE_YOUTUBE_SECRET_PATH: filePath }
    });
  } catch {
    return null;
  }
}

async function windowsSecretSet(config, service, value) {
  const dir = windowsSecretDir(config);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, serviceFileName(service));
  const script = [
    "$ErrorActionPreference='Stop'",
    "$text=[Console]::In.ReadToEnd()",
    "$bytes=[Text.Encoding]::UTF8.GetBytes($text)",
    "Add-Type -AssemblyName System.Security",
    "$protected=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[IO.File]::WriteAllBytes($env:MAKE_YOUTUBE_SECRET_PATH,$protected)"
  ].join(";");
  await runCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: value,
    env: { MAKE_YOUTUBE_SECRET_PATH: filePath }
  });
}

async function macSecretGet(account, service) {
  try {
    return (await runCapture("security", ["find-generic-password", "-a", account, "-s", service, "-w"])).trim();
  } catch {
    return null;
  }
}

async function macSecretSet(account, service, value) {
  await runCapture("security", ["add-generic-password", "-a", account, "-s", service, "-w", value, "-U"]);
}

export async function getSecret(config, service) {
  const { account } = secretNames(config);
  if (process.platform === "win32") return windowsSecretGet(config, service);
  if (process.platform === "darwin") return macSecretGet(account, service);
  return process.env[service.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()] || null;
}

export async function setSecret(config, service, value) {
  const { account } = secretNames(config);
  if (process.platform === "win32") return windowsSecretSet(config, service, value);
  if (process.platform === "darwin") return macSecretSet(account, service, value);
  throw new Error(`Secure secret storage is not configured for ${process.platform}.`);
}
