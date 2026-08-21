# make-youtube automation

YouTube 라이브 녹화본을 다운로드하고, 새 영상으로 일부공개 업로드한 뒤, 라운지 DB의 `Lesson.youtubeUrl`에 새 링크를 반영합니다. 선택적으로 같은 원본으로 Naver Cafe 정리글을 만들고 검증 후 Telegram 링크 알림까지 이어갑니다. 운영 실행기는 상시 켜져 있는 Windows PC에서 동작합니다.

새 업로드 영상은 기본적으로 `unlisted`로 생성하고, 구독자 알림은 보내지 않습니다. 원본 썸네일은 함께 내려받은 뒤 새 영상에 다시 설정합니다. 업로드가 성공해 `uploadedUrl`이 생긴 항목은 로컬 다운로드 원본과 썸네일을 자동 삭제할 수 있습니다.

주의: YouTube 공식 문서에 따르면 2020년 7월 28일 이후 생성된 미검증 API 프로젝트에서 `videos.insert`로 업로드한 영상은 private으로 제한될 수 있습니다. 일부공개 업로드가 실제로 적용되는지는 첫 테스트 영상에서 반드시 확인해야 합니다.

## 인증 구조

업로드에는 API 키가 아니라 OAuth 클라이언트가 필요합니다.

- Google Cloud Console에서 YouTube Data API v3를 활성화합니다.
- Credentials에서 OAuth client를 만들고 Application type은 `Desktop app`으로 선택합니다.
- OAuth consent screen에서 테스트 사용자에 실제 운영 계정을 추가합니다.
- 필요한 scope는 `https://www.googleapis.com/auth/youtube.upload`와 `https://www.googleapis.com/auth/youtube.readonly`입니다.
- 업로드 공개 범위는 코드 기본값이 `unlisted`입니다.

보안 저장 이름은 다음처럼 구분합니다. macOS에서는 Keychain, Windows에서는 현재 Windows 사용자만 해제할 수 있는 DPAPI 파일을 사용합니다.

- account: `make-youtube`
- OAuth client JSON service: `make-youtube-oauth-client-json`
- OAuth token JSON service: `make-youtube-oauth-token-json`

실제 키/토큰을 전달할 때는 채팅에 붙여넣지 말고 `키 전달` 흐름으로 저장합니다.

## 설치

```bash
cd make-youtube-automation
npm install
```

`yt-dlp`도 로컬에 설치되어 있어야 합니다. 이 workflow에서는 영상 다운로드에 직접 쓰지 않고, Edge 로그인 쿠키를 임시 export하는 용도로만 씁니다.

## OAuth client JSON 가져오기

Google Cloud Console에서 받은 OAuth client JSON 파일을 내려받은 뒤, 파일 내용은 Git에 넣지 말고 Keychain으로 가져옵니다.

```bash
node scripts/republish-youtube-lives.mjs --import-oauth-client /path/to/client_secret.json
```

그 다음 최초 1회 브라우저 승인을 합니다.

```bash
npm run auth
```

## 매니페스트 작성

`live-videos.example.json`을 복사해서 `manifest.local.json`으로 만들고, 실제 라이브 URL과 `lessonId`를 채웁니다. `lessonId`를 모르면 `courseTitle` + `sortOrder`로도 반영할 수 있습니다.

내 채널 라이브 날짜로 기본 매니페스트를 만들 수도 있습니다.

```bash
npm run build-manifest
```

```json
[
  {
    "lessonId": 123,
      "sourceUrl": "https://www.youtube.com/live/VIDEO_ID",
      "title": "라이브 강의 제목",
    "description": "AIMAX 라이브 강의 아카이브",
    "copyThumbnail": true
  }
]
```

## 실행 순서

먼저 드라이런:

```bash
npm run dry-run
```

다운로드:

```bash
yt-dlp --cookies-from-browser edge:Default --cookies /tmp/make-youtube-edge-cookies.txt --simulate SOURCE_URL
npm run download-studio
```

업로드:

```bash
npm run upload
```

`npm run upload`는 업로드와 일부공개 상태 확인까지만 수행하며 로컬 원본을 보존합니다.

DB 반영:

```bash
npm run apply-db
```

이미 업로드가 끝난 매니페스트에서 로컬 다운로드 파일만 정리할 수도 있습니다.

```bash
npm run cleanup-downloads
```

각 실행은 `runs/` 아래에 결과 리포트를 남깁니다.

## Windows 정기 실행

Windows 작업 스케줄러에는 다음 네 작업을 등록합니다.

- `AIMAX-Live-Replay-Primary`: 수요일 03:10 · 금요일 01:10
- `AIMAX-Live-Replay-Retry`: 수요일 05:10 · 금요일 03:10
- `AIMAX-Live-Replay-Final`: 수요일 10:10 · 금요일 08:10
- `AIMAX-Live-Replay-Monitor`: 수요일 11:30 · 금요일 11:30

수요일은 전날 화요일 21시 AI 라이브를 `라이브 다시보기 - AI`에, 금요일은 전날 목요일 19시 비즈니스 라이브를 `라이브 다시보기 - 비즈니스`에 등록합니다. 첫 실행은 라이브 시작 약 6시간 뒤이며, 이후 두 번의 실행은 상태 파일과 DB를 확인해 완료된 경우 즉시 종료합니다. 업로드가 끝난 뒤 DB 반영이 실패한 경우에도 저장된 새 영상 URL부터 이어서 처리하므로 중복 업로드하지 않습니다.

Windows 사용자는 로그인 상태여야 합니다. 화면 잠금은 가능하며, Mac을 켜둘 필요는 없습니다. Edge의 기본 프로필은 운영 YouTube Studio 계정에 로그인되어 있어야 합니다. 쿠키 파일이 잠겨 있으면 예약 실행 중 Edge가 잠시 종료되고 이전 세션으로 다시 열립니다.

`AIMAX-Live-Replay-Monitor`는 최종 실행 뒤 상태를 독립적으로 확인합니다. 이미 `complete`이면 YouTube나 라운지를 다시 호출하지 않습니다. 미완료이면 카페·텔레그램 파이프라인을 우회하고 YouTube·라운지 러너만 한 번 재개합니다. 그래도 완료되지 않으면 작업을 실패 코드로 끝내고 `state/*-monitor.json`과 `logs/incidents/`에 원인을 남깁니다. 이 감시는 Windows 작업 스케줄러에서 실행되며 Mac Codex 자동화에 의존하지 않습니다.

### 런타임 사전점검과 제한적 자동복구

각 예약 작업은 본 파이프라인보다 먼저 `scripts/preflight-runtime.mjs`를 실행합니다. 이 점검은 보안 저장소의 DB 주소로 실제 Prisma 클라이언트 생성과 읽기 전용 `SELECT 1`을 확인합니다.

- `@prisma/client` 미생성 오류만 자동복구 허용목록에 포함합니다.
- 해당 오류면 같은 실행 폴더에서 `prisma generate`를 한 번 수행하고 다시 점검합니다.
- DB 연결, OAuth, 채널 불일치 등 다른 오류는 임의 수정하거나 업로드를 진행하지 않습니다.
- 실패 상태는 `logs/incidents/`에 단계, 분류, 실행 슬롯, Git commit을 포함한 비밀값 제거 JSON으로 남깁니다.
- `install-windows.ps1`도 같은 사전점검을 통과해야 예약 작업을 등록합니다.

수동 점검과 허용된 복구:

```powershell
node scripts\preflight-runtime.mjs --config config.local.json --repair --slot manual
```

## Naver Cafe 후속 파이프라인

예약 작업의 진입점은 `scripts/run-scheduled-pipeline.mjs`입니다. 이 스크립트가 기존 라이브 러너를 먼저 완료한 뒤 `cafePublisher.enabled=true`일 때만 카페 게시기를 실행합니다. 카페 단계는 별도 상태 파일을 사용하므로 카페 오류를 재시도할 때 YouTube 업로드와 라운지 등록을 반복하지 않습니다.

NotebookLM 원고와 URL 기반 장면 추출은 업로드·공개범위를 검증한 일부공개 다시보기 `uploadedUrl`을 사용합니다. 카페 글 맨 아래 YouTube OG 카드는 원본 회원전용 라이브 `sourceUrl`을 사용합니다. 기존 다운로드 원본이 남아 있으면 장면 추출만 그 로컬 파일을 우선 사용합니다.

운영 PC에서는 추적 파일을 수정하지 않도록 `config.windows.json`을 Git에서 제외된 `config.local.json`으로 복사해 사용합니다. 기본 예제는 외부 게시를 막기 위해 `enabled=false`, `mode=dry`, `notify=false`입니다.

```json
{
  "cafePublisher": {
    "enabled": false,
    "mode": "dry",
    "python": "C:\\Users\\likim\\AppData\\Local\\Programs\\Python\\Python312\\python.exe",
    "script": "C:\\Users\\likim\\AppData\\Local\\AIMAX\\CafePublisher\\notebook_cafe_auto.py",
    "template": "reference-5854",
    "imageCount": 5,
    "notify": false,
    "expectedClubId": "26321967",
    "expectedMenuId": "315"
  }
}
```

모드별 완료 기준은 서로 독립적입니다.

- `dry`: 원고, 대표 장면 5장, 미리보기, 결과 JSON만 생성합니다. Naver/Telegram 쓰기는 없습니다.
- `draft`: Naver 임시저장까지 수행합니다. 실제 발행과 Telegram은 하지 않습니다.
- `publish`: 글 등록 후 제목·텍스트 6구간·이미지 5장·인용구 0개·YouTube OG 카드 1개를 다시 읽어 검증합니다. `notify=true`이면 검증 뒤 Telegram을 한 번만 전송합니다.

상태는 `state/YYYY-MM-DD-KIND-cafe.json`에 기록합니다. 글 등록 직후 URL이 보존되므로 검증이나 Telegram이 실패해도 다음 실행은 기존 글을 재검증하며 새 글을 중복 발행하지 않습니다. 다운로드 원본은 `publish`와 필요한 Telegram 단계가 모두 끝난 뒤에만 삭제합니다. `dry`와 `draft`에서는 다음 승인 단계가 같은 영상 파일을 재사용할 수 있게 보존합니다.

수동 비게시 점검 예시:

```powershell
node scripts\run-scheduled-pipeline.mjs --config config.local.json `
  --date 2026-08-18 --kind ai --source https://youtu.be/VIDEO_ID
```

첫 운영 전환은 `disabled → dry → draft → publish/notify` 순서로 각각 결과를 확인하고 설정을 올립니다.

무업로드 점검:

```powershell
node scripts\run-scheduled-pipeline.mjs --config config.local.json --doctor --date 2026-07-14 --kind ai --source https://youtu.be/VIDEO_ID
```

점검은 YouTube 업로드나 DB 쓰기를 하지 않고 OAuth, DB 읽기, Edge 쿠키, YouTube Studio 접근과 원본 처리 완료 여부만 확인합니다.

예약 작업 등록도 같은 로컬 설정 파일을 명시합니다.

```powershell
.\scripts\install-windows.ps1 -ConfigFile config.local.json
```
