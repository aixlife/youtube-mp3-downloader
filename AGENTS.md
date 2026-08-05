# AGENTS.md

## Language

- Default to Korean.

## 회의끝

Trigger terms: `회의끝`, `회의 끝`, `./회의끝`, `meeting-end`.

When triggered:

1. Run `./회의끝` from this repository root. It should attempt existing PLAUD transcript/note export automatically and write artifacts into `meeting-runs/YYYY-MM-DD/exports/`.
2. If PLAUD profile/list status fails, run `./회의끝 --open-plaud-login`, let the user confirm login/workspace, then rerun `./회의끝`.
3. Read the generated `meeting-runs/YYYY-MM-DD/agent-brief.md` and `run-report.json`.
4. Use that run directory for transcript, summary, draft, and report artifacts.
5. Read the Notion meeting home and the matching weekly toggle/page, then inspect linked subpages such as 콘텐츠 보고, 상세페이지, and 직원 기획 루틴 when present.
6. Preserve team-written weekly notes as the source of truth; do not force them into a new template or rewrite/delete their original content.
7. Do not trigger paid or credit-consuming PLAUD generation automatically. Export existing transcript/notes first, using `includeNote: true` when available; if headless PLAUD cannot see the meeting, use the visible fallback instead of clicking Generate. Ask the user before Generate/retry actions that may cost credits.
8. Draft the Notion `회의끝 정리본` first and ask for approval before writing to Notion.
9. Keep the summary concise: meeting summary, team-note summary, KPI changes, decisions, actions, and follow-up questions. Store full transcript and raw PLAUD notes in collapsed sections or linked files.

Detailed procedure: `docs/meeting-end-runbook.md`.

## AI/비즈니스 라이브 완료

Trigger terms: `AI 라이브 라이브 완료`, `AI 라이브 완료`, `비지니스 라이브 완료`, `비즈니스 라이브 완료`.

When triggered:

1. Read `docs/live-replay-automation-runbook.md`.
2. Use `make-youtube-automation/` from this repository root.
3. If the user did not give a date, use KST yesterday.
4. AI live replays go to `라이브 다시보기 - AI`; 비지니스/비즈니스 live replays go to `라이브 다시보기 - 비즈니스`.
5. Upload new videos as YouTube `unlisted`, apply the new link to the lounge DB, and clean local downloaded originals after successful upload/registration.
6. Do not delete the original YouTube live unless the user explicitly asks.
