const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const PLAUD_BIN = process.env.PLAUD_CLI_BIN || 'plaud';
const AVAILABILITY_TTL_MS = 5 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60 * 1000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 30 * 1000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const FILE_ID_RE = /^[a-f0-9]{32}$/i;

let availabilityCache = null;
let availabilityCheck = null;

function stripCliFormatting(value) {
  return String(value || '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n');
}

function shortCliError(err, command) {
  const stderr = stripCliFormatting(err && err.stderr)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => /^\u2717\s+\[[A-Z_]+\]/.test(line));

  if (stderr) return `PLAUD CLI ${command} failed: ${stderr}`;
  if (err && err.killed) return `PLAUD CLI ${command} timed out.`;
  if (err && err.code === 'ENOENT') return 'PLAUD CLI executable was not found.';
  return `PLAUD CLI ${command} failed.`;
}

function assertFileId(id) {
  if (!FILE_ID_RE.test(String(id || ''))) {
    throw new Error('PLAUD file id must be a 32-character hexadecimal string.');
  }
}

async function runPlaud(args, options = {}) {
  const command = args[0] || 'command';
  try {
    return await execFileAsync(PLAUD_BIN, args, {
      encoding: 'utf8',
      timeout: options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS,
      maxBuffer: options.maxBuffer || MAX_BUFFER_BYTES,
      windowsHide: true,
      env: process.env,
    });
  } catch (err) {
    const wrapped = new Error(shortCliError(err, command));
    wrapped.code = err && err.code;
    wrapped.signal = err && err.signal;
    throw wrapped;
  }
}

function availabilityCacheKey() {
  return `${PLAUD_BIN}\u0000${process.env.PATH || ''}`;
}

async function cliAvailable() {
  const key = availabilityCacheKey();
  const now = Date.now();
  if (availabilityCache && availabilityCache.key === key && availabilityCache.expiresAt > now) {
    return availabilityCache.value;
  }
  if (availabilityCheck && availabilityCheck.key === key) return availabilityCheck.promise;

  const promise = runPlaud(['me'], { timeoutMs: 20 * 1000 })
    .then(() => true)
    .catch(() => false)
    .then((value) => {
      availabilityCache = {
        key,
        value,
        expiresAt: Date.now() + AVAILABILITY_TTL_MS,
      };
      return value;
    })
    .finally(() => {
      if (availabilityCheck && availabilityCheck.promise === promise) availabilityCheck = null;
    });

  availabilityCheck = { key, promise };
  return promise;
}

function parseFilesOutput(output) {
  const clean = stripCliFormatting(output);
  const countMatch = clean.match(/Files on this page:\s*(\d+)/i);
  if (!countMatch) throw new Error('Could not parse PLAUD CLI files header.');

  const reportedCount = Number.parseInt(countMatch[1], 10);
  const files = [];
  for (const line of clean.split('\n')) {
    const row = line.match(/^\s*([a-f0-9]{32})\s{2,}(.*?)\s{2,}(\d{4}-\d{2}-\d{2}|-)\s{2,}(\S+)\s*$/i);
    if (!row) continue;
    files.push({
      id: row[1].toLowerCase(),
      name: row[2].trim(),
      date: row[3],
      duration: row[4],
    });
  }

  if (files.length !== reportedCount) {
    throw new Error(`Could not parse all PLAUD CLI file rows (${files.length}/${reportedCount}).`);
  }
  return files;
}

async function listFiles(page = 1, pageSize = 20) {
  const parsedPage = Number.parseInt(page, 10);
  const parsedPageSize = Number.parseInt(pageSize, 10);
  if (!Number.isInteger(parsedPage) || parsedPage < 1 || parsedPage > 1000) {
    throw new Error('PLAUD files page must be between 1 and 1000.');
  }
  if (!Number.isInteger(parsedPageSize) || parsedPageSize < 10 || parsedPageSize > 100) {
    throw new Error('PLAUD files page size must be between 10 and 100.');
  }

  const { stdout } = await runPlaud([
    'files',
    '-p', String(parsedPage),
    '-s', String(parsedPageSize),
  ]);
  return parseFilesOutput(stdout);
}

function parseFileMetaOutput(output) {
  const fields = {};
  const knownFields = new Set([
    'id',
    'name',
    'created_at',
    'start_at',
    'duration',
    'serial_number',
    'audio',
    'transcript',
    'summary',
  ]);

  for (const line of stripCliFormatting(output).split('\n')) {
    const match = line.match(/^\s*([a-z_]+)\s*:\s*(.*?)\s*$/i);
    if (!match || !knownFields.has(match[1])) continue;
    fields[match[1]] = match[2];
  }

  const required = ['id', 'name', 'created_at', 'duration', 'transcript', 'summary'];
  const missing = required.filter((field) => fields[field] === undefined);
  if (missing.length || !FILE_ID_RE.test(fields.id || '')) {
    throw new Error(`Could not parse PLAUD CLI file details${missing.length ? `: ${missing.join(', ')}` : ''}.`);
  }

  const availability = (value) => /^available$/i.test(String(value || '').trim());
  return {
    id: fields.id.toLowerCase(),
    name: fields.name,
    createdAt: fields.created_at === '-' ? null : fields.created_at,
    startAt: fields.start_at === '-' ? null : (fields.start_at || null),
    duration: fields.duration,
    serialNumber: fields.serial_number === '-' ? null : (fields.serial_number || null),
    audioAvailable: availability(fields.audio),
    transcriptAvailable: availability(fields.transcript),
    summaryAvailable: availability(fields.summary),
  };
}

async function getFileMeta(id) {
  assertFileId(id);
  const { stdout } = await runPlaud(['file', String(id)]);
  const meta = parseFileMetaOutput(stdout);
  if (meta.id !== String(id).toLowerCase()) {
    throw new Error('PLAUD CLI returned metadata for an unexpected file id.');
  }
  return meta;
}

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

function titlePrefix(value) {
  return normalizeTitle(value).slice(0, 32).toLowerCase();
}

function titlePrefixMatches(candidate, title) {
  const candidatePrefix = titlePrefix(candidate);
  const targetPrefix = titlePrefix(title);
  if (!candidatePrefix || !targetPrefix) return false;
  return candidatePrefix.startsWith(targetPrefix);
}

function isTruncatedName(name) {
  return /(?:\u2026|\.\.\.)$/.test(String(name || '').trim());
}

function latestEpochForCliDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  const value = new Date(`${date}T23:59:59.999`).getTime();
  return Number.isNaN(value) ? null : value;
}

async function findRecentByTitle(title, sinceEpochMs = 0) {
  const normalizedTitle = normalizeTitle(title);
  if (!normalizedTitle) throw new Error('PLAUD title is required.');
  const since = Number.isFinite(Number(sinceEpochMs)) ? Number(sinceEpochMs) : 0;

  for (let page = 1; page <= 3; page++) {
    const files = await listFiles(page, 100);
    for (const file of files) {
      const latestForDate = latestEpochForCliDate(file.date);
      if (since > 0 && latestForDate !== null && latestForDate < since) continue;
      if (!titlePrefixMatches(file.name, normalizedTitle)) continue;

      if (isTruncatedName(file.name) || since > 0) {
        const meta = await getFileMeta(file.id);
        if (!titlePrefixMatches(meta.name, normalizedTitle)) continue;
        if (since > 0) {
          const createdAt = new Date(meta.createdAt || '').getTime();
          if (Number.isNaN(createdAt)) throw new Error('Could not parse PLAUD file created_at timestamp.');
          if (createdAt < since) continue;
        }
        return { ...file, ...meta, name: meta.name };
      }

      return file;
    }
    if (files.length < 100) break;
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRecentByTitle(title, sinceEpochMs, options = {}) {
  const timeoutMs = options.timeoutMs || 30 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const file = await findRecentByTitle(title, sinceEpochMs);
    if (file) return file;

    const elapsedMs = Date.now() - startedAt;
    if (typeof options.onPoll === 'function') options.onPoll({ elapsedMs });
    const remainingMs = timeoutMs - elapsedMs;
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  throw new Error('PLAUD CLI file lookup timed out.');
}

async function waitForTranscriptReady(id, options = {}) {
  assertFileId(id);
  const timeoutMs = options.timeoutMs || 90 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const meta = await getFileMeta(id);
    if (meta.transcriptAvailable) return meta;

    const elapsedMs = Date.now() - startedAt;
    if (typeof options.onPoll === 'function') options.onPoll({ meta, elapsedMs });
    const remainingMs = timeoutMs - elapsedMs;
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  throw new Error('PLAUD CLI transcript readiness timed out.');
}

async function fetchArtifact(command, id, outPath) {
  assertFileId(id);
  if (!outPath || typeof outPath !== 'string') throw new Error('PLAUD output path is required.');

  const resolvedPath = path.resolve(outPath);
  const outputDir = path.dirname(resolvedPath);
  fs.mkdirSync(outputDir, { recursive: true });
  const tempPath = path.join(
    outputDir,
    `.plaud-cli-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.tmp`
  );

  try {
    await runPlaud([command, String(id), '-o', tempPath], {
      timeoutMs: DEFAULT_DOWNLOAD_TIMEOUT_MS,
    });
    const stat = fs.statSync(tempPath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error(`PLAUD CLI ${command} output is empty.`);
    }
    fs.renameSync(tempPath, resolvedPath);
    return resolvedPath;
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
    throw err;
  }
}

function fetchTranscript(id, outPath) {
  return fetchArtifact('transcript', id, outPath);
}

function fetchSummary(id, outPath) {
  return fetchArtifact('summary', id, outPath);
}

function selectPlaudRecoveryMode(available) {
  return available ? 'cli' : 'playwright';
}

function resetAvailabilityCache() {
  availabilityCache = null;
  availabilityCheck = null;
}

module.exports = {
  cliAvailable,
  listFiles,
  getFileMeta,
  fetchTranscript,
  fetchSummary,
  findRecentByTitle,
  waitForRecentByTitle,
  waitForTranscriptReady,
  selectPlaudRecoveryMode,
  __testing: {
    parseFilesOutput,
    parseFileMetaOutput,
    resetAvailabilityCache,
    titlePrefixMatches,
  },
};
