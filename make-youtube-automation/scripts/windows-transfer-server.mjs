import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWindowsSecretBundle } from "./create-windows-secret-bundle.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = {
    host: "0.0.0.0",
    advertiseHost: "127.0.0.1",
    port: 0,
    token: crypto.randomBytes(18).toString("base64url"),
    packagePath: null,
    configPath: path.join(rootDir, "config.windows.json"),
    memberappsEnvPath: path.resolve(rootDir, "..", "..", "memberapps", ".env.local"),
    transferDir: path.join(rootDir, "windows-transfer")
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") args.host = argv[++index];
    else if (arg === "--advertise-host") args.advertiseHost = argv[++index];
    else if (arg === "--port") args.port = Number(argv[++index]);
    else if (arg === "--token") args.token = argv[++index];
    else if (arg === "--package") args.packagePath = path.resolve(argv[++index]);
    else if (arg === "--config") args.configPath = path.resolve(argv[++index]);
    else if (arg === "--memberapps-env") args.memberappsEnvPath = path.resolve(argv[++index]);
    else if (arg === "--transfer-dir") args.transferDir = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.packagePath) throw new Error("--package is required.");
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error("Invalid --port.");
  return args;
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(text);
}

async function sendFile(res, filePath, contentType) {
  const bytes = await fs.readFile(filePath);
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": bytes.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(bytes);
}

async function readSmallBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(args.transferDir, { recursive: true, mode: 0o700 });
  const publicKeyPath = path.join(args.transferDir, "windows-public.xml");
  const bundlePath = path.join(args.transferDir, "windows.secret-bundle.json");
  const bootstrapPath = path.join(rootDir, "scripts", "bootstrap-windows.ps1");
  let bundlePromise = null;
  let server;

  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const prefix = `/${args.token}`;
      if (!url.pathname.startsWith(`${prefix}/`)) return sendText(res, 404, "Not found");
      const route = url.pathname.slice(prefix.length);

      if (req.method === "GET" && route === "/health") return sendText(res, 200, "ok");
      if (req.method === "GET" && route === "/bootstrap-windows.ps1") {
        return await sendFile(res, bootstrapPath, "text/plain; charset=utf-8");
      }
      if (req.method === "GET" && route === "/package.zip") {
        return await sendFile(res, args.packagePath, "application/zip");
      }
      if (req.method === "PUT" && route === "/public-key") {
        const body = await readSmallBody(req);
        if (!body.toString("utf8").includes("<RSAKeyValue>")) return sendText(res, 400, "Invalid RSA public key");
        await fs.writeFile(publicKeyPath, body, { mode: 0o600 });
        bundlePromise = createWindowsSecretBundle({
          publicKeyPath,
          outputPath: bundlePath,
          configPath: args.configPath,
          memberappsEnvPath: args.memberappsEnvPath
        });
        await bundlePromise;
        console.log("Encrypted credential bundle is ready.");
        return sendText(res, 200, "ok");
      }
      if (req.method === "GET" && route === "/secret-bundle") {
        if (bundlePromise) await bundlePromise;
        try {
          await fs.access(bundlePath);
        } catch {
          return sendText(res, 404, "Bundle not ready");
        }
        return await sendFile(res, bundlePath, "application/json");
      }
      if (req.method === "POST" && route === "/complete") {
        await readSmallBody(req, 1024);
        sendText(res, 200, "ok");
        console.log("Windows bootstrap reported completion.");
        setTimeout(() => server.close(), 1000);
        return;
      }
      return sendText(res, 404, "Not found");
    } catch (error) {
      console.error(`Transfer request failed: ${error.message}`);
      return sendText(res, 500, "Transfer request failed");
    }
  });

  server.listen(args.port, args.host, () => {
    const address = server.address();
    const port = typeof address === "object" ? address.port : args.port;
    console.log(`READY http://${args.advertiseHost}:${port}/${args.token}`);
  });

  const shutdown = () => server.close();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.on("close", async () => {
    await fs.rm(args.transferDir, { recursive: true, force: true });
    console.log("Transfer server closed and temporary encrypted files were removed.");
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
