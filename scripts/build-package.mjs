#!/usr/bin/env node
// 전달용 패키지 조립: 전사본을 원제로 복원해 유형별로 묶고 목록·README를 붙인다.
//
// PLAUD 업로드 파일명은 특수문자가 정리되고 중복 시 접미사가 붙는다.
// state.json이 영상ID·원제·전사본 경로를 정확히 들고 있으므로 그것을 기준으로 복원한다.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.YT_ROOT || 'C:\\Users\\likim\\Project\\youtube';
const OUT = process.env.PKG_OUT || 'C:\\Users\\likim\\메이크패밀리-전사';
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'plaud-batch', f), 'utf8').replace(/^\uFEFF/, ''));

const queue = read('queue.json');
const state = read('state.json');
const byId = new Map(queue.map((x) => [x.id, x]));

const safe = (s) => s.replace(/[/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
const hhmm = (sec) => `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

fs.rmSync(OUT, { recursive: true, force: true });
for (const d of ['일반영상', '라이브']) fs.mkdirSync(path.join(OUT, '전사', d), { recursive: true });

const rows = [];
let copied = 0, missing = 0;

for (const [id, v] of Object.entries(state.done)) {
  const item = byId.get(id);
  if (!item) continue;
  const src = v.downloadPath;
  if (!src || !fs.existsSync(src)) { missing += 1; continue; }

  const dir = item.type === 'live' ? '라이브' : '일반영상';
  const dst = path.join(OUT, '전사', dir, `${safe(item.title)}.txt`);
  fs.copyFileSync(src, dst);
  copied += 1;

  rows.push({
    type: dir,
    title: item.title,
    id,
    url: item.url,
    duration: hhmm(item.duration),
    chars: fs.readFileSync(dst, 'utf8').replace(/\s/g, '').length,
  });
}

rows.sort((a, b) => (a.type === b.type ? a.title.localeCompare(b.title, 'ko') : a.type.localeCompare(b.type, 'ko')));

const csvEsc = (s) => `"${String(s).replace(/"/g, '""')}"`;
fs.writeFileSync(
  path.join(OUT, '목록.csv'),
  '\uFEFF' + ['유형,제목,길이,글자수,영상ID,URL',
    ...rows.map((r) => [r.type, csvEsc(r.title), r.duration, r.chars, r.id, r.url].join(','))].join('\r\n'),
  'utf8',
);

const skipped = queue.filter((x) => !state.done[x.id]);
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const liveRows = rows.filter((r) => r.type === '라이브');
const vidRows = rows.filter((r) => r.type === '일반영상');

fs.writeFileSync(path.join(OUT, 'README.md'), `# 메이크패밀리 유튜브 전사본

유튜브 채널(@메이크패밀리)의 영상을 음성 인식으로 전사한 텍스트입니다.

## 무엇이 들어있나

| 구분 | 편수 | 분량 | 위치 |
|---|---:|---:|---|
| 일반영상 | ${vidRows.length}편 | ${(sum(vidRows.map((r) => byId.get(r.id)), (x) => x.duration) / 3600).toFixed(1)}시간 | \`전사/일반영상/\` |
| 라이브 다시보기 | ${liveRows.length}편 | ${(sum(liveRows.map((r) => byId.get(r.id)), (x) => x.duration) / 3600).toFixed(1)}시간 | \`전사/라이브/\` |
| 합계 | ${rows.length}편 | ${(sum(rows.map((r) => byId.get(r.id)), (x) => x.duration) / 3600).toFixed(1)}시간 | |

\`목록.csv\` — 전체 목록(제목·길이·글자수·영상ID·URL). 엑셀에서 바로 열립니다.

## 파일 형식

파일명은 유튜브 원제이고, 내용은 이렇게 생겼습니다.

\`\`\`
[00:00 - 00:18] Speaker 1: 안녕하세요...
[00:22 - 00:53] Speaker 2: 네 반갑습니다...
\`\`\`

- 구간별 타임스탬프가 붙어 있어 원본 영상에서 해당 위치를 바로 찾을 수 있습니다
- 대담·인터뷰는 화자가 구분됩니다(Speaker 1, 2...). 다만 이름은 자동으로 붙지 않습니다

## 주의할 점

- **음성 인식 결과라 오탈자가 있습니다.** 특히 고유명사·브랜드명·사람 이름이 틀릴 수 있습니다. 그대로 옮겨 쓰지 말고 인용 전에 확인해 주세요
- **라이브에는 수강생 발언이 섞여 있습니다.** 실명·질문이 포함될 수 있으니 외부 공개 자료로 쓰기 전에 확인이 필요합니다
- **라이브 ${liveRows.length}편은 멤버십 전용 콘텐츠입니다.** 무료 자료나 공개 블로그로 그대로 옮기면 유료 멤버십의 가치가 사라집니다

## 빠진 것

${skipped.length}편은 포함되지 않았습니다.

${skipped.slice(0, 20).map((x) => `- ${x.title}`).join('\n')}${skipped.length > 20 ? `\n- (외 ${skipped.length - 20}편)` : ''}

전부 멤버십 전용으로 분류돼 접근이 막힌 영상입니다. 쇼츠 649편은 애초에 대상에서 제외했습니다.

## 이 자료로 할 수 있는 것

- 전자책·가이드북 원고의 원본 소스
- 블로그·뉴스레터 재구성
- 사내 AI가 검색·인용할 지식베이스

생성일: ${new Date().toISOString().slice(0, 10)}
`, 'utf8');

console.log(`복사 ${copied}편 / 원본 없음 ${missing}편`);
console.log(`  일반영상 ${vidRows.length} · 라이브 ${liveRows.length}`);
console.log(`출력: ${OUT}`);
