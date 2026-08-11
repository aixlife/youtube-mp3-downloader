#!/usr/bin/env node
// 메이크패밀리 유튜브 전체 전사 배치 러너
//
// 하루 상한을 지키며 큐를 PLAUD 파이프라인(POST /plaud/send)에 순차 투입한다.
// - 자체 투입량 상한: DAILY_OWN_CAP_H (기본 18시간)
// - PLAUD 당일 총 사용량 상한: DAILY_TOTAL_CAP_H (기본 21시간, 민수 녹음분 보호)
// 당일 총 사용량은 `plaud today` 실측으로 읽으므로, 민수가 많이 녹음한 날은 알아서 물러난다.
//
// 사용법:
//   node scripts/plaud-batch.mjs               # 오늘 몫만 처리하고 종료
//   node scripts/plaud-batch.mjs --dry-run     # 투입 없이 오늘 편성만 출력
//   node scripts/plaud-batch.mjs --type video  # 특정 유형만 (video | live)
//   node scripts/plaud-batch.mjs --status      # 진행 현황만 출력

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..');
const BATCH_DIR = path.join(ROOT, 'plaud-batch');
const QUEUE_PATH = path.join(BATCH_DIR, 'queue.json');
const STATE_PATH = path.join(BATCH_DIR, 'state.json');
const PREP_PATH = path.join(BATCH_DIR, 'prepared.json');
const LOG_PATH = path.join(BATCH_DIR, 'batch.log');

const SERVER = process.env.PLAUD_BATCH_SERVER || 'http://127.0.0.1:3456';
const DAILY_OWN_CAP_H = Number(process.env.DAILY_OWN_CAP_H || 18);
const DAILY_TOTAL_CAP_H = Number(process.env.DAILY_TOTAL_CAP_H || 21);
const PLAUD_BIN = process.env.PLAUD_BIN || path.join(os.homedir(), '.local/bin/plaud');
// 잡 폴링: 오디오 길이의 1/5 정도가 실측 소요. 여유 4배 + 하한 10분.
const POLL_INTERVAL_MS = 15_000;
// 연속 다운로드는 유튜브 연결 끊김(HTTPSConnection)을 부르고,
// 직전 잡의 PLAUD 브라우저 컨텍스트가 정리될 시간도 필요하다.
const ITEM_GAP_MS = Number(process.env.ITEM_GAP_MS || 30_000);
// 프로필 락·서버 무응답은 항목이 아니라 환경 문제다. 그대로 진행하면 큐를 통째로
// 태워 버린다(2026-08-05: 42편 연속 실패 후 러너 사망, 6일간 방치).
const ENV_FAILURE_LIMIT = Number(process.env.ENV_FAILURE_LIMIT || 3);
const ENV_FAILURE_PATTERN = /ProcessSingleton|launchPersistentContext|fetch failed|ECONNREFUSED/i;
const JOB_TIMEOUT_FACTOR = 0.8;
// 짧은 영상도 업로드+전사 생성에 10분을 넘길 수 있다(2026-08-12 9분 영상 실패).
// PLAUD 클라우드 대기 시간은 영상 길이에 비례하지 않으므로 하한을 넉넉히 둔다.
const JOB_TIMEOUT_MIN_MS = Number(process.env.JOB_TIMEOUT_MIN_MS || 20 * 60 * 1000);

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const flagValue = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const DRY_RUN = hasFlag('--dry-run');
const STATUS_ONLY = hasFlag('--status');
const TYPE_FILTER = flagValue('--type');

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, `${line}\n`);
}

function hhmm(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}

function todayKey() {
  // PLAUD 목록이 로컬 날짜로 표시되므로 로컬 기준으로 맞춘다.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  // PowerShell 5.1의 Set-Content -Encoding utf8은 BOM을 붙인다. JSON.parse는 그걸 못 읽는다.
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
}

// PLAUD 사용량을 최근 24시간 롤링 창으로 합산한다.
//
// `plaud today`를 쓰지 않는 이유: PLAUD 기록은 UTC로 찍히는데 `today`는 로컬 날짜와
// 비교해서, KST 자정~오전 9시 사이에는 방금 올린 것도 못 보고 0을 돌려준다(2026-08-12 실측).
// 그 창에서 가드가 눈이 멀면 민수 녹음 몫까지 배치가 먹는다.
// `recent -d 1`은 시간대와 무관하게 최근 24시간을 주므로 보수적이고 안전하다.
//
// 형식: "  <file_id>  <title>  <YYYY-MM-DD>  <1h02m03s>"
async function plaudTodaySeconds() {
  // 윈도우의 plaud는 .cmd 래퍼라 shell 없이는 execFile로 실행되지 않는다.
  const { stdout } = await execFileAsync(PLAUD_BIN, ['recent', '-d', '1'], {
    timeout: 180_000,
    shell: process.platform === 'win32',
  });
  let total = 0;
  let count = 0;
  for (const raw of stdout.split('\n')) {
    const m = raw.trimEnd().match(/\s(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!m || !m.slice(1).some(Boolean)) continue;
    const [h, mi, s] = m.slice(1).map((x) => Number(x || 0));
    total += h * 3600 + mi * 60 + s;
    count += 1;
  }
  return { seconds: total, count };
}

// 멤버십 영상은 studio-prep.mjs가 미리 오디오를 큐에 넣어 둔다.
// 그런 항목은 다운로드를 건너뛰고 준비된 파일로 바로 업로드한다.
async function submit(item, prepared) {
  const prep = prepared[item.id];
  const endpoint = prep ? '/plaud/retry-failed' : '/plaud/send';
  // 제목을 함께 넘긴다. 서버가 yt-dlp 출력을 파싱하면 윈도우 콘솔 인코딩 때문에
  // 한글이 깨져 PLAUD에 'audio 2' 같은 이름으로 올라간다.
  const body = prep ? { filename: prep.queueFilename } : { url: item.url, title: item.title };

  const res = await fetch(`${SERVER}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${endpoint} ${res.status}`);
  const { jobId } = await res.json();
  if (!jobId) throw new Error('jobId 없음');
  return jobId;
}

async function waitForJob(jobId, item) {
  const timeoutMs = Math.max(JOB_TIMEOUT_MIN_MS, item.duration * 1000 * JOB_TIMEOUT_FACTOR);
  const deadline = Date.now() + timeoutMs;
  let lastPhase = '';

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let job;
    try {
      const res = await fetch(`${SERVER}/job/${jobId}`);
      if (!res.ok) throw new Error(`job ${res.status}`);
      job = await res.json();
    } catch (err) {
      log(`  조회 실패(재시도): ${err.message}`);
      continue;
    }
    if (job.phase && job.phase !== lastPhase) {
      lastPhase = job.phase;
      log(`  ${job.progress ?? 0}% ${job.phase.slice(0, 90)}`);
    }
    if (job.status === 'done') return { ok: true, downloadPath: job.downloadPath, plaudTitle: job.plaudTitle };
    if (job.status === 'error') return { ok: false, error: job.error || job.phase || 'unknown' };
  }
  return { ok: false, error: `타임아웃 (${Math.round(timeoutMs / 60000)}분)` };
}

async function main() {
  fs.mkdirSync(BATCH_DIR, { recursive: true });

  const queue = loadJson(QUEUE_PATH, null);
  if (!queue) {
    console.error(`큐 파일이 없습니다: ${QUEUE_PATH}`);
    process.exit(1);
  }

  const state = loadJson(STATE_PATH, { done: {}, failed: {}, daily: {} });
  state.done ||= {};
  state.failed ||= {};
  state.daily ||= {};

  const prepared = loadJson(PREP_PATH, {});

  // 멤버십 영상은 준비되기 전에는 어차피 다운로드가 실패하므로 큐에서 뺀다.
  const knownMembersOnly = new Set(
    Object.entries(state.failed).filter(([, v]) => /members/i.test(v.error || '')).map(([id]) => id),
  );

  const pending = queue.filter((it) => {
    if (state.done[it.id]) return false;
    if (TYPE_FILTER && it.type !== TYPE_FILTER) return false;
    if (prepared[it.id]) return true;
    if (knownMembersOnly.has(it.id)) return false;
    return true;
  });
  const doneCount = Object.keys(state.done).length;
  const doneSec = Object.values(state.done).reduce((a, d) => a + (d.duration || 0), 0);
  const pendingSec = pending.reduce((a, it) => a + it.duration, 0);

  console.log(`진행: ${doneCount}/${queue.length}편 완료 (${hhmm(doneSec)})`);
  console.log(`남음: ${pending.length}편 (${hhmm(pendingSec)})`);
  const failedIds = Object.keys(state.failed).filter((id) => !state.done[id]);
  if (failedIds.length) console.log(`실패 대기: ${failedIds.length}편`);
  if (STATUS_ONLY) return;

  if (!pending.length) {
    console.log('처리할 항목이 없습니다.');
    return;
  }

  const today = todayKey();
  const ownToday = state.daily[today] || 0;
  const { seconds: totalToday, count: todayCount } = await plaudTodaySeconds();

  const ownRemain = DAILY_OWN_CAP_H * 3600 - ownToday;
  const totalRemain = DAILY_TOTAL_CAP_H * 3600 - totalToday;
  const remain = Math.min(ownRemain, totalRemain);

  console.log('');
  console.log(`[${today}] PLAUD 당일 총 사용: ${hhmm(totalToday)} (${todayCount}건)`);
  console.log(`  배치 자체 투입분: ${hhmm(ownToday)} / 상한 ${DAILY_OWN_CAP_H}시간`);
  console.log(`  오늘 투입 가능: ${remain > 0 ? hhmm(remain) : '없음'}`);

  if (remain <= 0) {
    console.log('오늘 몫 소진. 내일 다시 실행하세요.');
    return;
  }

  // 남은 여유에 들어가는 항목만 순서대로 고른다.
  const plan = [];
  let budget = remain;
  for (const item of pending) {
    if (item.duration <= budget) {
      plan.push(item);
      budget -= item.duration;
    }
  }

  const planSec = plan.reduce((a, it) => a + it.duration, 0);
  console.log(`  오늘 편성: ${plan.length}편 ${hhmm(planSec)}`);
  console.log('');

  if (!plan.length) {
    console.log('남은 여유보다 짧은 항목이 없습니다. 내일 다시 실행하세요.');
    return;
  }

  if (DRY_RUN) {
    plan.forEach((it, i) => {
      console.log(`  ${String(i + 1).padStart(3)}. [${it.type}] ${hhmm(it.duration).padStart(9)}  ${it.title.slice(0, 50)}`);
    });
    console.log('\n--dry-run: 실제 투입은 하지 않았습니다.');
    return;
  }

  log(`배치 시작: ${plan.length}편 ${hhmm(planSec)} (여유 ${hhmm(remain)})`);

  let okCount = 0;
  let failCount = 0;
  let envFailStreak = 0;

  const recordFailure = (item, message) => {
    state.failed[item.id] = { title: item.title, error: message, at: new Date().toISOString() };
    failCount += 1;
    log(`  실패: ${message}`);
    envFailStreak = ENV_FAILURE_PATTERN.test(message) ? envFailStreak + 1 : 0;
    return envFailStreak >= ENV_FAILURE_LIMIT;
  };

  for (const [i, item] of plan.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, ITEM_GAP_MS));
    const tag = prepared[item.id] ? ' [준비됨]' : '';
    log(`[${i + 1}/${plan.length}]${tag} ${item.title.slice(0, 50)} (${hhmm(item.duration)})`);
    try {
      const jobId = await submit(item, prepared);
      const result = await waitForJob(jobId, item);
      if (result.ok) {
        state.done[item.id] = {
          title: item.title,
          type: item.type,
          duration: item.duration,
          downloadPath: result.downloadPath,
          plaudTitle: result.plaudTitle,
          at: new Date().toISOString(),
        };
        delete state.failed[item.id];
        state.daily[today] = (state.daily[today] || 0) + item.duration;
        okCount += 1;
        envFailStreak = 0;
        log(`  완료 → ${result.downloadPath}`);
      } else if (recordFailure(item, result.error)) {
        saveState(state);
        log(`환경 오류 ${ENV_FAILURE_LIMIT}회 연속 — 큐를 태우지 않고 중단합니다.`);
        log('서버와 PLAUD 프로필 락을 확인한 뒤 다시 실행하세요.');
        break;
      }
    } catch (err) {
      if (recordFailure(item, err.message)) {
        saveState(state);
        log(`환경 오류 ${ENV_FAILURE_LIMIT}회 연속 — 큐를 태우지 않고 중단합니다.`);
        log('서버와 PLAUD 프로필 락을 확인한 뒤 다시 실행하세요.');
        break;
      }
    }
    saveState(state);
  }

  saveState(state);
  log(`배치 종료: 성공 ${okCount} / 실패 ${failCount} / 오늘 투입 누계 ${hhmm(state.daily[today] || 0)}`);

  const stillPending = queue.filter((it) => !state.done[it.id]).length;
  log(`전체 진행: ${queue.length - stillPending}/${queue.length}편`);
}

main().catch((err) => {
  log(`치명적 오류: ${err.stack || err.message}`);
  process.exit(1);
});
