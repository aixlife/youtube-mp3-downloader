import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getSecret, secretNames } from "../lib/secret-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function base64Url(base64) {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function xmlValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
  if (!match) throw new Error(`Windows public key is missing ${tag}.`);
  return match[1].replace(/\s+/g, "");
}

function publicKeyFromWindowsXml(xml) {
  return crypto.createPublicKey({
    key: {
      kty: "RSA",
      n: base64Url(xmlValue(xml, "Modulus")),
      e: base64Url(xmlValue(xml, "Exponent"))
    },
    format: "jwk"
  });
}

function parseEnvValue(text, name) {
  const line = text.split(/\r?\n/).find((entry) => entry.trim().startsWith(`${name}=`));
  if (!line) return null;
  let value = line.slice(line.indexOf("=") + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value || null;
}

export async function createWindowsSecretBundle({
  publicKeyPath,
  outputPath,
  configPath = path.join(rootDir, "config.windows.json"),
  memberappsEnvPath = path.resolve(rootDir, "..", "..", "memberapps", ".env.local")
}) {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const names = secretNames(config);
  const [oauthClient, oauthToken, storedDatabaseUrl] = await Promise.all([
    getSecret(config, names.oauthClient),
    getSecret(config, names.oauthToken),
    getSecret(config, names.databaseUrl)
  ]);
  let databaseUrl = storedDatabaseUrl;
  if (!databaseUrl) {
    const envText = await fs.readFile(memberappsEnvPath, "utf8");
    databaseUrl = parseEnvValue(envText, "DATABASE_URL");
  }
  if (!oauthClient || !oauthToken || !databaseUrl) {
    throw new Error("OAuth client, OAuth token, or database URL is unavailable for secure migration.");
  }
  JSON.parse(oauthClient);
  JSON.parse(oauthToken);
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error("DATABASE_URL is not a PostgreSQL URL.");

  const publicXml = await fs.readFile(publicKeyPath, "utf8");
  const publicKey = publicKeyFromWindowsXml(publicXml);
  const createdAt = new Date();
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 15 * 60 * 1000).toISOString(),
    secrets: [
      { service: names.oauthClient, value: oauthClient },
      { service: names.oauthToken, value: oauthToken },
      { service: names.databaseUrl, value: databaseUrl }
    ]
  }), "utf8");

  const keyMaterial = crypto.randomBytes(64);
  const aesKey = keyMaterial.subarray(0, 32);
  const hmacKey = keyMaterial.subarray(32, 64);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const macInput = Buffer.concat([Buffer.from("aimax-live-replay-v1", "utf8"), iv, ciphertext]);
  const hmac = crypto.createHmac("sha256", hmacKey).update(macInput).digest();
  const wrappedKey = crypto.publicEncrypt({
    key: publicKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha1"
  }, keyMaterial);

  const bundle = {
    version: 1,
    wrappedKey: wrappedKey.toString("base64"),
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    hmac: hmac.toString("base64")
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(bundle)}\n`, { mode: 0o600 });
  payload.fill(0);
  keyMaterial.fill(0);
  return outputPath;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--public-key") args.publicKeyPath = path.resolve(argv[++index]);
    else if (arg === "--out") args.outputPath = path.resolve(argv[++index]);
    else if (arg === "--config") args.configPath = path.resolve(argv[++index]);
    else if (arg === "--memberapps-env") args.memberappsEnvPath = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.publicKeyPath || !args.outputPath) throw new Error("--public-key and --out are required.");
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createWindowsSecretBundle(parseArgs(process.argv.slice(2)))
    .then(() => console.log("Encrypted Windows credential bundle created."))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
