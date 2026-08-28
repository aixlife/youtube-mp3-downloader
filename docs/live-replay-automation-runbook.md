# AI/비즈니스 라이브 다시보기 자동화

## 목적

YouTube 라이브가 끝난 뒤 원본 라이브 영상을 내려받고, 새 일부공개 영상으로 재업로드하고, 라운지 강의자료에 다시보기 레슨으로 등록한다. 업로드와 DB 반영이 끝난 로컬 원본 파일과 썸네일은 자동 삭제한다.

## 트리거

- `AI 라이브 라이브 완료`
- `AI 라이브 완료`
- `비지니스 라이브 완료`
- `비즈니스 라이브 완료`

날짜가 명시되지 않으면 실행 시점 기준 KST 전날 라이브를 대상으로 한다.

## 분류

- AI 라이브: 강의자료의 `라이브 다시보기 - AI` 코스에 등록한다.
- 비지니스/비즈니스 라이브: 강의자료의 `라이브 다시보기 - 비즈니스` 코스에 등록한다.
- 비즈니스 라이브는 `resources`가 아니라 `/courses` 강의자료 안에 넣는다. 기존 memberapps 운영 메모도 라이브 다시보기를 `AI`와 `비즈니스` 코스로 나누는 방향이다.
- `라이브 다시보기 - 비즈니스` 코스가 없으면 유료 전용 코스로 생성한다. 기본 category는 `라이브 다시보기`, 기본 sortOrder는 `라이브 다시보기 - AI` 다음 순서가 자연스럽다.

## 작업 원칙

- 새 YouTube 업로드는 반드시 `unlisted`로 둔다.
- 구독자 알림은 보내지 않는다.
- 썸네일은 가능한 원본 영상 썸네일을 복사한다.
- 로컬 다운로드 원본과 썸네일은 업로드 성공과 DB 반영 확인 후 삭제한다.
- 기존 YouTube 라이브 원본 삭제는 사용자가 별도로 명시할 때만 진행한다.
- YouTube Studio 다운로드 링크나 cookie token은 매니페스트, 리포트, 로그에 남기지 않는다.
- 멤버십 라이브는 일반 `yt-dlp`/공개 URL 다운로드를 시도하지 않고, Edge 임시 쿠키 + YouTube Studio 다운로드 링크 방식만 사용한다.

## 실행 절차

1. 자동화 폴더로 이동한다.

   ```bash
   cd make-youtube-automation
   ```

2. 대상 날짜를 정한다.

   - 사용자가 날짜를 말하면 그 날짜를 KST 기준 `YYYY-MM-DD`로 쓴다.
   - 날짜가 없으면 KST 전날 날짜를 쓴다.

3. YouTube 업로드 목록에서 해당 날짜 라이브 후보를 만든다.

   ```bash
   node scripts/republish-youtube-lives.mjs --build-manifest-by-dates YYYY-MM-DD --out manifest.local.json
   ```

4. `manifest.local.json`을 라운지 등록용으로 보강한다.

   AI 라이브:

   ```json
   {
     "courseTitle": "라이브 다시보기 - AI",
     "courseCategory": "라이브 다시보기",
     "courseIsFree": false,
     "title": "YYYY-MM-DD 원본 제목",
     "privacyStatus": "unlisted",
     "copyThumbnail": true
   }
   ```

   비즈니스 라이브:

   ```json
   {
     "courseTitle": "라이브 다시보기 - 비즈니스",
     "courseCategory": "라이브 다시보기",
     "courseIsFree": false,
     "courseSortOrder": 25,
     "createCourseIfMissing": true,
     "title": "YYYY-MM-DD 원본 제목",
     "privacyStatus": "unlisted",
     "copyThumbnail": true
   }
   ```

   `sortOrder`는 생략해도 된다. DB 반영 시 해당 코스의 다음 레슨 번호로 생성된다.

5. Edge 로그인 쿠키를 임시 파일로 준비한다.

   이 단계의 `yt-dlp`는 영상 다운로드가 아니라 브라우저 쿠키 export 용도다.

   ```bash
   yt-dlp --cookies-from-browser edge:Default --cookies /tmp/make-youtube-edge-cookies.txt --simulate SOURCE_URL
   ```

6. YouTube Studio 다운로드 링크를 headless Edge로 추출하고, 같은 프로세스에서 원본 영상과 썸네일을 내려받는다. Studio 다운로드 링크는 매니페스트/리포트에 저장하지 않는다.

   ```bash
   npm run download-studio
   ```

7. 새 일부공개 영상으로 업로드하고 YouTube API로 실제 공개 범위가 `unlisted`인지 확인한다. 이 단계에서는 로컬 원본을 보존한다.

   ```bash
   npm run upload
   ```

8. 라운지 DB에 반영한다.

   ```bash
   npm run apply-db
   ```

9. 라운지 DB에서 새 URL이 반영된 것을 확인한 뒤 로컬 다운로드 원본과 썸네일을 삭제한다.

   ```bash
   npm run cleanup-downloads
   ```

10. 임시 쿠키와 token 흔적을 정리한다.

   ```bash
   rm -f /tmp/make-youtube-edge-cookies.txt
   rg -n "QUFFLU|download_my_video\\?v=" manifest.local.json runs || true
   ```

## 검증

- YouTube API로 새 영상의 `privacyStatus`가 `unlisted`인지 확인한다.
- `memberapps` DB에서 해당 Course/Lesson 제목, URL, sortOrder를 확인한다.
- `downloads` 폴더가 비었거나 성공 항목의 원본 파일이 삭제됐는지 확인한다.
- 비즈니스 라이브는 라운지 강의자료에서 `라이브 다시보기 - 비즈니스` 코스 아래에 노출되는 것이 기대 동작이다.

## Naver Cafe 후속 게시

- NotebookLM 원고 생성과 장면 추출에는 검증된 일부공개 다시보기 또는 남아 있는 로컬 영상 파일을 사용한다.
- 카페 제목은 레퍼런스 글 형식을 따르며, 라운지 레슨 제목 앞의 `YYYY-MM-DD`는 제거한다.
- 글 마지막에는 새로 업로드한 일부공개 복제본이 아니라 원본 라이브 영상 ID의 회원 시청용 `https://www.youtube.com/watch?v=...` 주소를 넣는다.
- 회원용 주소는 YouTube 카드나 iframe으로 임베드하지 않고 전체 URL을 보존한 직접 텍스트 링크로 넣는다.
- 발행 후 날짜 없는 제목, 본문과 이미지 보존, 정확한 회원용 `href` 1개, YouTube OG 카드 0개, YouTube iframe 0개를 확인해야 완료로 기록한다.
- 검증된 최종 글은 한 건만 유지한다. 중복 글 삭제는 사용자가 정확한 글번호를 지정해 승인한 경우에만 수행한다.
- Telegram 알림은 최종 글 검증이 끝났고 `notify=true`인 경우에만 한 번 전송한다.

## Windows 운영 일정

- 수요일 07:00 / 09:00 / 11:00: 전날 화요일 21시 AI 라이브 처리·재처리·최종 확인
- 금요일 07:00 / 09:00 / 11:00: 전날 목요일 19시 비즈니스 라이브 처리·재처리·최종 확인
- 수요일·금요일 13:00: 모니터가 남은 미완료 건을 파이프라인째 한 번 재개

첫 슬롯을 새벽에 두면 YouTube Studio 다운로드 링크가 아직 생성되지 않아 매주 실패한다.
카페 후속 게시는 기본적으로 AI 라이브에만 적용된다.

작업 스케줄러 이름은 `AIMAX-Live-Replay-Primary`, `AIMAX-Live-Replay-Retry`, `AIMAX-Live-Replay-Final`이다. 같은 날짜·종류의 안정적인 매니페스트와 상태 파일을 재사용하고, DB의 날짜 접두사 레슨을 먼저 조회해 중복 업로드를 방지한다. Windows 사용자는 로그인 상태여야 하지만 화면은 잠가도 되며 Mac은 필요하지 않다.
