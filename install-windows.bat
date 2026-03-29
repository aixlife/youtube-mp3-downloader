@echo off
chcp 65001 >nul
:: ============================================
::  YouTube MP3 Downloader - Windows 설치 스크립트
::  이 파일을 관리자 권한으로 실행하면 모든 준비가 완료됩니다.
:: ============================================

echo.
echo =========================================
echo   YouTube MP3 Downloader 설치 시작 (Windows)
echo =========================================
echo.

:: 1. Node.js 확인/설치
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [1/4] Node.js 설치 중...
    winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    if %ERRORLEVEL% neq 0 (
        echo.
        echo ⚠️  Node.js 자동 설치 실패. 수동으로 설치해주세요:
        echo     https://nodejs.org
        echo.
        pause
        exit /b 1
    )
    :: PATH 갱신
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
) else (
    echo [1/4] Node.js ✅ 이미 설치됨
)

:: 2. yt-dlp 확인/설치
where yt-dlp >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [2/4] yt-dlp 설치 중...
    winget install -e --id yt-dlp.yt-dlp --accept-package-agreements --accept-source-agreements
    if %ERRORLEVEL% neq 0 (
        echo      winget 실패, pip으로 시도...
        pip install yt-dlp
    )
) else (
    echo [2/4] yt-dlp ✅ 이미 설치됨
)

:: 3. ffmpeg 확인/설치
where ffmpeg >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo      ffmpeg 설치 중...
    winget install -e --id Gyan.FFmpeg --accept-package-agreements --accept-source-agreements
    if %ERRORLEVEL% neq 0 (
        echo.
        echo ⚠️  ffmpeg 자동 설치 실패. 수동으로 설치해주세요:
        echo     https://ffmpeg.org/download.html
        echo.
    )
) else (
    echo      ffmpeg ✅ 이미 설치됨
)

:: 4. 서버 의존성 설치
echo [3/4] 서버 패키지 설치 중...
cd /d "%~dp0server"
call npm install --silent

:: 5. 시작 프로그램 등록
echo [4/4] 서버 자동 실행 등록 중...
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SERVER_PATH=%~dp0server\server.js"
set "VBS_PATH=%STARTUP_DIR%\yt-mp3-server.vbs"

:: VBScript로 숨김 창 실행 (검은 창 안 뜨게)
echo Set WshShell = CreateObject("WScript.Shell") > "%VBS_PATH%"
echo WshShell.Run "node ""%SERVER_PATH%""", 0, False >> "%VBS_PATH%"

:: 지금 바로 서버 시작
start "" /B node "%SERVER_PATH%"

:: 서버 시작 확인
timeout /t 3 /nobreak >nul
curl -s http://localhost:3456/health | findstr "ok" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo.
    echo =========================================
    echo   ✅ 설치 완료!
    echo =========================================
    echo.
    echo   서버가 백그라운드에서 실행 중입니다.
    echo   (컴퓨터를 켤 때마다 자동 실행됩니다)
    echo.
    echo   남은 단계: Chrome 확장프로그램 등록
    echo   ─────────────────────────────────
    echo   1. 브라우저 주소창에 chrome://extensions 입력
    echo   2. 우측 상단 [개발자 모드] 켜기
    echo   3. [압축해제된 확장 프로그램을 로드합니다] 클릭
    echo   4. 이 폴더 안의 extension 폴더 선택:
    echo      %~dp0extension
    echo   5. YouTube 영상 열면 아래에 MP3 다운로드 바 표시!
    echo.
) else (
    echo.
    echo ⚠️  서버 시작 실패. 터미널을 새로 열고 다시 실행해보세요.
    echo.
)

pause
