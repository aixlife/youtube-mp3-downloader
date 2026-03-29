# YouTube MP3 Downloader

YouTube 영상을 MP3로 다운로드하는 Chrome 확장프로그램.

- 버튼 하나로 MP3 다운로드
- 원하는 구간만 선택 가능
- 긴 영상 분할 다운로드 (2~5분할)
- 회원전용/연령 제한 영상 지원
- 파일명 = YouTube 영상 제목

---

## 설치 (2단계)

### 1단계: 자동 설치 스크립트 실행

이 저장소를 다운로드한 뒤, 본인 OS에 맞는 설치 파일을 실행합니다.

> **[다운로드 방법]** 이 페이지 상단의 초록색 **Code** 버튼 → **Download ZIP** 클릭 → 압축 해제

#### macOS

터미널을 열고 아래 명령어를 복사해서 실행:

```
cd ~/Downloads/youtube-mp3-downloader-main
bash install-mac.sh
```

> Node.js, yt-dlp, ffmpeg 설치 + 서버 자동 실행 등록이 한 번에 완료됩니다.

#### Windows

1. `install-windows.bat` 파일을 **마우스 오른쪽 클릭** → **관리자 권한으로 실행**
2. 설치가 자동으로 진행됩니다

> Node.js, yt-dlp, ffmpeg 설치 + 서버 자동 실행 등록이 한 번에 완료됩니다.

---

### 2단계: Chrome 확장프로그램 등록

1. 브라우저 주소창에 `chrome://extensions` 입력 후 Enter
2. 우측 상단 **개발자 모드** 스위치를 켭니다
3. **압축해제된 확장 프로그램을 로드합니다** 버튼 클릭
4. 다운로드한 폴더 안의 **extension** 폴더를 선택합니다
5. YouTube 영상을 열면 영상 아래에 MP3 다운로드 바가 나타납니다!

> Arc, Brave, Edge 등 Chromium 기반 브라우저도 동일하게 가능합니다.

---

## 사용법

### 기본 다운로드
영상 아래의 **MP3 다운로드** 버튼을 누르면 전체 영상의 오디오가 MP3로 저장됩니다.

### 구간 다운로드
- **시작/끝** 칸에 시간 입력 (예: `1:30`, `45:00`)
- 또는 영상 재생 중 **◀ 현재** 버튼을 눌러 현재 재생 시점을 자동 입력

### 분할 다운로드
긴 영상(예: 6시간 강의)을 나눠서 받고 싶을 때:
1. **2분할 ~ 5분할** 버튼 중 하나 선택
2. **MP3 다운로드** 클릭
3. `영상제목(1).mp3`, `영상제목(2).mp3` ... 형태로 자동 분할 저장

### 회원전용 영상
해당 채널 멤버십에 가입한 상태에서 브라우저에 로그인되어 있으면 자동으로 다운로드 가능합니다.

---

## 문제 해결

| 증상 | 해결 |
|------|------|
| "서버 꺼짐" 경고 | 설치 스크립트를 다시 실행 |
| 다운로드 실패 | 터미널에서 `yt-dlp -U` 실행하여 업데이트 |
| 회원전용 영상 실패 | 브라우저에서 YouTube 로그인 + 멤버십 확인 |
| 확장프로그램이 안 보임 | `chrome://extensions`에서 개발자 모드 ON 확인 |

### 서버 수동 관리 (일반적으로 필요 없음)

```bash
# macOS - 서버 중지/재시작
launchctl unload ~/Library/LaunchAgents/com.yt-mp3-server.plist
launchctl load ~/Library/LaunchAgents/com.yt-mp3-server.plist

# 로그 확인
cat /tmp/yt-mp3-server.log
```

---

## License

MIT
