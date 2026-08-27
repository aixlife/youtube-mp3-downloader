#!/usr/bin/env node
// 업로드는 됐지만 전사가 생성되지 않은 항목을 순차로 생성·회수한다.
//
// PLAUD는 오디오 업로드만으로 전사를 만들지 않는다. 상세 화면의 Generate를 눌러야 한다.
// 서버의 기본값은 '누르지 않음'이고, PLAUD_ALLOW_GENERATE=1일 때만 열린다.
//
// 브라우저를 쓰므로 업로드 배치와 동시에 돌리면 안 된다(프로필 락).
//
// 사용법:
//   node scripts/plaud-generate.mjs
//   node scripts/plaud-generate.mjs --limit 3
//   node scripts/plaud-generate.mjs --dry-run

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BATCH_DIR = path.join(ROOT, 'plaud-batch');
const STATE_PATH = path.join(BATCH_DIR, 'state.json');
const LOG_PATH = path.join(BATCH_DIR, 'generate.log');
const SERVER = process.env.PLAUD_BATCH_SERVER || 'http://127.0.0.1:3456';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || 0;
const POLL_MS = 15_000;
// 전사 생성은 오디오 길이에 비례해 오래 걸린다. 2시간 라이브면 1시간 이상.
const TIMEOUT_MS = Number(process.env.GENERATE_TIMEOUT_MS || 150 * 60 * 1000);
const GAP_MS = 20_000;

// PLAUD에는 서버가 정리한 파일명으로 올라간다(server.js safeFilename과 같은 규칙).
// 원제 그대로 찾으면 목록에서 매칭되지 않는다.
const plaudTitleOf = (title) =>
  (title || 'audio')
    .replace(/[^a-zA-Z0-9가-힣\s\-_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'audio';

const log = (m) => {
  const line = `${new Date().toISOString()} ${m}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, `${line}\n`);
};
const loadJson = (f, d) =>
  fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) : d;

async function run(title) {
  const res = await fetch(`${SERVER}/plaud/generate-export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`generate-export ${res.status}`);
  const { jobId } = await res.json();

  const deadline = Date.now() + TIMEOUT_MS;
  let lastPhase = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let job;
    try {
      const r = await fetch(`${SERVER}/job/${jobId}`);
      if (!r.ok) throw new Error(`job ${r.status}`);
      job = await r.json();
    } catch (e) {
      log(`  조회 실패(재시도): ${e.message}`);
      continue;
    }
    if (job.phase && job.phase !== lastPhase) {
      lastPhase = job.phase;
      log(`  ${job.phase.slice(0, 80)}`);
    }
    if (job.status === 'done') return { ok: true, downloadPath: job.downloadPath };
    if (job.status === 'error') return { ok: false, error: job.error || job.phase };
  }
  return { ok: false, error: `타임아웃 (${Math.round(TIMEOUT_MS / 60000)}분)` };
}

async function main() {
  const state = loadJson(STATE_PATH, { done: {} });
  let pending = Object.entries(state.done)
    .filter(([, v]) => !v.downloadPath || !fs.existsSync(v.downloadPath));

  console.log(`생성·회수 대상: ${pending.length}건`);
  if (!pending.length) return;
  if (LIMIT > 0) pending = pending.slice(0, LIMIT);

  if (DRY_RUN) {
    pending.forEach(([, v], i) => console.log(`  ${i + 1}. ${v.title.slice(0, 55)}`));
    return;
  }

  let ok = 0;
  let fail = 0;
  for (const [i, [id, v]] of pending.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, GAP_MS));
    log(`[${i + 1}/${pending.length}] ${v.title.slice(0, 50)}`);
    try {
      const r = await run(v.plaudTitle || plaudTitleOf(v.title));
      if (r.ok && r.downloadPath && fs.existsSync(r.downloadPath)) {
        state.done[id].downloadPath = r.downloadPath;
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
        ok += 1;
        log(`  완료 → ${path.basename(r.downloadPath)}`);
      } else {
        fail += 1;
        log(`  실패: ${(r.error || '전사본 없음').slice(0, 110)}`);
      }
    } catch (e) {
      fail += 1;
      log(`  실패: ${e.message.slice(0, 110)}`);
    }
  }
  log(`생성·회수 종료: 성공 ${ok} / 실패 ${fail}`);
}

main().catch((e) => {
  log(`치명적 오류: ${e.stack || e.message}`);
  process.exit(1);
});
