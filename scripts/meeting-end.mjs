#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_NOTION_URL = 'https://app.notion.com/p/makefriends/19bb31f1da5580fbbff3f8d73ef03ef4?source=copy_link';
const DEFAULT_SINCE_HOURS = 12;
const DEFAULT_SERVER_URL = process.env.MEETING_END_SERVER_URL || 'http://localhost:3456';
const DEFAULT_RUN_ROOT = process.env.MEETING_END_RUN_ROOT || path.join(ROOT, 'meeting-runs');

function usage() {
  console.log(`회의끝 - MakeFamily meeting-end handoff

Usage:
  ./회의끝 [options]

Options:
  --date YYYY-MM-DD       Meeting date in Korea time. Defaults to today.
  --title TEXT            Optional expected PLAUD/meeting title hint.
  --notion-url URL        Notion meeting home/page URL. Defaults to MakeFamily meeting page.
  --since-hours N         List local PLAUD exports modified within N hours. Default: 12.
  --include-downloads     Also scan the general ~/Downloads folder for export candidates.
  --server-url URL        Local yt-mp3 server URL. Default: ${DEFAULT_SERVER_URL}
  --run-root PATH         Directory that contains dated meeting-runs. Default: ${DEFAULT_RUN_ROOT}
  --visible-plaud         Force PLAUD export in a visible browser.
  --open-plaud-login      Open the server PLAUD browser for one-time login, then exit.
  --skip-plaud-export     Only prepare the run directory and agent brief.
  --print-prompt          Print the generated agent brief after creating it.
  --help                  Show this help.

What this does:
  1. Creates/reuses meeting-runs/YYYY-MM-DD/
  2. Writes an agent-brief.md that Codex and Claude Code can both follow.
  3. Indexes recent local PLAUD export candidates.
  4. Prepares a Notion draft format for the weekly toggle summary.
  5. Does not modify Notion or trigger paid/credit PLAUD generation by itself.
`);
}

function parseArgs(argv) {
  const args = {
    notionUrl: DEFAULT_NOTION_URL,
    serverUrl: DEFAULT_SERVER_URL,
    runRoot: DEFAULT_RUN_ROOT,
    sinceHours: DEFAULT_SINCE_HOURS,
    includeDownloads: false,
    printPrompt: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--print-prompt') args.printPrompt = true;
    else if (token === '--date') args.date = argv[++i];
    else if (token === '--title') args.title = argv[++i];
    else if (token === '--notion-url') args.notionUrl = argv[++i];
    else if (token === '--since-hours') args.sinceHours = Number(argv[++i]);
    else if (token === '--include-downloads') args.includeDownloads = true;
    else if (token === '--server-url') args.serverUrl = argv[++i];
    else if (token === '--run-root') args.runRoot = argv[++i];
    else if (token === '--visible-plaud') args.visiblePlaud = true;
    else if (token === '--open-plaud-login') args.openPlaudLogin = true;
    else if (token === '--skip-plaud-export') args.skipPlaudExport = true;
    else {
      console.error(`Unknown option: ${token}`);
      process.exit(2);
    }
  }
  return args;
}

function kstDateString(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function meetingToggleLabel(meetingDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(meetingDate);
  if (!match) return meetingDate;
  return `${match[1].slice(2)}${match[2]}${match[3]}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFile(filePath, body) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function cleanServerUrl(value) {
  return String(value || DEFAULT_SERVER_URL).replace(/\/+$/, '');
}

function hhmmDateLabel(meetingDate) {
  const [, month, day] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(meetingDate) || [];
  return month && day ? `${month}-${day}` : meetingDate;
}

function copyArtifact(sourcePath, runDir, filename) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  const ext = path.extname(sourcePath) || path.extname(filename) || '.txt';
  const target = path.join(runDir, 'exports', `${path.basename(filename, path.extname(filename))}${ext}`);
  fs.copyFileSync(sourcePath, target);
  return target;
}

async function readJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const message = body && body.error ? body.error : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body;
}

function selectPlaudFile(files, meetingDate, titleHint) {
  if (!Array.isArray(files) || !files.length) return null;
  const dateLabel = hhmmDateLabel(meetingDate);
  const titleNeedle = (titleHint || '').normalize('NFC').toLowerCase();

  return files
    .map((file, index) => {
      const haystack = `${file.name || ''} ${file.date || ''} ${file.text || ''}`.normalize('NFC');
      const lower = haystack.toLowerCase();
      let score = 0;
      if (titleNeedle && lower.includes(titleNeedle)) score += 1000;
      if (haystack.includes(dateLabel)) score += 600;
      if ((file.date || '').includes(meetingDate)) score += 500;
      if (/회의|meeting/i.test(haystack)) score += 120;
      if (file.generated) score += 80;
      if (!file.generating) score += 20;
      score += Math.max(0, 20 - index);
      return { file, score };
    })
    .sort((a, b) => b.score - a.score)[0]?.file || files[0];
}

async function pollJob(serverUrl, jobId, timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readJson(`${serverUrl}/job/${jobId}`);
    if (last.status === 'done') return last;
    if (last.status === 'error') throw new Error(last.error || last.phase || 'PLAUD export failed');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`PLAUD export timed out: ${last?.phase || 'no progress'}`);
}

async function openPlaudLogin(serverUrl, reportPath, report) {
  const status = await readJson(`${serverUrl}/meeting/plaud/login`);
  report.plaudLoginOpenedAt = new Date().toISOString();
  report.plaudStatus = status.status || null;
  report.plaudAutomationStatus = 'login_opened';
  if (!report.status || report.status === 'prepared') report.status = 'plaud_login_opened';
  writeFile(reportPath, JSON.stringify(report, null, 2));
  return status;
}

async function exportPlaudArtifacts({ args, meetingDate, runDir, report, reportPath }) {
  const serverUrl = cleanServerUrl(args.serverUrl);
  report.serverUrl = serverUrl;

  await readJson(`${serverUrl}/health`);

  const listUrl = `${serverUrl}/meeting/plaud/list?limit=15${args.visiblePlaud ? '&visible=1' : ''}`;
  const list = await readJson(listUrl);
  report.plaudListChecked = true;
  report.plaudListMode = list.mode || null;
  report.plaudStatus = list.status || null;
  report.recentPlaudServerFiles = list.files || [];

  const selected = selectPlaudFile(list.files, meetingDate, args.title);
  if (!selected) {
    report.plaudAutomationStatus = 'needs_plaud_profile';
    if (!report.status || report.status === 'prepared') report.status = 'needs_plaud_profile';
    writeFile(reportPath, JSON.stringify(report, null, 2));
    throw new Error('PLAUD 서버 프로필에서 최근 회의 파일을 찾지 못했습니다. ./회의끝 --open-plaud-login으로 서버용 PLAUD 브라우저를 확인하세요.');
  }

  report.selectedPlaudTitle = selected.name;
  writeFile(reportPath, JSON.stringify(report, null, 2));

  const exportJob = await readJson(`${serverUrl}/meeting/plaud/export-existing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: selected.name,
      includeNote: true,
      visible: Boolean(args.visiblePlaud),
    }),
  });

  report.plaudExportJobId = exportJob.jobId;
  report.plaudAutomationStatus = 'exporting';
  if (!report.status || report.status === 'prepared' || report.status.startsWith('plaud_')) report.status = 'plaud_exporting';
  writeFile(reportPath, JSON.stringify(report, null, 2));

  const job = await pollJob(serverUrl, exportJob.jobId);
  report.exportedTranscriptPath = copyArtifact(job.downloadPath, runDir, 'transcript.txt');
  report.sourceTranscriptPath = job.downloadPath || null;
  report.summaryPath = copyArtifact(job.notePath, runDir, 'summary.pdf');
  report.sourceSummaryPath = job.notePath || null;
  report.noteError = job.noteError || null;
  report.plaudAutomationStatus = report.exportedTranscriptPath ? 'exported' : 'missing_file';
  if (!report.status || report.status === 'prepared' || report.status.startsWith('plaud_') || report.status === 'needs_plaud_profile') {
    report.status = report.exportedTranscriptPath ? 'plaud_exported' : 'plaud_export_missing_file';
  }
  writeFile(reportPath, JSON.stringify(report, null, 2));
  return job;
}

function recentPlaudCandidates(sinceHours, includeDownloads = false) {
  const home = os.homedir();
  const dirs = [
    process.env.PLAUD_DOWNLOAD_DIR,
    path.join(home, 'Downloads', 'PlaudTranscripts'),
  ].filter(Boolean);
  if (includeDownloads) dirs.push(path.join(home, 'Downloads'));

  const uniqueDirs = [...new Set(dirs)];
  const exts = new Set(['.txt', '.md', '.docx', '.pdf', '.srt', '.vtt']);
  const sinceMs = Date.now() - sinceHours * 60 * 60 * 1000;
  const candidates = [];

  for (const dir of uniqueDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const filePath = path.join(dir, entry.name);
        const ext = path.extname(entry.name).toLowerCase();
        if (!exts.has(ext)) continue;
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < sinceMs) continue;
        const lower = entry.name.toLowerCase();
        const score = stat.mtimeMs
          + (/plaud|transcript|스크립트|자막|summary|요약|note|노트/i.test(lower) ? 1_000_000_000 : 0)
          + (dir.includes('PlaudTranscripts') ? 500_000_000 : 0);
        candidates.push({
          path: filePath,
          name: entry.name,
          directory: dir,
          sizeBytes: stat.size,
          modifiedAt: new Date(stat.mtimeMs).toISOString(),
          score,
        });
      }
    } catch (err) {
      candidates.push({ directory: dir, error: err.message });
    }
  }

  return candidates
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 25)
    .map(({ score, ...rest }) => rest);
}

function markdownTable(candidates) {
  const valid = candidates.filter((item) => item.path);
  if (!valid.length) return '최근 로컬 PLAUD export 후보를 찾지 못했습니다.';
  const rows = valid.slice(0, 10).map((item) => {
    const mb = (item.sizeBytes / 1024 / 1024).toFixed(2);
    return `| ${item.modifiedAt} | ${item.name.replace(/\|/g, '\\|')} | ${mb} MB | \`${item.path.replace(/`/g, '\\`')}\` |`;
  });
  return ['| 수정시각 | 파일 | 크기 | 경로 |', '|---|---|---:|---|', ...rows].join('\n');
}

function templateMarkdown(meetingDate, toggleLabel) {
  return `# ${toggleLabel} 회의끝 정리본

> 팀원 원본 기록을 대체하지 않고, 회의 후 PLAUD 기록과 팀원 작성 내용을 보고 대표/AI가 정리하는 상단 요약입니다.

## 1. 회의 요약
- 

## 2. 팀원 작성 내용 요약
| 영역 | 원본 위치 | 핵심 내용 | 보강 필요 |
|---|---|---|---|

## 3. 숫자로 본 변화
| 영역 | 항목 | 지난주 | 이번주 | 목표 | 판정 | 해석 | 다음 실험 |
|---|---|---:|---:|---:|---|---|---|

## 4. 결정사항
| 결정 | 이유 | 영향받는 영역 | 담당 | 재검토 조건 |
|---|---|---|---|---|

## 5. 이번주 액션
| 액션 | 담당 | 기한 | 완료 기준 | 연결 자료 | 상태 |
|---|---|---|---|---|---|

## 6. 클라이언트 / 대행 현황 요약
| 고객/프로젝트 | 현재 상태 | 이번주 산출물 | 이슈 | 다음 액션 | 담당 | 기한 |
|---|---|---|---|---|---|---|

## 7. 팀원에게 추가로 확인할 것
| 질문 | 이유 | 확인할 사람/위치 |
|---|---|---|

## 8. 원본 링크 / 파일
- Notion 회의 홈:
- 주차 토글: ${toggleLabel}
- 콘텐츠 보고:
- 상세페이지:
- 직원 기획 루틴:
- PLAUD 요약본:
- PLAUD 전사본:

## 9. PLAUD 요약본
<details>
<summary>PLAUD 요약본</summary>

</details>

## 10. 전체 전사본
<details>
<summary>Transcript</summary>

</details>
`;
}

function agentBrief({ meetingDate, runDir, args, candidates }) {
  const titleHint = args.title ? args.title : '(없음)';
  const toggleLabel = meetingToggleLabel(meetingDate);
  return `# 회의끝 Agent Brief

이 파일은 Codex와 Claude Code가 같은 방식으로 회의록 정리를 이어가기 위한 공용 브리프입니다.

## 현재 목표
MakeFamily 주간회의가 끝난 뒤 PLAUD의 최신 회의 기록에서 transcript와 노트/요약본을 확보하고, Notion의 해당 주차 토글과 하위페이지에 팀원들이 작성해온 내용을 함께 읽은 뒤, 주차 토글 상단에 넣을 "회의끝 정리본" 초안을 만듭니다. Notion 쓰기는 사용자 승인 후에만 진행합니다.

## 기본 정보
- 회의일: ${meetingDate}
- 주차 토글 후보: ${toggleLabel}
- 실행 디렉토리: \`${runDir}\`
- Notion 회의 홈: ${args.notionUrl}
- PLAUD 제목 힌트: ${titleHint}
- PLAUD 서버: ${cleanServerUrl(args.serverUrl)}
- 최근 파일 탐색 범위: ${args.sinceHours}시간
- 일반 Downloads 탐색: ${args.includeDownloads ? '포함' : '제외'}

## 최근 로컬 PLAUD export 후보
${markdownTable(candidates)}

## 진행 순서
1. 이 브리프와 \`drafts/notion-meeting-template.md\`를 읽습니다.
2. 최근 로컬 export 후보가 없으면 로컬 서버의 \`GET /meeting/plaud/list?limit=10\`으로 PLAUD 최근 파일 목록을 읽고 오늘 회의 기록을 찾습니다. 서버는 headless 목록이 비면 visible 모드로 한 번 재시도할 수 있습니다.
3. 오늘 회의 제목을 확인한 뒤 \`POST /meeting/plaud/export-existing\`에 \`{"title":"...", "includeNote":true}\`를 보내 이미 생성된 transcript와 노트/요약본을 export합니다. headless에서 회의를 못 찾으면 visible fallback을 사용하되, 이 경로는 Generate 버튼을 자동으로 누르지 않아야 합니다.
4. \`notePath\`가 생기면 PLAUD 노트/요약본을 우선 사용하고, \`noteError\`만 있으면 transcript를 기준으로 Codex/Claude가 요약합니다. 노트/요약 Generate가 필요할 때는 크레딧/비용 가능성이 있으므로 사용자에게 확인합니다.
5. Notion 회의 홈에서 \`${toggleLabel}\` 주차 토글/페이지를 찾습니다. 없으면 새로 만들기 전에 사용자에게 확인합니다.
6. 해당 주차 토글 안의 팀원 원본 기록과 하위페이지 링크를 읽습니다. 특히 콘텐츠 보고, 상세페이지, 직원 기획 루틴 같은 연결 페이지를 우선 확인합니다.
7. 원본 export 파일은 이 실행 디렉토리의 \`exports/\` 아래에 보관합니다. 직접 복사하기 어렵다면 절대경로를 \`run-report.json\`에 남깁니다.
8. \`drafts/notion-draft.md\`를 작성합니다. 형식은 "회의끝 정리본"으로 하고, 팀원 원본 기록을 재작성/삭제하지 않습니다.
9. 초안에는 회의 요약, 팀원 작성 내용 요약, 숫자로 본 변화, 결정사항, 이번주 액션, 추가 확인 질문, 원본 링크만 둡니다.
10. Notion을 수정하기 전 사용자에게 초안을 보여주고 승인을 받습니다.
11. 승인 후에는 해당 주차 토글 상단에 짧은 정리본만 추가합니다. 원본 팀원 기록, 하위페이지, 긴 전사본은 그대로 보존합니다.

## 안전 규칙
- PLAUD 유료/크레딧성 Generate, 재요약, 재전사는 자동 실행하지 않습니다.
- Notion 쓰기는 초안 확인 후에만 진행합니다.
- transcript 전체를 Notion 메인 본문에 길게 펼치지 않습니다.
- 팀원들이 기존 방식으로 작성한 내용을 새 양식으로 강제로 바꾸지 않습니다.
- 팀원 기록에서 부족한 부분은 고쳐 쓰기보다 "추가 확인할 것"으로 분리합니다.
- 개인정보, 주민번호, 계좌, 세금계산서 정보가 전사에 있으면 Notion 본문에는 요약/마스킹해서 넣습니다.

## 기존 코드 참고
- PLAUD 브라우저/다운로드 자동화: \`server/server.js\`
- 최근 PLAUD 목록 조회: \`GET /meeting/plaud/list?limit=10\`
- 기존 transcript/note export 엔드포인트: \`POST /meeting/plaud/export-existing\` with \`includeNote: true\`
- 기본 transcript 저장 위치: \`~/Downloads/PlaudTranscripts\`

## 산출물 체크리스트
- [ ] \`exports/transcript.*\` 또는 transcript 원본 경로 기록
- [ ] \`exports/summary.*\` 또는 요약본 원본 경로 기록
- [ ] Notion \`${toggleLabel}\` 주차 토글/페이지 확인
- [ ] 팀원 원본 기록과 하위페이지 확인
- [ ] \`drafts/notion-draft.md\`
- [ ] \`run-report.json\` 업데이트
- [ ] Notion 반영 여부 사용자 확인
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  args.sinceHours = safeNumber(args.sinceHours, DEFAULT_SINCE_HOURS);
  args.runRoot = path.resolve(args.runRoot || DEFAULT_RUN_ROOT);
  const meetingDate = args.date || kstDateString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meetingDate)) {
    console.error('--date must be YYYY-MM-DD');
    process.exit(2);
  }

  const toggleLabel = meetingToggleLabel(meetingDate);
  const runDir = path.join(args.runRoot, meetingDate);
  ensureDir(path.join(runDir, 'exports'));
  ensureDir(path.join(runDir, 'drafts'));

  const reportPath = path.join(runDir, 'run-report.json');
  const candidates = recentPlaudCandidates(args.sinceHours, args.includeDownloads);
  const existingReport = readJsonFile(reportPath) || {};
  const report = {
    ...existingReport,
    createdAt: existingReport.createdAt || new Date().toISOString(),
    lastPreparedAt: new Date().toISOString(),
    meetingDate,
    meetingToggleLabel: toggleLabel,
    notionUrl: args.notionUrl,
    serverUrl: cleanServerUrl(args.serverUrl),
    titleHint: args.title || null,
    includeDownloads: args.includeDownloads,
    runDir,
    recentPlaudCandidates: candidates,
    status: existingReport.status || 'prepared',
  };

  writeFile(reportPath, JSON.stringify(report, null, 2));
  writeFile(path.join(runDir, 'drafts', 'notion-meeting-template.md'), templateMarkdown(meetingDate, toggleLabel));
  const brief = agentBrief({ meetingDate, runDir, args, candidates });
  writeFile(path.join(runDir, 'agent-brief.md'), brief);

  if (args.openPlaudLogin) {
    const status = await openPlaudLogin(cleanServerUrl(args.serverUrl), reportPath, report);
    console.log('PLAUD 서버용 브라우저를 열었습니다.');
    console.log(`- 상태: ${JSON.stringify(status.status)}`);
    console.log(`- 실행 디렉토리: ${runDir}`);
    return;
  }

  if (!args.skipPlaudExport) {
    try {
      const job = await exportPlaudArtifacts({ args, meetingDate, runDir, report, reportPath });
      console.log('PLAUD export 완료');
      console.log(`- transcript: ${report.exportedTranscriptPath || job.downloadPath || '(없음)'}`);
      console.log(`- summary: ${report.summaryPath || job.notePath || '(없음)'}`);
      if (report.noteError) console.log(`- note warning: ${report.noteError}`);
    } catch (err) {
      report.exportError = err.message;
      report.plaudAutomationStatus = report.plaudAutomationStatus || 'failed';
      if (!report.status || report.status === 'prepared') report.status = 'plaud_export_failed';
      writeFile(reportPath, JSON.stringify(report, null, 2));
      console.error(`PLAUD export 자동 처리 실패: ${err.message}`);
      console.error(`필요하면 먼저 실행하세요: ./회의끝 --open-plaud-login`);
    }
  }

  console.log('회의끝 준비 완료');
  console.log(`- 실행 디렉토리: ${runDir}`);
  console.log(`- 에이전트 브리프: ${path.join(runDir, 'agent-brief.md')}`);
  console.log(`- Notion 초안 템플릿: ${path.join(runDir, 'drafts', 'notion-meeting-template.md')}`);
  console.log('');
  console.log('Codex/Claude Code에게 이렇게 말하면 됩니다:');
  console.log(`meeting-runs/${meetingDate}/agent-brief.md 읽고 회의록 정리 계속해줘.`);

  if (args.printPrompt) {
    console.log('\n--- agent-brief.md ---\n');
    console.log(brief);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
