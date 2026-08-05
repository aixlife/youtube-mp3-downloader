#!/usr/bin/env node
// 멤버십 전용 영상 준비기 (Studio 경로)
//
// yt-dlp로는 멤버십 영상의 오디오 포맷을 받을 수 없다(스토리보드만 노출).
// make-youtube-automation의 YouTube Studio 공식 다운로드 경로로 원본을 받아
// 오디오만 뽑아 PLAUD 큐(failed 폴더)에 넣는다. 업로드는 배치 러너가 한다.
//
// Studio 다운로드는 headless Edge + curl이라 PLAUD 업로드(persistent Chrome)와
// 프로필이 겹치지 않는다 — 배치가 도는 중에 동시 실행해도 안전하다.
//
// 사용법:
//   node scripts/studio-prep.mjs --live          # 라이브 49편
//   node scripts/studio-prep.mjs --failed-members # 배치에서 멤버십 사유로 실패한 것
//   node scripts/studio-prep.mjs --ids ID1,ID2
//   node scripts/studio-prep.mjs --live --limit 5

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..');
const AUTOMATION = path.join(ROOT, 'make-youtube-automation');
const BATCH_DIR = path.join(ROOT, 'plaud-batch');
const QUEUE_PATH = path.join(BATCH_DIR, 'queue.json');
const STATE_PATH = path.join(BATCH_DIR, 'state.json');
const PREP_PATH = path.join(BATCH_DIR, 'prepared.json');
const LOG_PATH = path.join(BATCH_DIR, 'studio-prep.log');

const COOKIE_FILE = '/tmp/make-youtube-edge-cookies.txt';
// Studio 편집 URL은 활성 채널 기준으로 해석되므로 채널을 명시해 전환시킨다.
const STUDIO_CHANNEL_NAME = process.env.STUDIO_CHANNEL_NAME || '메이크패밀리';
// Studio 페이지를 연속으로 두드리면 "Oops, something went wrong."으로 막힌다.
const STUDIO_GAP_MS = Number(process.env.STUDIO_GAP_MS || 45_000);
const PLAUD_QUEUE = path.join(os.homedir(), 'Movies', 'PlaudQueue', 'failed');
const DOWNLOADS = path.join(AUTOMATION, 'downloads');

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const flagValue = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const LIMIT = Number(flagValue('--limit') || 0);

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, `${line}\n`);
}

// Studio 다운로드 링크와 쿠키 토큰은 로그·리포트에 남기지 않는다 (런북 규칙).
function redact(text) {
  return String(text)
    .replace(/https?:\/\/[^\s"']*download_my_video[^\s"']*/g, '<STUDIO_LINK_REDACTED>')
    .replace(/QUFFLU[\w-]+/g, '<TOKEN_REDACTED>');
}

// PLAUD 큐 파일명에 쓸 수 없는 문자를 정리한다.
function safeName(title) {
  return title.replace(/[/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
}

function loadJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function pickTargets() {
  const queue = loadJson(QUEUE_PATH, []);
  const state = loadJson(STATE_PATH, { done: {}, failed: {} });
  const prepared = loadJson(PREP_PATH, {});
  const byId = new Map(queue.map((it) => [it.id, it]));

  let ids = [];
  if (flagValue('--ids')) {
    ids = flagValue('--ids').split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    if (hasFlag('--live')) ids.push(...queue.filter((it) => it.type === 'live').map((it) => it.id));
    if (hasFlag('--failed-members')) {
      ids.push(...Object.entries(state.failed || {})
        .filter(([, v]) => /members/i.test(v.error || ''))
        .map(([id]) => id));
    }
  }

  // 이미 전사됐거나 준비된 것은 건너뛴다.
  const seen = new Set();
  return ids
    .filter((id) => {
      if (seen.has(id) || state.done?.[id] || prepared[id]) return false;
      seen.add(id);
      return true;
    })
    .map((id) => byId.get(id))
    .filter(Boolean);
}

async function studioDownload(item) {
  const manifest = [{
    sourceDate: 'prep',
    sourceVideoId: item.id,
    sourceUrl: item.url,
    title: item.title,
  }];
  const manifestPath = path.join(BATCH_DIR, `.prep-${item.id}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));

  try {
    await execFileAsync('node', [
      path.join(AUTOMATION, 'scripts/republish-youtube-lives.mjs'),
      '--manifest', manifestPath,
      '--extract-studio-links',
      '--download-studio',
      '--cookie-file', COOKIE_FILE,
      '--studio-channel-name', STUDIO_CHANNEL_NAME,
    ], { cwd: AUTOMATION, timeout: 30 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
  } finally {
    fs.rmSync(manifestPath, { force: true });
  }

  const mp4 = path.join(DOWNLOADS, `prep-${item.id}.mp4`);
  if (!fs.existsSync(mp4)) throw new Error('Studio 다운로드 산출물을 찾지 못함');
  return mp4;
}

async function extractAudio(mp4, item) {
  fs.mkdirSync(PLAUD_QUEUE, { recursive: true });
  const outName = `${safeName(item.title)}.m4a`;
  const outPath = path.join(PLAUD_QUEUE, outName);

  await execFileAsync('ffmpeg', [
    '-y', '-i', mp4,
    '-vn', '-ac', '1', '-ar', '16000',
    '-c:a', 'aac', '-b:a', '48k',
    outPath, '-loglevel', 'error',
  ], { timeout: 30 * 60 * 1000 });

  const size = fs.statSync(outPath).size;
  if (size < 100 * 1024) throw new Error(`추출된 오디오가 비정상적으로 작음 (${size} bytes)`);
  return { outName, outPath, size };
}

async function main() {
  fs.mkdirSync(BATCH_DIR, { recursive: true });

  if (!fs.existsSync(COOKIE_FILE)) {
    console.error(`Edge 쿠키 파일이 없습니다: ${COOKIE_FILE}`);
    console.error('먼저 실행: yt-dlp --cookies-from-browser edge:Default --cookies /tmp/make-youtube-edge-cookies.txt --simulate <URL>');
    process.exit(1);
  }

  let targets = pickTargets();
  if (LIMIT > 0) targets = targets.slice(0, LIMIT);

  if (!targets.length) {
    console.log('준비할 대상이 없습니다.');
    return;
  }

  const totalSec = targets.reduce((a, it) => a + it.duration, 0);
  log(`Studio 준비 시작: ${targets.length}편 (${(totalSec / 3600).toFixed(1)}시간)`);

  const prepared = loadJson(PREP_PATH, {});
  let ok = 0;
  let fail = 0;

  for (const [i, item] of targets.entries()) {
    if (i > 0) {
      log(`  Studio 간격 대기 ${Math.round(STUDIO_GAP_MS / 1000)}초`);
      await new Promise((r) => setTimeout(r, STUDIO_GAP_MS));
    }
    log(`[${i + 1}/${targets.length}] ${item.title.slice(0, 50)} (${Math.round(item.duration / 60)}분)`);
    let mp4;
    try {
      mp4 = await studioDownload(item);
      const audio = await extractAudio(mp4, item);
      prepared[item.id] = {
        title: item.title,
        type: item.type,
        duration: item.duration,
        queueFilename: audio.outName,
        sizeBytes: audio.size,
        at: new Date().toISOString(),
      };
      fs.writeFileSync(PREP_PATH, JSON.stringify(prepared, null, 1));
      ok += 1;
      log(`  준비 완료 → ${audio.outName} (${(audio.size / 1024 / 1024).toFixed(1)}MB)`);
    } catch (err) {
      fail += 1;
      log(`  실패: ${redact(err.message).slice(0, 200)}`);
    } finally {
      // 원본 MP4와 썸네일은 전사에 불필요하므로 즉시 지운다.
      if (mp4) {
        fs.rmSync(mp4, { force: true });
        fs.rmSync(mp4.replace(/\.mp4$/, '.jpg'), { force: true });
      }
    }
  }

  log(`Studio 준비 종료: 성공 ${ok} / 실패 ${fail}`);
  console.log('\n다음 단계: 배치 러너가 prepared.json을 읽어 /plaud/retry-failed로 업로드합니다.');
  console.log('배치가 도는 중이면 그대로 두세요. 업로드는 순차 실행이어야 합니다.');
}

main().catch((err) => {
  log(`치명적 오류: ${redact(err.stack || err.message)}`);
  process.exit(1);
});
