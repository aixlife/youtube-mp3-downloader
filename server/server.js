const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const plaudCli = require('./plaud/cli');
const { createPlaudExtensionUpload } = require('./plaud/extension-upload');
const { registerPlaudExtensionRoutes } = require('./routes/plaud-extension');
const { registerPlaudMeetingRoutes } = require('./routes/plaud-meeting');

const app = express();
const PORT = parseInt(process.env.PORT || '3456', 10);

app.use(cors());
app.use(express.json());

// In-memory job store
const jobs = new Map();

// Clean up old jobs every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if ((job.status === 'done' || job.status === 'error') && now - job.createdAt > 60 * 60 * 1000) {
      cleanupJobFiles(job);
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000);

function cleanupJobFiles(job) {
  if (job.keepFile) return;

  if (job.filePath) {
    const dir = path.dirname(job.filePath);
    const base = path.basename(job.filePath, path.extname(job.filePath));
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        if (f.startsWith(base)) {
          fs.unlink(path.join(dir, f), () => {});
        }
      }
    } catch {}
  }
  // Clean up split files
  if (job.files) {
    for (const f of job.files) {
      if (f.path && fs.existsSync(f.path)) {
        fs.unlink(f.path, () => {});
      }
    }
  }
}

function findOutputFile(basePath) {
  const dir = path.dirname(basePath);
  const base = path.basename(basePath, '.mp3');
  try {
    const files = fs.readdirSync(dir);
    const mp3File = files.find(f => f.startsWith(base) && f.endsWith('.mp3'));
    if (mp3File) return path.join(dir, mp3File);
  } catch {}
  return null;
}

// Chrome cookies for members-only / age-restricted videos
// Auto-detect browser for cookies (members-only / age-restricted videos)
function detectBrowser() {
  const homeDir = os.homedir();
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const isLinux = process.platform === 'linux';

  const browsers = [
    { name: 'brave', mac: 'BraveSoftware/Brave-Browser', win: 'BraveSoftware\\Brave-Browser', linux: 'BraveSoftware/Brave-Browser' },
    { name: 'chrome', mac: 'Google/Chrome', win: 'Google\\Chrome', linux: 'google-chrome' },
    { name: 'edge', mac: 'Microsoft Edge', win: 'Microsoft\\Edge', linux: 'microsoft-edge' },
    { name: 'opera', mac: 'com.operasoftware.Opera', win: 'Opera Software\\Opera Stable', linux: 'opera' },
    { name: 'firefox', mac: 'Firefox', win: 'Mozilla\\Firefox', linux: 'mozilla/firefox' },
  ];

  for (const b of browsers) {
    let checkPath;
    if (isMac) checkPath = path.join(homeDir, 'Library/Application Support', b.mac);
    else if (isWin) checkPath = path.join(process.env.LOCALAPPDATA || '', b.win);
    else if (isLinux) checkPath = path.join(homeDir, '.config', b.linux);
    // Verify actual browser profile exists (not just the app support folder)
    const profilePath = checkPath && path.join(checkPath, 'Default');
    if (profilePath && fs.existsSync(profilePath)) {
      console.log(`[cookies] Detected browser: ${b.name}`);
      return b.name;
    }
  }
  console.log('[cookies] No supported browser detected, cookies disabled');
  return null;
}

const DETECTED_BROWSER = detectBrowser();
const COOKIES_ARGS = DETECTED_BROWSER ? ['--cookies-from-browser', DETECTED_BROWSER] : [];

function stripCookieArgs(args) {
  const stripped = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--cookies-from-browser' || arg === '--cookies') {
      i++;
      continue;
    }
    if (arg.startsWith('--cookies-from-browser=') || arg.startsWith('--cookies=')) continue;
    stripped.push(arg);
  }
  return stripped;
}

function hasCookieArgs(args) {
  return stripCookieArgs(args).length !== args.length;
}

function shouldRetryYtDlpWithoutCookies(stderr) {
  const message = stderr || '';
  return /HTTP Error 403: Forbidden/i.test(message)
    || (/unable to download video data/i.test(message) && /(?:403|Forbidden)/i.test(message))
    || /Requested format is not available/i.test(message);
}

function runYtDlpWithCookieFallback(args, options = {}) {
  const {
    label = 'yt-dlp',
    onStdout,
    onStderr,
    onFallback,
  } = options;
  const attempts = [args];
  if (hasCookieArgs(args)) {
    const fallbackArgs = stripCookieArgs(args);
    if (fallbackArgs.length !== args.length) attempts.push(fallbackArgs);
  }

  return new Promise((resolve, reject) => {
    const runAttempt = (attemptIndex) => {
      const currentArgs = attempts[attemptIndex];
      const retryingWithoutCookies = attemptIndex > 0;
      console.log(`[${label}] yt-dlp ${currentArgs.join(' ')}`);
      if (retryingWithoutCookies) console.log(`[${label}] running without browser cookies`);

      const proc = spawn('yt-dlp', currentArgs);
      let stderr = '';

      proc.stdout.on('data', (d) => {
        if (onStdout) onStdout(d, { retryingWithoutCookies });
      });
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
        if (onStderr) onStderr(d, { retryingWithoutCookies });
      });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) return resolve({ retryingWithoutCookies });
        if (attemptIndex === 0 && attempts.length > 1 && shouldRetryYtDlpWithoutCookies(stderr)) {
          console.warn(`[${label}] yt-dlp got 403 with browser cookies; retrying without cookies`);
          if (onFallback) onFallback(stderr);
          runAttempt(attemptIndex + 1);
          return;
        }

        const error = new Error(stderr.slice(0, 300) || `yt-dlp exited with code ${code}`);
        error.stderr = stderr;
        error.code = code;
        reject(error);
      });
    };

    runAttempt(0);
  });
}

const PLAUD_QUEUE_DIR = process.env.PLAUD_QUEUE_DIR || path.join(os.homedir(), 'Movies', 'PlaudQueue');
const PLAUD_PROFILE_DIR = process.env.PLAUD_PROFILE_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'yt-mp3-plaud-uploader');
const PLAUD_MAX_SECONDS = parseInt(process.env.PLAUD_MAX_SECONDS || `${5 * 60 * 60}`, 10);
// 5시간을 넘으면 자동 분할한다. 파트 목표 길이는 한계에 안전 마진을 둔 4.5시간.
const PLAUD_PART_TARGET_SECONDS = parseInt(process.env.PLAUD_PART_TARGET_SECONDS || `${4.5 * 60 * 60}`, 10);
// PLAUD 업로드 용량 한계는 500MB. 경계에서 막히지 않게 480MB를 실사용 상한으로 잡는다.
const PLAUD_MAX_UPLOAD_BYTES = parseInt(process.env.PLAUD_MAX_UPLOAD_BYTES || `${480 * 1024 * 1024}`, 10);
// 용량 초과 시에만 쓰는 모노 재인코딩 비트레이트. 전사 품질에는 영향이 없다.
const PLAUD_COMPRESS_BITRATE_K = parseInt(process.env.PLAUD_COMPRESS_BITRATE_K || '64', 10);
const PLAUD_LOGIN_WAIT_MS = parseInt(process.env.PLAUD_LOGIN_WAIT_MS || `${2 * 60 * 1000}`, 10);
const PLAUD_POST_SELECT_WAIT_MS = parseInt(process.env.PLAUD_POST_SELECT_WAIT_MS || '15000', 10);
const PLAUD_IMPORT_TIMEOUT_MS = parseInt(process.env.PLAUD_IMPORT_TIMEOUT_MS || `${30 * 60 * 1000}`, 10);
const PLAUD_GENERATED_TIMEOUT_MS = parseInt(process.env.PLAUD_GENERATED_TIMEOUT_MS || `${90 * 60 * 1000}`, 10);
const PLAUD_DETAIL_CHECK_AFTER_MS = parseInt(process.env.PLAUD_DETAIL_CHECK_AFTER_MS || `${60 * 1000}`, 10);
const PLAUD_DETAIL_PROBE_INTERVAL_MS = parseInt(process.env.PLAUD_DETAIL_PROBE_INTERVAL_MS || '15000', 10);
const PLAUD_HEADLESS_LOGIN_WAIT_MS = parseInt(process.env.PLAUD_HEADLESS_LOGIN_WAIT_MS || '30000', 10);
const PLAUD_DOWNLOAD_DIR = process.env.PLAUD_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'PlaudTranscripts');
const PLAUD_HEADLESS = envFlag('PLAUD_HEADLESS', true);
const PLAUD_VISIBLE_ON_ERROR = envFlag('PLAUD_VISIBLE_ON_ERROR', true);
const PLAUD_FILE_ROW_SELECTOR = 'li.file-list-item, [data-testid^="file-list-item-"]';

let plaudContextPromise = null;
let plaudContextHeadless = null;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function safeFilename(title, fallback = 'audio') {
  return (title || fallback)
    .replace(/[^a-zA-Z0-9가-힣\s\-_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || fallback;
}

function uniqueFilePath(dir, filename) {
  ensureDir(dir);
  const ext = path.extname(filename) || '.mp3';
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, `${base}${ext}`);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} ${i}${ext}`);
    i++;
  }
  return candidate;
}

function fileTitleFromJob(job) {
  return job.plaudTitle || path.basename(job.filename || 'audio.mp3', path.extname(job.filename || '.mp3')).replace(/\s+\d+$/, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function humanElapsed(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (mins <= 0) return `${secs}초`;
  return `${mins}분 ${secs}초`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findChromiumExecutable() {
  if (process.env.PLAUD_BROWSER_PATH && fs.existsSync(process.env.PLAUD_BROWSER_PATH)) {
    return process.env.PLAUD_BROWSER_PATH;
  }

  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        path.join(os.homedir(), 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser'),
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      ]
    : process.platform === 'win32'
      ? [
          path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
          path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
          path.join(process.env.PROGRAMFILES || '', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/snap/bin/chromium',
        ];

  return candidates.find(Boolean) && candidates.find((p) => fs.existsSync(p));
}

async function resetPlaudContext() {
  const contextPromise = plaudContextPromise;
  plaudContextPromise = null;
  plaudContextHeadless = null;

  if (!contextPromise) return;
  const context = await contextPromise.catch(() => null);
  if (context) await context.close().catch(() => {});
}

async function getPlaudContext(options = {}) {
  const headless = options.headless ?? PLAUD_HEADLESS;
  if (options.forceNew) await resetPlaudContext();
  if (plaudContextPromise && plaudContextHeadless === headless) return plaudContextPromise;
  if (plaudContextPromise && plaudContextHeadless !== headless) await resetPlaudContext();

  plaudContextPromise = (async () => {
    let chromium;
    try {
      ({ chromium } = require('playwright-core'));
    } catch {
      throw new Error('playwright-core가 설치되어 있지 않습니다. server 폴더에서 npm install을 실행하세요.');
    }

    const executablePath = findChromiumExecutable();
    if (!executablePath) {
      throw new Error('Chrome/Brave/Edge 실행 파일을 찾지 못했습니다. PLAUD_BROWSER_PATH 환경변수로 브라우저 경로를 지정하세요.');
    }

    ensureDir(PLAUD_PROFILE_DIR);
    console.log(`[plaud] Launching browser in ${headless ? 'headless' : 'visible'} mode`);
    const context = await chromium.launchPersistentContext(PLAUD_PROFILE_DIR, {
      executablePath,
      headless,
      acceptDownloads: true,
      viewport: { width: 1280, height: 900 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-search-engine-choice-screen',
      ],
    });

    context.on('close', () => {
      plaudContextPromise = null;
      plaudContextHeadless = null;
    });

    return context;
  })();
  plaudContextHeadless = headless;

  return plaudContextPromise;
}

async function visibleCount(locator) {
  try {
    const count = await locator.count();
    let visible = 0;
    for (let i = 0; i < count; i++) {
      if (await locator.nth(i).isVisible().catch(() => false)) visible++;
    }
    return visible;
  } catch {
    return 0;
  }
}

async function clickVisible(locator) {
  const count = await locator.count();
  for (let i = 0; i < count; i++) {
    const item = locator.nth(i);
    if (await item.isVisible().catch(() => false)) {
      try {
        await item.click({ timeout: 5000 });
        return true;
      } catch {}
    }
  }
  return false;
}

async function findVisibleLocator(page, candidates, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const locator of candidates) {
      if (await visibleCount(locator)) return locator;
    }
    await page.waitForTimeout(1000);
  }

  return null;
}

async function getPlaudFileStatus(page, title) {
  const titleNeedle = title.normalize('NFC').slice(0, Math.min(32, title.length));
  return page.evaluate(({ needle, rowSelector }) => {
    const norm = (value) => (value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 60 && rect.height > 15 && style.display !== 'none' && style.visibility !== 'hidden';
    };

	    const listItems = Array.from(document.querySelectorAll(rowSelector))
	      .map((el) => {
	        if (!visible(el)) return null;
	        const text = norm(el.innerText || el.textContent);
	        const name = norm(el.querySelector('.file-list-item__filename')?.innerText || '');
	        if (!(name.includes(needle) || text.includes(needle))) return null;
	        const rect = el.getBoundingClientRect();
	        const duration = norm(el.querySelector('.file-list-item__duration-column')?.innerText || '');
	        const date = norm(el.querySelector('.file-list-item__date-column')?.innerText || '');
	        const generating = /Generating|Transcribing|Processing|Importing|생성\s*중|처리\s*중|전사\s*중|가져오는\s*중/i.test(text);
	        const explicitGenerated = /Generated|생성됨|전사|요약|노트|Transcript|Summary|Notes/i.test(text);
	        const hasDurationDate = Boolean(duration && date);
	        return {
	          text,
	          name,
	          duration,
	          date,
	          top: rect.top,
	          area: rect.width * rect.height,
	          generated: explicitGenerated,
	          explicitGenerated,
	          hasDurationDate,
	          generating,
	          hasStatus: hasDurationDate || /Generated|Generating|Transcribing|Processing|Importing/i.test(text),
	        };
	      })
      .filter(Boolean)
      .sort((a, b) => a.top - b.top);

    if (listItems[0]) return listItems[0];

	    const candidates = Array.from(document.querySelectorAll('div, li, tr, [role="listitem"], [class*="file"], [class*="item"]'))
	      .map((el) => {
	        if (!visible(el)) return null;
	        const text = norm(el.innerText);
	        if (!text.includes(needle)) return null;
	        if (/Import audio/i.test(text) && /Click or drag audio files/i.test(text)) return null;
	        const rect = el.getBoundingClientRect();
	        const generating = /Generating|Transcribing|Processing|Importing|생성\s*중|처리\s*중|전사\s*중|가져오는\s*중/i.test(text);
	        const explicitGenerated = /Generated|생성됨|전사|요약|노트|Transcript|Summary|Notes/i.test(text);
	        return {
	          text,
	          top: rect.top,
	          area: rect.width * rect.height,
	          generated: explicitGenerated,
	          explicitGenerated,
	          hasDurationDate: /(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})/.test(text) && /\d+\s*(?:h|m|s|시간|분|초)/i.test(text),
	          generating,
	          hasStatus: /Generated|생성됨|Generating|Transcribing|Processing|Importing|생성\s*중|처리\s*중|전사\s*중|\d{4}-\d{2}-\d{2}|\d+\s*(?:h|m|s|시간|분|초)/i.test(text),
	        };
	      })
      .filter(Boolean)
      .sort((a, b) => Number(b.hasStatus) - Number(a.hasStatus) || a.top - b.top || a.area - b.area);
    return candidates[0] || null;
  }, { needle: titleNeedle, rowSelector: PLAUD_FILE_ROW_SELECTOR });
}

async function getPlaudPageSignals(page) {
  return page.evaluate((rowSelector) => {
    const norm = (value) => (value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 20 && rect.height > 10 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    const text = norm(document.body.innerText || document.body.textContent || '');
    const rows = Array.from(document.querySelectorAll(rowSelector));
    const visibleRows = rows.filter(visible);
    const fileLikeCandidates = Array.from(document.querySelectorAll('li, div, tr, [role="listitem"], [data-testid], [class*="file"], [class*="list"], [class*="item"]'))
      .filter(visible)
      .map((el) => {
        const rawText = norm(el.innerText || el.textContent || '');
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          className: String(el.className && el.className.baseVal ? el.className.baseVal : el.className || '').slice(0, 140),
          testid: el.getAttribute('data-testid') || '',
          role: el.getAttribute('role') || '',
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          textLength: rawText.length,
          hasDate: /(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})/.test(rawText),
          hasDuration: /\d+\s*(?:h|m|s|시간|분|초)/i.test(rawText),
        };
      })
      .filter((item) => item.textLength && (item.hasDate || item.hasDuration || /file|list|item/i.test(`${item.className} ${item.testid} ${item.role}`)))
      .sort((a, b) => Number(b.hasDate && b.hasDuration) - Number(a.hasDate && a.hasDuration) || a.height - b.height)
      .slice(0, 12);
    return {
      url: location.href,
      rowCount: rows.length,
      visibleRowCount: visibleRows.length,
      textLength: text.length,
      dateLikeCount: (text.match(/(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})/g) || []).length,
      durationLikeCount: (text.match(/\d+\s*(?:h|m|s|시간|분|초)/gi) || []).length,
      fileLikeCandidates,
      hasLogin: /log\s*in|sign\s*in|continue with google|로그인|이메일로 계속|구글로 계속/i.test(text),
      hasAppShell: /오디오\s*추가|Add audio|모든\s*파일|All files|개인\s*워크스페이스|workspace/i.test(text),
      hasRecentFiles: /최근\s*파일|Recent files/i.test(text),
      hasAllFiles: /모든\s*파일|All files/i.test(text),
      hasNetworkError: /network|offline|try again|네트워크|다시 시도/i.test(text),
    };
  }, PLAUD_FILE_ROW_SELECTOR).catch((err) => ({ error: err.message }));
}

async function openPlaudAllFiles(page) {
  const allFiles = await findVisibleLocator(page, [
    page.locator('[data-testid="nav-sidebar-all-files-item"]'),
    page.getByText(/^모든\s*파일/),
    page.getByText(/^All files/i),
  ], 5000);

  if (!allFiles) return false;
  if (!await clickVisible(allFiles)) return false;
  await page.waitForTimeout(1000);
  return true;
}

async function listPlaudFiles(page, limit = 20, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  await page.goto('https://web.plaud.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await openPlaudAllFiles(page).catch(() => false);
  await Promise.race([
    page.locator(PLAUD_FILE_ROW_SELECTOR).first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => null),
    page.getByText(/Recent files/i).first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => null),
    page.getByText(/최근\s*파일/i).first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => null),
    page.getByText(/로그인|Sign in|Log in/i).first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => null),
    page.waitForTimeout(timeoutMs),
  ]);
  await page.waitForTimeout(1000);

  const items = await page.evaluate(({ maxItems, rowSelector }) => {
    const norm = (value) => (value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 60 && rect.height > 15 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    const items = Array.from(document.querySelectorAll(rowSelector))
      .map((el) => {
        if (!visible(el)) return null;
        const rect = el.getBoundingClientRect();
        const text = norm(el.innerText || el.textContent);
        const name = norm(el.querySelector('.file-list-item__filename')?.innerText || '');
        const duration = norm(el.querySelector('.file-list-item__duration-column')?.innerText || '');
        const date = norm(el.querySelector('.file-list-item__date-column')?.innerText || '');
        return {
          name: name || text.split('\n')[0] || '',
          duration,
          date,
          generating: /Generating|Transcribing|Processing|Importing|생성\s*중|처리\s*중|전사\s*중|가져오는\s*중/i.test(text),
          generated: /Generated|생성됨|Copy transcript|Export transcript|Transcript|Summary|Notes|전사|요약|노트/i.test(text),
          text,
          top: rect.top,
        };
      })
      .filter((item) => item && item.name)
      .sort((a, b) => a.top - b.top)
      .slice(0, maxItems)
      .map(({ top, ...item }) => item);

    return items;
  }, { maxItems: limit, rowSelector: PLAUD_FILE_ROW_SELECTOR });

  if (items.length) return items;

  const signals = await getPlaudPageSignals(page);
  if (signals.hasLogin && !signals.hasAppShell) {
    throw new Error('PLAUD 로그인이 필요합니다. /meeting/plaud/login을 열어 회의끝용 PLAUD 브라우저에서 로그인하세요.');
  }
  if (signals.hasNetworkError) {
    throw new Error('PLAUD 목록을 읽는 중 네트워크 오류가 보입니다. 잠시 후 다시 시도하세요.');
  }

  return items;
}

async function waitForPlaudListReady(page, title, options = {}) {
  const timeoutMs = options.timeoutMs ?? 12000;
  const titleNeedle = title.slice(0, Math.min(24, title.length));
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2000);
  await Promise.race([
    page.getByText(new RegExp(escapeRegExp(titleNeedle))).first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => null),
    page.getByText(/Recent files/i).first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => null),
    page.getByText(/최근\s*파일/i).first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => null),
    page.locator(PLAUD_FILE_ROW_SELECTOR).first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => null),
    page.waitForTimeout(timeoutMs),
  ]);
  await page.waitForTimeout(1000);
}

async function waitForPlaudGenerated(page, job, options = {}) {
  const title = fileTitleFromJob(job);
  const startedAt = Date.now();
  const detailCheckAfterMs = options.detailCheckAfterMs ?? PLAUD_DETAIL_CHECK_AFTER_MS;
  let checks = 0;
  let sawGenerating = false;

  await page.goto('https://web.plaud.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await openPlaudAllFiles(page).catch(() => false);
  await waitForPlaudListReady(page, title);

  while (Date.now() - startedAt < PLAUD_GENERATED_TIMEOUT_MS) {
    const status = await getPlaudFileStatus(page, title).catch(() => null);
    const elapsed = humanElapsed(Date.now() - startedAt);

	    if (status && status.generated) {
	      job.progress = 95;
	      job.phase = 'PLAUD Generated 완료 확인!';
	      return true;
	    }

	    if (status && status.generating) {
	      sawGenerating = true;
	    }

	    if (status && sawGenerating && !status.generating && status.hasDurationDate) {
	      job.progress = 95;
	      job.phase = 'PLAUD Generating 종료 확인!';
	      return true;
	    }

	    if (status && Date.now() - startedAt > detailCheckAfterMs) {
	      job.progress = 94;
	      job.phase = status.generating
	        ? 'PLAUD 목록은 Generating이지만 상세 화면에서 transcript export 가능 여부를 확인합니다.'
	        : 'PLAUD 목록 대신 상세 화면에서 transcript export 가능 여부를 확인합니다.';
	      return false;
	    }

    job.progress = 92;
    job.phase = status
	      ? `PLAUD Generated 대기 중... (${elapsed})`
	      : `PLAUD 파일 목록 반영 대기 중... (${elapsed})`;

    await page.waitForTimeout(15000);
    checks++;
    if (checks % 4 === 0) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await waitForPlaudListReady(page, title);
    }
  }

  throw new Error(`PLAUD Generated 대기 시간이 초과되었습니다. (${humanElapsed(PLAUD_GENERATED_TIMEOUT_MS)})`);
}

async function clickPlaudFileRow(page, title) {
  const titleNeedle = title.normalize('NFC').slice(0, Math.min(32, title.length));
  const clicked = await page.evaluate(({ needle, rowSelector }) => {
    const norm = (value) => (value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 60 && rect.height > 15 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const listItems = Array.from(document.querySelectorAll(rowSelector))
      .map((el) => {
        if (!visible(el)) return null;
        const text = norm(el.innerText || el.textContent);
        const name = norm(el.querySelector('.file-list-item__filename')?.innerText || '');
        const rect = el.getBoundingClientRect();
        return { el, text, name, top: rect.top };
      })
      .filter(Boolean)
      .sort((a, b) => a.top - b.top);

    const targetItem = listItems.find((item) => item.name.includes(needle) || item.text.includes(needle));

    if (targetItem) {
      targetItem.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    }

    const candidates = Array.from(document.querySelectorAll('div, li, tr, [role="listitem"], [class*="file"], [class*="item"]'))
      .map((el) => {
        if (!visible(el)) return null;
        const text = norm(el.innerText);
        if (!text.includes(needle)) return null;
        if (/Import audio/i.test(text) && /Click or drag audio files/i.test(text)) return null;
        const rect = el.getBoundingClientRect();
        return { el, top: rect.top, area: rect.width * rect.height };
      })
      .filter(Boolean)
      .sort((a, b) => a.top - b.top || a.area - b.area);
    const target = candidates[0] && candidates[0].el;
    if (!target) return false;
		    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
		    return true;
		  }, { needle: titleNeedle, rowSelector: PLAUD_FILE_ROW_SELECTOR });

  if (!clicked) {
    const fallback = page.getByText(new RegExp(escapeRegExp(title.slice(0, Math.min(24, title.length)))));
    if (!await clickVisible(fallback)) throw new Error('PLAUD 파일 목록에서 업로드한 파일을 클릭하지 못했습니다.');
  }

  await page.waitForURL(/\/file\//, { timeout: 60000 }).catch(() => {});
}

async function waitForDetailReady(page, job) {
  job.progress = 96;
  job.phase = 'PLAUD 상세 화면 준비 대기 중...';
  await page.locator('.file-detail-page, [data-page-rendered="true"]').first().waitFor({ state: 'visible', timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(2000);
}

async function getPlaudDetailStatus(page) {
  return page.evaluate(() => {
    const norm = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const text = norm(document.body.innerText || document.body.textContent || '');
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'))
      .filter(visible)
      .map((el) => ({ el, text: norm(el.innerText || el.textContent) }))
      .filter(({ text }) => text);
    const generateButtons = buttons.filter(({ text }) =>
      /^(Generate|Start generating|Generate transcript|Generate summary|생성|생성하기)$/i.test(text) ||
      (/generate/i.test(text) && !/generated|generating|regenerate/i.test(text))
    );

    return {
      generating: /Generating|Transcribing|Processing|Summarizing/i.test(text),
      generateVisible: generateButtons.length > 0,
      generatedHints: /Copy transcript|Export transcript|Transcript|Summary|Notes|Mind map/i.test(text),
    };
  }).catch(() => ({ generating: false, generateVisible: false, generatedHints: false }));
}

async function clickPlaudGenerateButton(page) {
  const clicked = await page.evaluate(() => {
    const norm = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const scoreNode = (el, text) => {
      const rect = el.getBoundingClientRect();
      const exact = /^(Generate|Start generating|Generate transcript|Generate summary|생성|생성하기)$/i.test(text) ? 0 : 100;
      const semantic = /button/i.test(el.tagName) || el.getAttribute('role') === 'button' ? 0 : 20;
      return exact + semantic + rect.top / 10000;
    };
    const target = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'))
      .filter(visible)
      .map((el) => ({ el, text: norm(el.innerText || el.textContent) }))
      .filter(({ text }) =>
        /^(Generate|Start generating|Generate transcript|Generate summary|생성|생성하기)$/i.test(text) ||
        (/generate/i.test(text) && !/generated|generating|regenerate/i.test(text))
      )
      .sort((a, b) => scoreNode(a.el, a.text) - scoreNode(b.el, b.text))[0];
    if (!target) return false;
    target.el.scrollIntoView({ block: 'center', inline: 'center' });
    target.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }).catch(() => false);

  if (clicked) await page.waitForTimeout(1500);
  return clicked;
}

async function ensurePlaudDetailGenerated(page, job) {
  const startedAt = Date.now();
  let lastGenerateClickAt = 0;

  while (Date.now() - startedAt < PLAUD_GENERATED_TIMEOUT_MS) {
    const status = await getPlaudDetailStatus(page);
    const elapsed = humanElapsed(Date.now() - startedAt);

    if (status.generating) {
      job.progress = 95;
      job.phase = `PLAUD 상세 화면에서 Generating 대기 중... (${elapsed})`;
    } else if (status.generateVisible && Date.now() - lastGenerateClickAt > 30000) {
      job.progress = 95;
      job.phase = 'PLAUD 상세 화면의 Generate 버튼 클릭 중...';
      if (await clickPlaudGenerateButton(page)) {
        lastGenerateClickAt = Date.now();
      }
    } else if (!status.generateVisible) {
      job.progress = 96;
      job.phase = 'PLAUD 상세 화면 생성 상태 확인 완료.';
      return;
    }

    await page.waitForTimeout(5000);
  }

  throw new Error(`PLAUD 상세 화면 Generated 대기 시간이 초과되었습니다. (${humanElapsed(PLAUD_GENERATED_TIMEOUT_MS)})`);
}

async function clickMemberExportButton(page) {
  const clickOnce = () => page.evaluate(() => {
    const getHref = (use) =>
      use.getAttribute('href') ||
      use.getAttribute('xlink:href') ||
      use.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    const use = Array.from(document.querySelectorAll('use'))
      .find((node) => getHref(node) === '#svg-icon_member_export');
    if (!use) return false;
    const svg = use.closest('svg');
    const target = svg && svg.closest('[role="button"], button, [data-testid], .cursor-pointer, span, div');
    if (!target) return false;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  });

  // 상세 패널이 늦게 그려지는 머신에서는 한 번만 찾고 포기하면 무조건 실패한다.
  // 아이콘이 나타날 때까지 폴링한다.
  const deadline = Date.now() + PLAUD_EXPORT_MENU_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await clickOnce()) return;
    await page.waitForTimeout(500);
  }

  const fallback = page.locator('[data-testid="share-button"], .file-action-trigger').first();
  if (!await clickVisible(fallback)) throw new Error('PLAUD Export 메뉴 버튼을 찾지 못했습니다.');
}

function transcriptExportCandidates(page) {
  // 2026-08 기준 실제 라벨은 '전사록 내보내기'(아이콘 #svg-icon_transcript).
  // 같은 메뉴의 '녹음 내보내기'는 오디오 파일이므로 절대 매칭시키지 않는다.
  // '기록 내보내기'는 구버전 표기라 폴백으로만 둔다.
  return [
    page.locator('div:has(> div > div > svg use[xlink\\:href="#svg-icon_transcript"])').last(),
    page.getByText(/^전사록\s*내보내기$/),
    page.getByText(/^기록\s*내보내기$/),
    page.getByText(/^Export transcript$/i),
    page.locator('[role="menuitem"]').filter({ hasText: /전사록\s*내보내기/ }),
    page.locator('[role="menuitem"]').filter({ hasText: /기록\s*내보내기/ }),
    page.locator('[role="menuitem"]').filter({ hasText: /Export transcript/i }),
    page.locator('li, div').filter({ hasText: /^전사록\s*내보내기$/ }),
    page.locator('li, div').filter({ hasText: /^기록\s*내보내기$/ }),
    page.locator('li, div').filter({ hasText: /^Export transcript$/i }),
  ];
}

function noteExportCandidates(page) {
  return [
    page.getByText(/^노트\s*내보내기$/),
    page.getByText(/^Export notes?$/i),
    page.getByText(/^Export note$/i),
    page.locator('[role="menuitem"]').filter({ hasText: /노트\s*내보내기/ }),
    page.locator('[role="menuitem"]').filter({ hasText: /Export notes?/i }),
    page.locator('li, div').filter({ hasText: /^노트\s*내보내기$/ }),
    page.locator('li, div').filter({ hasText: /^Export notes?$/i }),
  ];
}

async function closePlaudMenu(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(250).catch(() => delay(250));
}

function plaudExportKindLabel(kind) {
  return kind === 'note' ? 'note' : 'transcript';
}

function plaudExportMenuCandidates(page, kind) {
  return kind === 'note' ? noteExportCandidates(page) : transcriptExportCandidates(page);
}

// 느린 머신에서는 메뉴 렌더가 15초를 넘긴다(윈도우 24시간 PC 실측).
const PLAUD_EXPORT_MENU_TIMEOUT_MS = parseInt(process.env.PLAUD_EXPORT_MENU_TIMEOUT_MS || '15000', 10);

async function findPlaudExportMenuItem(page, kind = 'transcript', timeoutMs = PLAUD_EXPORT_MENU_TIMEOUT_MS) {
  return findVisibleLocator(page, plaudExportMenuCandidates(page, kind), timeoutMs);
}

async function openPlaudExportMenuItem(page, kind = 'transcript', timeoutMs = 3000) {
  await closePlaudMenu(page);
  await clickMemberExportButton(page);
  await page.waitForTimeout(300);
  return findPlaudExportMenuItem(page, kind, timeoutMs);
}

async function waitForPlaudExportAvailable(page, job, options = {}) {
  const startedAt = Date.now();
  let lastGenerateClickAt = 0;
  let checks = 0;
  const allowGenerate = Boolean(options.allowGenerate);
  const kind = options.kind || 'transcript';
  const label = plaudExportKindLabel(kind);

  while (Date.now() - startedAt < PLAUD_GENERATED_TIMEOUT_MS) {
    const elapsed = humanElapsed(Date.now() - startedAt);
    const status = await getPlaudDetailStatus(page);

    if (status.generateVisible && allowGenerate && Date.now() - lastGenerateClickAt > 30000) {
      job.progress = 95;
      job.phase = 'PLAUD 상세 화면의 Generate 버튼 클릭 중...';
      if (await clickPlaudGenerateButton(page)) lastGenerateClickAt = Date.now();
    } else if (status.generateVisible && !allowGenerate) {
      job.progress = 96;
      job.phase = 'PLAUD Generate 버튼이 보여 export를 중단했습니다. 크레딧/비용 가능성이 있어 사용자 승인이 필요합니다.';
      throw new Error('PLAUD transcript/summary가 아직 생성되지 않았습니다. Generate 버튼은 자동으로 누르지 않습니다.');
    }

    job.progress = 96;
    job.phase = status.generating
      ? `PLAUD 상세 화면에서 ${label} export 대기 중... (${elapsed})`
      : `PLAUD ${label} export 가능 여부 확인 중... (${elapsed})`;

    const exportItem = await openPlaudExportMenuItem(page, kind, 3000).catch(() => null);
    if (exportItem) return exportItem;

    await closePlaudMenu(page);
    await page.waitForTimeout(PLAUD_DETAIL_PROBE_INTERVAL_MS);
    checks++;
    if (checks % 8 === 0) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await waitForDetailReady(page, job);
    }
  }

  throw new Error(`PLAUD ${label} export 대기 시간이 초과되었습니다. (${humanElapsed(PLAUD_GENERATED_TIMEOUT_MS)})`);
}

async function waitForTranscriptExportAvailable(page, job, options = {}) {
  return waitForPlaudExportAvailable(page, job, { ...options, kind: 'transcript' });
}

async function disableExportTimestamps(page) {
  const target = await page.evaluate(() => {
    const norm = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    const label = Array.from(document.querySelectorAll('div, span, label, p'))
      .filter(visible)
      .find((el) => norm(el.textContent) === 'Include timestamps');
    if (!label) return null;

    const labelRect = label.getBoundingClientRect();
    const labelY = labelRect.top + labelRect.height / 2;
    const row = Array.from(document.querySelectorAll('div, label, section, li'))
      .filter(visible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), text: norm(el.innerText || el.textContent) }))
      .filter(({ rect, text }) =>
        text.includes('Include timestamps') &&
        rect.width > 260 &&
        rect.width < 900 &&
        rect.height >= 30 &&
        rect.height < 120 &&
        labelY >= rect.top - 2 &&
        labelY <= rect.bottom + 2
      )
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0]?.el ||
      label.parentElement;

    const rowRect = row.getBoundingClientRect();
    const y = labelRect.top + labelRect.height / 2;
    const x = Math.min(rowRect.right - 22, window.innerWidth - 20);
    const pointTarget = document.elementFromPoint(x, y);
    const checkboxRoot = pointTarget && pointTarget.closest('input[type="checkbox"], [role="checkbox"], .el-checkbox, .el-checkbox__input, button, div, span');
    const input = row.querySelector('input[type="checkbox"]');
    const ariaChecked = checkboxRoot && checkboxRoot.getAttribute && checkboxRoot.getAttribute('aria-checked');
    const className = checkboxRoot
      ? String(checkboxRoot.className && checkboxRoot.className.baseVal ? checkboxRoot.className.baseVal : checkboxRoot.className || '')
      : '';
    const checked = input
      ? input.checked
      : ariaChecked === 'false'
        ? false
        : ariaChecked === 'true' || /\bis-checked\b|\bchecked\b/.test(className) || true;

    return { x, y, checked };
  }).catch(() => null);

  if (!target) return false;
  if (target.checked === false) return true;

  await page.mouse.click(target.x, target.y).catch(() => null);
  await page.waitForTimeout(300);
  return true;
}

async function disableExportTimestampsLegacy(page) {
  return page.evaluate(() => {
    const norm = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    const label = Array.from(document.querySelectorAll('div, span, label, p'))
      .filter(visible)
      .find((el) => norm(el.textContent) === 'Include timestamps');
    if (!label) return false;

    let row = label;
    for (let i = 0; i < 6 && row && row.parentElement; i++) {
      const text = norm(row.innerText || row.textContent);
      if (text.includes('Include timestamps')) {
        const checkbox =
          row.querySelector('input[type="checkbox"]') ||
          row.querySelector('[role="checkbox"]') ||
          row.querySelector('.el-checkbox__input') ||
          row.querySelector('.el-checkbox') ||
          row.querySelector('svg, img');
        if (checkbox && visible(checkbox)) {
          const input = checkbox.matches && checkbox.matches('input[type="checkbox"]')
            ? checkbox
            : row.querySelector('input[type="checkbox"]');
          const className = String(checkbox.className && checkbox.className.baseVal ? checkbox.className.baseVal : checkbox.className || '');
          const ariaChecked = checkbox.getAttribute && checkbox.getAttribute('aria-checked');
          const checked = input
            ? input.checked
            : ariaChecked === 'true' || /\bis-checked\b|\bchecked\b/.test(className);
          if (checked || !input) {
            checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          }
          return true;
        }
      }
      row = row.parentElement;
    }

    const labelRect = label.getBoundingClientRect();
    const labelY = labelRect.top + labelRect.height / 2;
    const target = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"], .el-checkbox, .el-checkbox__input, svg, img, div, span'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { el, rect, dy: Math.abs((rect.top + rect.height / 2) - labelY) };
      })
      .filter(({ rect, dy }) => rect.left > labelRect.right && dy < 30)
      .sort((a, b) => a.dy - b.dy)[0];
    if (!target) return false;
    target.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }).catch(() => false);
}

function plaudDownloadDirs() {
  return Array.from(new Set([
    PLAUD_DOWNLOAD_DIR,
    path.join(os.homedir(), 'Downloads'),
  ]));
}

function snapshotDownloadFiles(dirs = plaudDownloadDirs()) {
  const snapshot = new Map();
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const filePath = path.join(dir, entry.name);
        const stat = fs.statSync(filePath);
        snapshot.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs });
      }
    } catch {}
  }
  return snapshot;
}

function isPartialDownload(filePath) {
  return /\.(crdownload|download|part|tmp)$/i.test(filePath);
}

async function waitForStableFile(filePath, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let stableChecks = 0;

  while (Date.now() < deadline) {
    try {
      if (!isPartialDownload(filePath) && fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.size > 0 && stat.size === lastSize) {
          stableChecks++;
          if (stableChecks >= 2) return true;
        } else {
          stableChecks = 0;
          lastSize = stat.size;
        }
      }
    } catch {}
    await delay(1000);
  }

  return false;
}

function findNewPlaudExportDownload(snapshot, sinceMs, title, kind = 'transcript') {
  const titleNeedle = safeFilename(title).normalize('NFC').toLowerCase().slice(0, 20);
  const candidates = [];
  const isNote = kind === 'note';

  for (const dir of plaudDownloadDirs()) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const filePath = path.join(dir, entry.name);
        if (isPartialDownload(filePath)) continue;

        const ext = path.extname(entry.name).toLowerCase();
        if (!['.txt', '.md', '.docx', '.pdf', '.srt', '.vtt'].includes(ext)) continue;

        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < sinceMs - 5000) continue;

        const previous = snapshot.get(filePath);
        if (previous && previous.size === stat.size && Math.abs(previous.mtimeMs - stat.mtimeMs) < 1000) continue;

        const lowerName = entry.name.normalize('NFC').toLowerCase();
        let score = stat.mtimeMs;
        if (titleNeedle && lowerName.includes(titleNeedle)) score += 1_000_000_000_000;
        if (isNote && /note|notes|summary|요약|노트/i.test(lowerName)) score += 100_000_000_000;
        if (!isNote && /transcript|plaud|스크립트|기록|자막/i.test(lowerName)) score += 100_000_000_000;
        if (ext === '.txt' || ext === '.md') score += 10_000_000_000;
        candidates.push({ filePath, score });
      }
    } catch {}
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] && candidates[0].filePath;
}

function findNewTranscriptDownload(snapshot, sinceMs, title) {
  return findNewPlaudExportDownload(snapshot, sinceMs, title, 'transcript');
}

function waitForAnyDownload(page, timeoutMs) {
  const context = page.context();
  const watchPage = (p) => p.waitForEvent('download', { timeout: timeoutMs }).catch(() => null);
  const watchers = context.pages().map(watchPage);
  watchers.push(
    context.waitForEvent('page', { timeout: timeoutMs })
      .then((newPage) => watchPage(newPage))
      .catch(() => null)
  );

  return new Promise((resolve) => {
    let settled = false;
    const finish = (download) => {
      if (settled || !download) return;
      settled = true;
      resolve(download);
    };

    for (const watcher of watchers) watcher.then(finish).catch(() => {});
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);
  });
}

async function savePlaudDownload(download, title) {
  const suggested = download.suggestedFilename() || `${safeFilename(title)}.txt`;
  const ext = path.extname(suggested) || '.txt';
  const base = safeFilename(path.basename(suggested, ext), title);
  const downloadPath = uniqueFilePath(PLAUD_DOWNLOAD_DIR, `${base}${ext}`);
  await download.saveAs(downloadPath);
  await waitForStableFile(downloadPath, 10000);
  return downloadPath;
}

function copyDetectedPlaudExportFile(filePath, title, kind = 'transcript') {
  if (path.dirname(filePath) === PLAUD_DOWNLOAD_DIR) return filePath;

  const ext = path.extname(filePath) || '.txt';
  const suffix = kind === 'note' ? 'note' : 'transcript';
  const base = safeFilename(path.basename(filePath, ext), `${title}-${suffix}`);
  const targetPath = uniqueFilePath(PLAUD_DOWNLOAD_DIR, `${base}${ext}`);
  fs.copyFileSync(filePath, targetPath);
  return targetPath;
}

function copyDetectedTranscriptFile(filePath, title) {
  return copyDetectedPlaudExportFile(filePath, title, 'transcript');
}

async function waitForPlaudExportDownload(page, downloadPromise, beforeSnapshot, startedAt, title, job, options = {}) {
  const timeoutMs = options.timeoutMs || 180000;
  const kind = options.kind || 'transcript';
  const label = plaudExportKindLabel(kind);
  let eventDownload = null;
  downloadPromise.then((download) => {
    eventDownload = download;
  }).catch(() => {});

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (eventDownload) {
      job.phase = `${label} 다운로드 이벤트 확인, 저장 중...`;
      return savePlaudDownload(eventDownload, title);
    }

    const detectedFile = findNewPlaudExportDownload(beforeSnapshot, startedAt, title, kind);
    if (detectedFile && await waitForStableFile(detectedFile, 15000)) {
      job.phase = '브라우저 다운로드 파일 확인, 저장 중...';
      return copyDetectedPlaudExportFile(detectedFile, title, kind);
    }

    await page.waitForTimeout(1000).catch(() => delay(1000));
  }

  throw new Error(`${label} 다운로드가 시작되지 않았습니다. PLAUD export 팝업에서 Export 클릭이 실패했거나 브라우저 다운로드가 차단되었을 수 있습니다.`);
}

async function waitForPlaudTranscriptDownload(page, downloadPromise, beforeSnapshot, startedAt, title, job, timeoutMs = 180000) {
  return waitForPlaudExportDownload(page, downloadPromise, beforeSnapshot, startedAt, title, job, {
    kind: 'transcript',
    timeoutMs,
  });
}

async function clickTranscriptExportConfirm(page) {
  const clicked = await page.evaluate(() => {
    const norm = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .el-dialog, [class*="dialog"], [class*="modal"]'))
      .filter((el) => visible(el) && /(Export transcript|Transcript export|기록\s*내보내기|전사본?\s*내보내기|전사\s*내보내기|트랜스크립트)/i.test(el.innerText || el.textContent || ''));
    const root = dialogs[0] || document.body;
    const target = Array.from(root.querySelectorAll('button, [role="button"], div, span'))
      .filter(visible)
      .map((el) => ({ el, text: norm(el.innerText || el.textContent) }))
      .filter(({ text }) => /^(Export|내보내기)$/i.test(text))
      .sort((a, b) => {
        const ar = a.el.getBoundingClientRect();
        const br = b.el.getBoundingClientRect();
        return (a.el.tagName === 'BUTTON' ? 0 : 1) - (b.el.tagName === 'BUTTON' ? 0 : 1) || br.top - ar.top;
      })[0];
    if (!target) return false;
    target.el.scrollIntoView({ block: 'center', inline: 'center' });
    target.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }).catch(() => false);

  if (clicked) return true;

  const exportButton = await findVisibleLocator(page, [
    page.getByRole('button', { name: /^(Export|내보내기)$/i }),
    page.locator('button').filter({ hasText: /^(Export|내보내기)$/i }),
    page.locator('[role="button"]').filter({ hasText: /^(Export|내보내기)$/i }),
  ], 15000);

  return Boolean(exportButton && await clickVisible(exportButton));
}

async function clickNoteExportConfirm(page) {
  const clicked = await page.evaluate(() => {
    const norm = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .el-dialog, [class*="dialog"], [class*="modal"]'))
      .filter((el) => visible(el) && /(Export note|Export notes|Note export|Summary export|노트\s*내보내기|요약\s*내보내기|요약|노트)/i.test(el.innerText || el.textContent || ''));
    const root = dialogs[0] || document.body;
    const target = Array.from(root.querySelectorAll('button, [role="button"], div, span'))
      .filter(visible)
      .map((el) => ({ el, text: norm(el.innerText || el.textContent) }))
      .filter(({ text }) => /^(Export|내보내기)$/i.test(text))
      .sort((a, b) => {
        const ar = a.el.getBoundingClientRect();
        const br = b.el.getBoundingClientRect();
        return (a.el.tagName === 'BUTTON' ? 0 : 1) - (b.el.tagName === 'BUTTON' ? 0 : 1) || br.top - ar.top;
      })[0];
    if (!target) return false;
    target.el.scrollIntoView({ block: 'center', inline: 'center' });
    target.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }).catch(() => false);

  if (clicked) return true;

  const exportButton = await findVisibleLocator(page, [
    page.getByRole('button', { name: /^(Export|내보내기)$/i }),
    page.locator('button').filter({ hasText: /^(Export|내보내기)$/i }),
    page.locator('[role="button"]').filter({ hasText: /^(Export|내보내기)$/i }),
  ], 15000);

  return Boolean(exportButton && await clickVisible(exportButton));
}

async function exportPlaudTranscript(page, job, options = {}) {
  const title = fileTitleFromJob(job);
  ensureDir(PLAUD_DOWNLOAD_DIR);

  job.status = 'exporting';
  job.progress = 96;
  job.phase = 'PLAUD 상세 파일 여는 중...';

  await clickPlaudFileRow(page, title);
  await waitForDetailReady(page, job);
  let exportItem = null;
  if (options.verifyDetailGenerated) {
    exportItem = await waitForTranscriptExportAvailable(page, job, { allowGenerate: options.allowGenerate });
  }

  job.progress = 97;
  job.phase = 'Export transcript 메뉴 여는 중...';
  if (!exportItem) exportItem = await openPlaudExportMenuItem(page, 'transcript', 15000);

  if (!exportItem) throw new Error('Export transcript 메뉴 항목을 찾지 못했습니다.');

  const downloadStartedAt = Date.now();
  const beforeSnapshot = snapshotDownloadFiles();
  const downloadPromise = waitForAnyDownload(page, 180000);
  if (!await clickVisible(exportItem)) throw new Error('Export transcript 메뉴 항목을 클릭하지 못했습니다.');

  job.progress = 98;
  job.phase = 'Transcript export 옵션 확인 중...';

  let downloadPath = await waitForPlaudTranscriptDownload(
    page,
    downloadPromise,
    beforeSnapshot,
    downloadStartedAt,
    title,
    job,
    5000
  ).catch(() => null);

  if (!downloadPath) {
    if (!await disableExportTimestamps(page)) {
      await disableExportTimestampsLegacy(page);
    }
    await page.waitForTimeout(300);

    job.phase = 'Transcript export 확인 버튼 클릭 중...';
    if (!await clickTranscriptExportConfirm(page)) throw new Error('Transcript export 확인 버튼을 클릭하지 못했습니다.');
    downloadPath = await waitForPlaudTranscriptDownload(
      page,
      downloadPromise,
      beforeSnapshot,
      downloadStartedAt,
      title,
      job,
      180000
    );
  }

  job.downloadPath = downloadPath;
  return downloadPath;
}

async function exportPlaudNote(page, job, options = {}) {
  const title = fileTitleFromJob(job);
  ensureDir(PLAUD_DOWNLOAD_DIR);

  job.status = 'exporting';
  job.progress = 96;
  job.phase = 'PLAUD 상세 파일 여는 중...';

  if (!options.detailAlreadyOpen) {
    await clickPlaudFileRow(page, title);
    await waitForDetailReady(page, job);
  }

  let exportItem = null;
  if (options.verifyDetailGenerated) {
    exportItem = await waitForPlaudExportAvailable(page, job, {
      allowGenerate: options.allowGenerate,
      kind: 'note',
    });
  }

  job.progress = 97;
  job.phase = '노트 내보내기 메뉴 여는 중...';
  if (!exportItem) exportItem = await openPlaudExportMenuItem(page, 'note', 15000);

  if (!exportItem) throw new Error('노트 내보내기 메뉴 항목을 찾지 못했습니다.');

  const downloadStartedAt = Date.now();
  const beforeSnapshot = snapshotDownloadFiles();
  const downloadPromise = waitForAnyDownload(page, 180000);
  if (!await clickVisible(exportItem)) throw new Error('노트 내보내기 메뉴 항목을 클릭하지 못했습니다.');

  job.progress = 98;
  job.phase = '노트 export 확인 중...';

  let notePath = await waitForPlaudExportDownload(
    page,
    downloadPromise,
    beforeSnapshot,
    downloadStartedAt,
    title,
    job,
    { kind: 'note', timeoutMs: 5000 }
  ).catch(() => null);

  if (!notePath) {
    job.phase = '노트 export 확인 버튼 클릭 중...';
    if (!await clickNoteExportConfirm(page)) throw new Error('노트 export 확인 버튼을 클릭하지 못했습니다.');
    notePath = await waitForPlaudExportDownload(
      page,
      downloadPromise,
      beforeSnapshot,
      downloadStartedAt,
      title,
      job,
      { kind: 'note', timeoutMs: 180000 }
    );
  }

  job.notePath = notePath;
  return notePath;
}

function plaudVisibleFallbackEnabled(headless) {
  return Boolean(PLAUD_VISIBLE_ON_ERROR && PLAUD_HEADLESS && headless);
}

function plaudVisibleModeReason(err) {
  const message = err && err.message ? err.message : '';
  return /PLAUD|파일 목록|대상 회의|찾지 못|Timeout|로그인|login|list|visible/i.test(message);
}

async function withPlaudPage(headless, callback) {
  const context = await getPlaudContext({ headless, forceNew: true });
  try {
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(30000);
    const result = await callback(page);
    await closePlaudContext(context);
    return result;
  } catch (err) {
    await closePlaudContext(context).catch(() => {});
    throw err;
  }
}

async function listPlaudFilesForMode(limit, headless) {
  const timeoutMs = headless ? 15000 : PLAUD_LOGIN_WAIT_MS;
  return withPlaudPage(headless, async (page) => {
    let lastFiles = [];
    let lastStatus = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const files = await listPlaudFiles(page, limit, {
        timeoutMs: attempt === 0 ? timeoutMs : Math.min(timeoutMs, 10000),
      });
      const status = await getPlaudPageSignals(page);
      lastFiles = files;
      lastStatus = status;
      if (files.length) return { files, status };
      if (status.hasLogin && !status.hasAppShell) return { files, status };
      await page.waitForTimeout(1500);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }

    return { files: lastFiles, status: lastStatus };
  });
}

async function listPlaudFilesWithFallback(limit, options = {}) {
  const modes = options.visible ? [false] : [PLAUD_HEADLESS];
  if (!options.visible && PLAUD_VISIBLE_ON_ERROR && PLAUD_HEADLESS) modes.push(false, true);

  let lastError = null;
  let lastStatus = null;
  for (const headless of modes) {
    try {
      const result = await listPlaudFilesForMode(limit, headless);
      lastStatus = result.status;
      if (result.files.length || !plaudVisibleFallbackEnabled(headless)) {
        return { files: result.files, headless, status: result.status };
      }
    } catch (err) {
      lastError = err;
      if (!plaudVisibleFallbackEnabled(headless) || !plaudVisibleModeReason(err)) throw err;
    }
  }

  if (lastError) throw lastError;
  return { files: [], headless: modes[modes.length - 1], status: lastStatus };
}

async function exportExistingPlaudFileForMode(job, includeNote, headless) {
  const title = fileTitleFromJob(job);
  const timeoutMs = headless ? 12000 : PLAUD_LOGIN_WAIT_MS;

  await withPlaudPage(headless, async (page) => {
    await page.goto('https://web.plaud.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await openPlaudAllFiles(page).catch(() => false);
    await waitForPlaudListReady(page, title, { timeoutMs });

    const initialStatus = await getPlaudFileStatus(page, title).catch(() => null);
    if (!initialStatus) {
      const signals = await getPlaudPageSignals(page);
      if (signals.hasLogin && !signals.hasAppShell) {
        throw new Error('PLAUD 로그인이 필요합니다. /meeting/plaud/login을 열어 회의끝용 PLAUD 브라우저에서 로그인하세요.');
      }
      throw new Error('PLAUD 파일 목록에서 대상 회의를 찾지 못했습니다.');
    }

    const generatedInList = initialStatus.generated
      ? true
      : await waitForPlaudGenerated(page, job, { detailCheckAfterMs: 0 });

    await exportPlaudTranscript(page, job, { verifyDetailGenerated: !generatedInList, allowGenerate: false });
    if (includeNote) {
      try {
        await exportPlaudNote(page, job, { detailAlreadyOpen: true, allowGenerate: false });
      } catch (noteErr) {
        job.noteError = noteErr.message;
        console.warn(`[job:${job.id}] plaud note export warning: ${noteErr.message}`);
      }
    }
  });
}

async function exportExistingPlaudFile(job, includeNote, options = {}) {
  const modes = options.visible ? [false] : [PLAUD_HEADLESS];
  if (!options.visible && PLAUD_VISIBLE_ON_ERROR && PLAUD_HEADLESS) modes.push(false);

  let lastError = null;
  for (const headless of modes) {
    try {
      job.phase = headless
        ? '기존 PLAUD 파일을 백그라운드에서 찾는 중...'
        : '기존 PLAUD 파일을 visible 브라우저에서 찾는 중...';
      await exportExistingPlaudFileForMode(job, includeNote, headless);
      return;
    } catch (err) {
      lastError = err;
      if (!plaudVisibleFallbackEnabled(headless) || !plaudVisibleModeReason(err)) throw err;
      job.phase = `백그라운드 PLAUD 목록 확인 실패. visible 모드로 재시도합니다: ${err.message}`;
      await delay(500);
    }
  }

  if (lastError) throw lastError;
}

async function closePlaudContext(context) {
  try {
    await context.close();
  } finally {
    plaudContextPromise = null;
    plaudContextHeadless = null;
  }
}

function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [...COOKIES_ARGS, '--get-title', '--get-duration', '-s', url]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr));
      const lines = stdout.trim().split('\n');
      const title = lines[0] || 'audio';
      const durationStr = lines[1] || '0';
      // Parse duration: "3:12:45" or "12:45" or "45"
      const parts = durationStr.split(':').map(Number);
      let duration = 0;
      if (parts.length === 3) duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
      else if (parts.length === 2) duration = parts[0] * 60 + parts[1];
      else duration = parts[0];
      resolve({ title, duration });
    });
  });
}

const { runPlaudJob, uploadToPlaud } = createPlaudExtensionUpload({
  cookiesArgs: COOKIES_ARGS,
  plaudQueueDir: PLAUD_QUEUE_DIR,
  plaudMaxSeconds: PLAUD_MAX_SECONDS,
  plaudPartTargetSeconds: PLAUD_PART_TARGET_SECONDS,
  plaudMaxUploadBytes: PLAUD_MAX_UPLOAD_BYTES,
  plaudCompressBitrateK: PLAUD_COMPRESS_BITRATE_K,
  plaudLoginWaitMs: PLAUD_LOGIN_WAIT_MS,
  plaudPostSelectWaitMs: PLAUD_POST_SELECT_WAIT_MS,
  plaudImportTimeoutMs: PLAUD_IMPORT_TIMEOUT_MS,
  plaudGeneratedTimeoutMs: PLAUD_GENERATED_TIMEOUT_MS,
  plaudDownloadDir: PLAUD_DOWNLOAD_DIR,
  plaudHeadlessLoginWaitMs: PLAUD_HEADLESS_LOGIN_WAIT_MS,
  plaudHeadless: PLAUD_HEADLESS,
  plaudVisibleOnError: PLAUD_VISIBLE_ON_ERROR,
  plaudCli,
  ensureDir,
  safeFilename,
  uniqueFilePath,
  fileTitleFromJob,
  humanElapsed,
  getPlaudContext,
  resetPlaudContext,
  closePlaudContext,
  visibleCount,
  clickVisible,
  findVisibleLocator,
  waitForPlaudGenerated,
  exportPlaudTranscript,
  getVideoInfo,
  findOutputFile,
  runYtDlpWithCookieFallback,
});

registerPlaudExtensionRoutes(app, {
  jobs,
  plaudQueueDir: PLAUD_QUEUE_DIR,
  runPlaudJob,
  uploadToPlaud,
});

registerPlaudMeetingRoutes(app, {
  jobs,
  plaudHeadless: PLAUD_HEADLESS,
  plaudFileRowSelector: PLAUD_FILE_ROW_SELECTOR,
  getPlaudContext,
  getPlaudPageSignals,
  listPlaudFilesWithFallback,
  exportExistingPlaudFile,
  plaudCli,
  plaudDownloadDir: PLAUD_DOWNLOAD_DIR,
  plaudGeneratedTimeoutMs: PLAUD_GENERATED_TIMEOUT_MS,
  ensureDir,
  safeFilename,
  uniqueFilePath,
  fileTitleFromJob,
  humanElapsed,
});

function jobPublicSnapshot(job) {
  return {
    status: job.status,
    progress: job.progress,
    phase: job.phase,
    error: job.error,
    filename: job.filename,
    plaudTitle: job.plaudTitle,
    downloadPath: job.downloadPath,
    notePath: job.notePath,
    noteError: job.noteError,
    includeNote: job.includeNote,
    type: job.type,
    flow: job.flow,
    currentPart: job.currentPart,
    totalParts: job.totalParts,
    files: job.files ? job.files.map(f => ({ part: f.part, filename: f.filename, size: f.size })) : undefined,
  };
}

app.get('/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(jobPublicSnapshot(job));
});

// ===== Progress SSE =====
app.get('/progress/:id', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  req.setTimeout(0);
  res.setTimeout(0);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.write(':heartbeat\n\n');

  const heartbeat = setInterval(() => { res.write(':heartbeat\n\n'); }, 15000);

  const interval = setInterval(() => {
    const data = JSON.stringify(jobPublicSnapshot(job));
    res.write(`data: ${data}\n\n`);

    if (job.status === 'done' || job.status === 'error') {
      clearInterval(interval);
      clearInterval(heartbeat);
      res.end();
    }
  }, 500);

  req.on('close', () => {
    clearInterval(interval);
    clearInterval(heartbeat);
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`YT MP3 Server running on http://localhost:${PORT}`);
});
