# make-youtube automation

YouTube 라이브 녹화본을 다운로드하고, 새 영상으로 일부공개 업로드한 뒤, 라운지 DB의 `Lesson.youtubeUrl`에 새 링크를 반영하기 위한 별도 작업 폴더입니다. 운영 실행기는 상시 켜져 있는 Windows PC에서 동작합니다.

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

Windows 작업 스케줄러에는 다음 두 작업을 등록합니다.

- `AIMAX-Live-Replay-Primary`: 수요일·금요일 오전 10시
- `AIMAX-Live-Replay-Retry`: 수요일·금요일 오후 2시

수요일은 전날 화요일 AI 라이브를 `라이브 다시보기 - AI`에, 금요일은 전날 목요일 비즈니스 라이브를 `라이브 다시보기 - 비즈니스`에 등록합니다. 오전 실행이 완료된 경우 오후 실행은 상태 파일과 DB를 확인하고 즉시 종료합니다. 업로드가 끝난 뒤 DB 반영이 실패한 경우에도 저장된 새 영상 URL부터 이어서 처리하므로 중복 업로드하지 않습니다.

Windows 사용자는 로그인 상태여야 합니다. 화면 잠금은 가능하며, Mac을 켜둘 필요는 없습니다. Edge의 기본 프로필은 운영 YouTube Studio 계정에 로그인되어 있어야 합니다. 쿠키 파일이 잠겨 있으면 예약 실행 중 Edge가 잠시 종료되고 이전 세션으로 다시 열립니다.

무업로드 점검:

```powershell
node scripts\run-scheduled-live.mjs --config config.windows.json --doctor --date 2026-07-14 --kind ai --source https://youtu.be/VIDEO_ID
```

점검은 YouTube 업로드나 DB 쓰기를 하지 않고 OAuth, DB 읽기, Edge 쿠키, YouTube Studio 접근과 원본 처리 완료 여부만 확인합니다.
