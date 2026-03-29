# YouTube MP3 Downloader

YouTube 영상을 MP3로 다운로드하는 Chrome 확장프로그램 + 로컬 서버.

- 원하는 구간만 선택해서 다운로드
- 긴 영상 분할 다운로드 (2~5분할)
- 회원전용/연령 제한 영상 지원 (브라우저 쿠키 자동 감지)
- 파일명 = YouTube 영상 제목

![demo](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)

## 사전 준비

### 1. Node.js 설치
https://nodejs.org 에서 LTS 버전 설치

### 2. yt-dlp & ffmpeg 설치

**macOS (Homebrew)**
```bash
brew install yt-dlp ffmpeg
```

**Windows (Winget)**
```bash
winget install yt-dlp ffmpeg
```

**Linux (apt)**
```bash
sudo apt install ffmpeg
pip install yt-dlp
```

## 설치

### 1. 저장소 클론
```bash
git clone https://github.com/aixlife/youtube-mp3-downloader.git
cd youtube-mp3-downloader
```

### 2. 서버 의존성 설치
```bash
cd server
npm install
```

### 3. 서버 실행
```bash
npm start
```
`YT MP3 Server running on http://localhost:3456` 이 나오면 성공.

### 4. Chrome 확장프로그램 등록

1. Chrome 주소창에 `chrome://extensions` 입력
2. 우측 상단 **개발자 모드** 활성화
3. **압축해제된 확장 프로그램을 로드합니다** 클릭
4. 이 프로젝트의 `extension` 폴더 선택
5. YouTube 아무 영상 열면 영상 아래에 MP3 다운로드 바가 나타남

> Arc, Brave, Edge 등 Chromium 기반 브라우저도 동일하게 가능합니다.

## 사용법

### 기본 다운로드
YouTube 영상 페이지에서 MP3 다운로드 바의 **MP3 다운로드** 버튼 클릭.

### 구간 다운로드
- **시작/끝** 입력란에 직접 입력 (예: `1:30`, `45:00`)
- 또는 영상 재생 중 **◀ 현재** 버튼을 눌러 현재 재생 시점 입력

### 분할 다운로드
긴 영상(3시간+ 등)을 나눠서 받고 싶을 때:
1. **2분할 ~ 5분할** 버튼 중 선택
2. **MP3 다운로드** 클릭
3. 자동으로 균등 분할되어 `제목(1).mp3`, `제목(2).mp3` ... 형태로 다운로드

### 회원전용 영상
브라우저에서 해당 채널 멤버십에 가입 + 로그인된 상태라면 자동으로 쿠키를 가져와서 다운로드 가능.
서버가 Chrome, Edge, Brave, Opera, Firefox 중 설치된 브라우저를 자동 감지합니다.

## 서버 자동 실행 (선택)

컴퓨터를 켤 때마다 `npm start`를 치기 번거로우면 자동 실행을 설정할 수 있습니다.

### macOS (LaunchAgent)

아래 내용을 `~/Library/LaunchAgents/com.yt-mp3-server.plist`로 저장:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yt-mp3-server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/YOUR/PATH/TO/youtube-mp3-downloader/server/server.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/yt-mp3-server.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/yt-mp3-server.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
```

> `node` 경로(`which node`)와 프로젝트 경로를 본인 환경에 맞게 수정하세요.

```bash
# 등록 및 시작
launchctl load ~/Library/LaunchAgents/com.yt-mp3-server.plist

# 중지
launchctl unload ~/Library/LaunchAgents/com.yt-mp3-server.plist
```

### Windows (시작 프로그램)

1. `Win + R` → `shell:startup` 입력
2. 열린 폴더에 바로가기 만들기:
   - 대상: `node C:\YOUR\PATH\TO\youtube-mp3-downloader\server\server.js`

## 구조

```
youtube-mp3-downloader/
├── extension/          # Chrome 확장프로그램
│   ├── manifest.json
│   ├── content.js      # YouTube 페이지에 UI 삽입
│   ├── icon48.png
│   └── icon128.png
├── server/             # 로컬 다운로드 서버
│   ├── server.js       # Express + yt-dlp + ffmpeg
│   └── package.json
└── README.md
```

## 문제 해결

| 증상 | 해결 |
|------|------|
| 서버 꺼짐 경고 | 터미널에서 `cd server && npm start` 실행 |
| yt-dlp 명령어 없음 | `brew install yt-dlp` (macOS) |
| 다운로드 실패 | `yt-dlp -U`로 yt-dlp 업데이트 |
| 회원전용 영상 실패 | 해당 브라우저에서 YouTube 로그인 + 멤버십 가입 확인 |
| 확장프로그램 안 보임 | `chrome://extensions`에서 개발자 모드 ON 확인 |
| 포트 충돌 | `lsof -ti:3456 \| xargs kill` 후 재시작 |

## License

MIT
