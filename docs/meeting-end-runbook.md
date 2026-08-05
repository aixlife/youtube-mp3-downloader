# 회의끝 Runbook

이 문서는 MakeFamily 회의가 끝난 뒤 Codex나 Claude Code가 같은 방식으로 회의록 정리를 이어가기 위한 공용 절차입니다.

## Trigger

- 사용자가 `회의끝`, `회의 끝`, `./회의끝`, `meeting-end`라고 말하거나 실행한다.
- 먼저 `./회의끝`을 실행해서 `meeting-runs/YYYY-MM-DD/agent-brief.md`를 만든다.
- 이후 에이전트는 해당 브리프를 기준으로 PLAUD export, Notion 초안, 사용자 승인, Notion 반영을 진행한다.

## Flow

1. `./회의끝` 실행
2. 스크립트가 `meeting-runs/YYYY-MM-DD/`와 `agent-brief.md`를 만들고 기존 `run-report.json`이 있으면 병합한다.
3. 스크립트가 `GET /meeting/plaud/list?limit=15`로 PLAUD `모든 파일` 목록을 확인한다. headless 목록이 비면 reload 재시도 후 visible, 다시 headless 순서로 재확인할 수 있다.
4. 스크립트가 오늘 회의 제목을 선택해 `POST /meeting/plaud/export-existing`에 `{"title":"...", "includeNote":true}`를 보내 transcript와 note export를 시도한다. Generate는 누르지 않는다.
5. export가 성공하면 `meeting-runs/YYYY-MM-DD/exports/transcript.*`, `summary.*`에 복사하고 `run-report.json`에 원본 경로와 `plaudAutomationStatus`를 기록한다.
6. PLAUD 프로필/목록 문제가 있으면 `./회의끝 --open-plaud-login`으로 서버용 PLAUD 브라우저를 열어 로그인/워크스페이스를 확인한 뒤 다시 실행한다.
7. 이후 에이전트가 `agent-brief.md`와 `run-report.json`을 읽고 Notion 회의 홈에서 해당 주차 토글/페이지를 확인한다.
8. 주차 토글 안의 팀원 원본 기록과 하위페이지 확인
9. `drafts/notion-draft.md` 작성
10. 사용자에게 초안 확인 요청
11. 승인 후 Notion 반영

## Notion 원칙

- 긴 전사본은 메인 본문에 펼치지 않는다.
- 메인 회의록은 `회의끝 정리본`으로 두고, 회의 요약, 팀원 작성 내용 요약, KPI 변화, 결정사항, 액션, 추가 확인 질문 중심으로 둔다.
- 팀원이 기존 방식으로 작성한 날짜 토글/하위페이지 내용은 원본으로 보존한다.
- 부족하거나 애매한 팀원 기록은 임의로 채우지 말고 `팀원에게 추가로 확인할 것`에 따로 모은다.
- transcript와 PLAUD 요약본은 접힌 섹션 또는 파일 링크로 둔다.
- 기존 2026 토글 안에 반영할 때는 상단에 짧은 `회의끝 정리본`만 추가하고, 기존 기록은 아래에 그대로 둔다.

## Team Notes Review

- 주차 토글명은 기본적으로 회의일의 `YYMMDD` 형식이다. 예: `2026-06-22` -> `260622`.
- 우선 확인할 원본은 고객/대행 현황, 공통 체크 표, 콘텐츠 보고, 상세페이지, 직원 기획 루틴이다.
- 팀원 원본 기록에서 그대로 가져올 것은 숫자, 진행 상태, 링크, 담당자별 개선사항이다.
- AI가 정리해서 만들 것은 결론, 의사결정, 전주 대비 변화 해석, 액션, 누락 질문이다.
- 팀원에게 요구할 최소 보강 기준은 `다음 액션`, `담당`, `기한`, `성과 숫자`, `막힌 점`이다.

## Cost / Safety

- PLAUD에서 transcript/summary가 이미 생성된 경우 export만 한다.
- Generate, 재요약, 재전사처럼 크레딧/유료 사용 가능성이 있는 버튼은 자동으로 누르지 않는다.
- `/meeting/plaud/export-existing`는 기존 transcript/note export만 해야 하며, Generate 버튼이 필요하면 에러로 멈추고 사용자 확인을 받는다.
- 일반 `~/Downloads`는 기본 후보에서 제외한다. 수동 다운로드 파일까지 후보로 보려면 `./회의끝 --include-downloads`를 명시한다.
- Notion 쓰기는 초안 승인 후에만 한다.
- 민감정보는 요약/마스킹한다.

## Useful Paths

- PLAUD 회의끝 라우트: `server/routes/plaud-meeting.js`
- PLAUD 확장 업로드 라우트: `server/routes/plaud-extension.js`
- PLAUD 확장 업로드 실행: `server/plaud/extension-upload.js`
- PLAUD 공통 브라우저/목록/export helper: `server/server.js`
- PLAUD 최근 목록 조회: `GET /meeting/plaud/list?limit=10`
- PLAUD transcript/note export: `POST /meeting/plaud/export-existing` with `includeNote: true`
- PLAUD visible 강제 확인: `GET /meeting/plaud/list?limit=10&visible=1`, `POST /meeting/plaud/export-existing` with `visible: true`
- PLAUD 상태 확인: `GET /meeting/plaud/status`
- PLAUD 로그인/워크스페이스 복구: `./회의끝 --open-plaud-login` 또는 `GET /meeting/plaud/login`
- PLAUD export job 확인: `GET /job/:id`
- transcript 기본 저장: `~/Downloads/PlaudTranscripts`
- 회의 실행 기록: `meeting-runs/YYYY-MM-DD/`
