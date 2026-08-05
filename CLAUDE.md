# CLAUDE.md

## 기본 언어

한국어로 응답한다.

## 회의끝

사용자가 `회의끝`, `회의 끝`, `./회의끝`, `meeting-end`라고 하면:

1. 저장소 루트에서 `./회의끝`을 실행한다. 기본 실행은 기존 PLAUD transcript/노트 export까지 자동 시도하고 `meeting-runs/YYYY-MM-DD/exports/`에 보관한다.
2. PLAUD 프로필/목록 문제가 있으면 `./회의끝 --open-plaud-login`으로 서버용 PLAUD 브라우저를 열어 로그인/워크스페이스를 확인한 뒤 다시 실행한다.
3. 생성된 `meeting-runs/YYYY-MM-DD/agent-brief.md`와 `run-report.json`을 읽는다.
4. 그 브리프를 기준으로 Notion 주차 토글/하위페이지 확인, Notion 초안 작성, 사용자 승인, Notion 반영을 진행한다.
5. 팀원이 기존 방식으로 작성한 주간 기록은 원본으로 보존하고, 새 템플릿으로 강제 변환하거나 삭제하지 않는다.
6. Generate/재요약/재전사처럼 크레딧이나 비용이 생길 수 있는 동작은 자동으로 하지 말고 먼저 사용자에게 확인한다.
7. Notion 쓰기는 초안 승인 후에만 한다.
8. 전체 전사본은 메인 회의록에 길게 펼치지 말고 접힌 섹션 또는 파일 링크로 둔다.

상세 절차는 `docs/meeting-end-runbook.md`를 따른다.
