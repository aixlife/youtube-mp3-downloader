#!/usr/bin/env node
// 전사본 일괄 회수기
//
// 업로드(plaud-batch --upload-only)와 회수를 분리한 이유:
// 긴 라이브는 PLAUD 클라우드 전사 생성이 오래 걸린다. 한 편 올리고 그 편이 끝날 때까지
// 붙잡고 있으면 90분을 기다리다 타임아웃으로 잘린다(2026-08-14 라이브 9건 연속 실패).
// 업로드만 몰아서 끝내고, 생성이 완료된 뒤 이 스크립트로 한 번에 받는다.
//
// 브라우저를 쓰지 않는다. plaud CLI만 사용하므로 프로필 락·헤드리스 문제가 없다.
//
// 사용법:
//   node scripts/plaud-collect.mjs            # 미회수분 전부 받기
//   node scripts/plaud-collect.mjs --dry-run  # 대상만 출력
//   node scripts/plaud-collect.mjs --days 3   # 최근 N일 목록에서 찾기 (기본 7)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..');
const BATCH_DIR = path.join(ROOT, 'plaud-batch');
const STATE_PATH = path.join(BATCH_DIR, 'state.json');
const LOG_PATH = path.join(BATCH_DIR, 'collect.log');
const OUT_DIR = process.env.PLAUD_DOWNLOAD_DIR
  || path.join(os.homedir(), 'Downloads', 'PlaudTranscripts');
const PLAUD_BIN = process.env.PLAUD_BIN || path.join(os.homedir(), '.local/bin/plaud');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DAYS = Number(args[args.indexOf('--days') + 1]) || 7;

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, `${line}\n`);
}

const loadJson = (f, fallback) =>
  fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) : fallback;

const runPlaud = (a) =>
  execFileAsync(PLAUD_BIN, a, { timeout: 180_000, shell: process.platform === 'win32', maxBuffer: 32 * 1024 * 1024 });

// PLAUD 제목은 업로드 파일명에서 확장자를 뗀 형태다. 다만 특수문자가 정리되므로
// 비교는 한글·영숫자만 남긴 뒤 수행한다.
const normalize = (s) => (s || '').normalize('NFC').replace(/[^0-9A-Za-z가-힣]/g, '').toLowerCase();

// `plaud recent -d N` 한 줄: "  <file_id>  <title>  <YYYY-MM-DD>  <1h02m03s>"
function parseRecent(stdout) {
  const rows = [];
  for (const raw of stdout.split('\n')) {
    const m = raw.match(/^\s+([0-9a-f]{32})\s+(.*?)\s+(\d{4}-\d{2}-\d{2})\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\s*$/);
    if (!m) continue;
    const [, id, title, date, h, mi, s] = m;
    rows.push({
      id,
      title: title.trim(),
      date,
      seconds: Number(h || 0) * 3600 + Number(mi || 0) * 60 + Number(s || 0),
    });
  }
  return rows;
}

function safeName(title) {
  return title.replace(/[/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'transcript';
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const state = loadJson(STATE_PATH, { done: {}, failed: {} });
  state.done ||= {};

  // 업로드는 됐지만 전사본 경로가 없는 항목이 회수 대상이다.
  const pending = Object.entries(state.done)
    .filter(([, v]) => !v.downloadPath || !fs.existsSync(v.downloadPath));

  if (!pending.length) {
    console.log('회수할 항목이 없습니다.');
    return;
  }
  console.log(`회수 대상: ${pending.length}건`);

  const { stdout } = await runPlaud(['recent', '-d', String(DAYS)]);
  const rows = parseRecent(stdout);
  console.log(`PLAUD 최근 ${DAYS}일 목록: ${rows.length}건\n`);

  const byTitle = new Map();
  for (const r of rows) byTitle.set(normalize(r.title), r);

  let ok = 0;
  let miss = 0;
  let fail = 0;

  for (const [id, v] of pending) {
    const key = normalize(v.title);
    // 완전 일치를 먼저 보고, 없으면 접두 일치로 찾는다(PLAUD가 제목을 자를 때가 있다).
    const hit = byTitle.get(key)
      || rows.find((r) => key.startsWith(normalize(r.title)) && normalize(r.title).length >= 12);

    if (!hit) {
      miss += 1;
      log(`  미발견: ${v.title.slice(0, 45)}`);
      continue;
    }

    const outPath = path.join(OUT_DIR, `${safeName(v.title)}.txt`);
    if (DRY_RUN) {
      console.log(`  [dry] ${v.title.slice(0, 45)} → ${path.basename(outPath)}`);
      continue;
    }

    try {
      // 윈도우에서는 shell 경유로 실행되는데, execFile은 shell:true일 때 인자를 인용하지 않는다.
      // 한글·공백이 든 경로를 그대로 넘기면 공백에서 잘려 저장에 실패한다.
      // 공백 없는 임시 경로로 받은 뒤 Node가 최종 이름으로 옮긴다.
      const tmpPath = path.join(OUT_DIR, `.tmp-${hit.id}.txt`);
      await runPlaud(['transcript', hit.id, '-o', tmpPath]);
      fs.renameSync(tmpPath, outPath);
      const size = fs.statSync(outPath).size;
      if (size < 200) throw new Error(`전사본이 비어 있음 (${size} bytes)`);
      state.done[id].downloadPath = outPath;
      state.done[id].plaudFileId = hit.id;
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
      ok += 1;
      log(`  회수 완료: ${v.title.slice(0, 40)} (${Math.round(size / 1024)}KB)`);
    } catch (err) {
      fail += 1;
      log(`  회수 실패: ${v.title.slice(0, 40)} — ${err.message.slice(0, 90)}`);
    }
  }

  if (!DRY_RUN) fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
  log(`회수 종료: 성공 ${ok} / 미발견 ${miss} / 실패 ${fail}`);
  if (miss) console.log('\n미발견은 아직 PLAUD 전사 생성이 안 끝났을 수 있습니다. 나중에 다시 실행하세요.');
}

main().catch((err) => {
  log(`치명적 오류: ${err.stack || err.message}`);
  process.exit(1);
});
