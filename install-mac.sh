#!/bin/bash
# ============================================
#  YouTube MP3 Downloader - macOS 설치 스크립트
#  이 파일 하나만 실행하면 모든 준비가 완료됩니다.
# ============================================

set -e

echo ""
echo "========================================="
echo "  YouTube MP3 Downloader 설치 시작 (macOS)"
echo "========================================="
echo ""

# 1. Homebrew 확인/설치
if ! command -v brew &>/dev/null; then
    echo "[1/5] Homebrew 설치 중... (Mac 패키지 관리자)"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Apple Silicon Mac의 경우 PATH 설정
    if [ -f /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
        echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
    fi
else
    echo "[1/5] Homebrew ✅ 이미 설치됨"
fi

# 2. Node.js 확인/설치
if ! command -v node &>/dev/null; then
    echo "[2/5] Node.js 설치 중..."
    brew install node
else
    echo "[2/5] Node.js ✅ 이미 설치됨 ($(node -v))"
fi

# 3. yt-dlp & ffmpeg 확인/설치
if ! command -v yt-dlp &>/dev/null; then
    echo "[3/5] yt-dlp 설치 중..."
    brew install yt-dlp
else
    echo "[3/5] yt-dlp ✅ 이미 설치됨"
fi

if ! command -v ffmpeg &>/dev/null; then
    echo "      ffmpeg 설치 중..."
    brew install ffmpeg
else
    echo "      ffmpeg ✅ 이미 설치됨"
fi

# 4. 서버 의존성 설치
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "[4/5] 서버 패키지 설치 중..."
cd "$SCRIPT_DIR/server"
npm install --silent

# 5. 자동 실행 등록 (LaunchAgent)
echo "[5/5] 서버 자동 실행 등록 중..."
NODE_PATH=$(which node)
SERVER_PATH="$SCRIPT_DIR/server/server.js"

PLIST_PATH="$HOME/Library/LaunchAgents/com.yt-mp3-server.plist"

# 기존 등록 해제
launchctl unload "$PLIST_PATH" 2>/dev/null || true

cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yt-mp3-server</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${SERVER_PATH}</string>
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
PLIST

launchctl load "$PLIST_PATH"

# 서버 시작 확인
sleep 2
if curl -s http://localhost:3456/health | grep -q "ok"; then
    echo ""
    echo "========================================="
    echo "  ✅ 설치 완료!"
    echo "========================================="
    echo ""
    echo "  서버가 백그라운드에서 실행 중입니다."
    echo "  (컴퓨터를 켤 때마다 자동 실행됩니다)"
    echo ""
    echo "  남은 단계: Chrome 확장프로그램 등록"
    echo "  ─────────────────────────────────"
    echo "  1. 브라우저 주소창에 chrome://extensions 입력"
    echo "  2. 우측 상단 [개발자 모드] 켜기"
    echo "  3. [압축해제된 확장 프로그램을 로드합니다] 클릭"
    echo "  4. 이 폴더 안의 extension 폴더 선택:"
    echo "     $SCRIPT_DIR/extension"
    echo "  5. YouTube 영상 열면 아래에 MP3 다운로드 바 표시!"
    echo ""
else
    echo ""
    echo "⚠️  서버 시작 실패. 수동으로 실행해보세요:"
    echo "  cd $SCRIPT_DIR/server && npm start"
    echo ""
fi
