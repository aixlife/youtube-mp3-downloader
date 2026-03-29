# YouTube MP3 Downloader

YouTube 영상을 MP3로 다운로드하는 Chrome 확장프로그램.

- 버튼 하나로 MP3 다운로드
- 원하는 구간만 선택 가능
- 긴 영상 분할 다운로드 (2~5분할)
- 회원전용/연령 제한 영상 지원
- 파일명 = YouTube 영상 제목

---

## 설치 방법 (3가지 중 택 1)

### 방법 A: Claude Code / Cowork 사용자 (가장 쉬움)

Claude Code 또는 Cowork에 아래 문장을 그대로 복사해서 보내세요:

> **macOS:**
> ```
> https://github.com/aixlife/youtube-mp3-downloader 이 저장소를 ~/Projects에 클론하고, install-mac.sh를 실행해서 설치해줘. 완료되면 Chrome 확장프로그램 등록 방법을 알려줘.
> ```

> **Windows:**
> ```
> https://github.com/aixlife/youtube-mp3-downloader 이 저장소를 클론하고, install-windows.bat을 실행해서 설치해줘. 완료되면 Chrome 확장프로그램 등록 방법을 알려줘.
> ```

Claude가 다운로드, 설치, 서버 실행까지 전부 처리합니다. 이후 Chrome 확장프로그램 등록만 직접 하면 됩니다 (아래 참고).

---

### 방법 B: macOS 직접 설치

1. 이 페이지 상단의 초록색 **Code** 버튼 → **Download ZIP** 클릭 → 압축 해제
2. **Finder**에서 `응용 프로그램` → `유틸리티` → **터미널** 을 엽니다
3. 아래 두 줄을 복사해서 터미널에 붙여넣고 Enter:

```
cd ~/Downloads/youtube-mp3-downloader-main
bash install-mac.sh
```

4. 비밀번호를 물어보면 Mac 로그인 비밀번호 입력 (입력해도 화면에 안 보이는 게 정상)
5. "✅ 설치 완료!" 가 나오면 성공

---

### 방법 C: Windows 직접 설치

1. 이 페이지 상단의 초록색 **Code** 버튼 → **Download ZIP** 클릭 → 압축 해제
2. 압축 해제한 폴더에서 `install-windows.bat` 파일을 찾습니다
3. **마우스 오른쪽 클릭** → **관리자 권한으로 실행**
4. "✅ 설치 완료!" 가 나오면 성공

---

## Chrome 확장프로그램 등록 (모든 방법 공통, 필수)

설치가 완료된 후 아래 단계를 진행합니다.

1. 브라우저 주소창에 `chrome://extensions` 입력 후 Enter
2. 우측 상단 **개발자 모드** 스위치를 켭니다
3. **압축해제된 확장 프로그램을 로드합니다** 버튼 클릭
4. 다운로드한 폴더 안의 **extension** 폴더를 선택합니다
5. YouTube 아무 영상을 열면 영상 아래에 MP3 다운로드 바가 나타납니다!

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
