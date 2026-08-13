// 배치 현황 리포트. PowerShell의 ConvertFrom-Json은 BOM·인코딩에서 계속 걸려서
// node로 직접 읽는다.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.YT_ROOT || 'C:\\Users\\likim\\Project\\youtube';
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'plaud-batch', f), 'utf8').replace(/^\uFEFF/, ''));

const queue = read('queue.json');
const state = read('state.json');
const done = new Set(Object.keys(state.done || {}));

const kind = (e = '') =>
  /members/i.test(e) ? '멤버십 전용'
  : /타임아웃/.test(e) ? '타임아웃'
  : /Generate/.test(e) ? '전사 미생성'
  : /HTTP|unable to download/i.test(e) ? '다운로드 실패'
  : /ProcessSingleton|fetch failed/i.test(e) ? '환경 오류'
  : '기타';

const byType = (t) => queue.filter((x) => x.type === t);
for (const t of ['video', 'live']) {
  const all = byType(t);
  const fin = all.filter((x) => done.has(x.id));
  const hrs = (a) => (a.reduce((s, x) => s + x.duration, 0) / 3600).toFixed(1);
  console.log(`${t === 'video' ? '일반영상' : '라이브  '}: ${fin.length}/${all.length}편 완료 (${hrs(fin)}h / ${hrs(all)}h)`);
}

const counts = {};
const retryable = [];
for (const [id, v] of Object.entries(state.failed || {})) {
  if (done.has(id)) continue;
  const k = kind(v.error);
  counts[k] = (counts[k] || 0) + 1;
  if (k !== '멤버십 전용') retryable.push(id);
}
console.log('\n미완 사유:');
for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${n}건  ${k}`);
console.log(`\n재시도 가능: ${retryable.length}건`);

if (process.argv.includes('--clear-retryable')) {
  for (const id of retryable) delete state.failed[id];
  fs.writeFileSync(path.join(ROOT, 'plaud-batch', 'state.json'), JSON.stringify(state, null, 1));
  console.log('재시도 대상을 실패 목록에서 해제했습니다.');
}
