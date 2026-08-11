const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROCESSOR = path.join(__dirname, 'insight-processor.sh');

// Fire-and-forget: transcript 저장 직후 호출. 실패해도 본 플로우에 영향 없음.
// 로그·결과는 ~/.plaud-insight/processor.log 에서 확인.
function spawnInsightProcessor(transcriptPath, title, plaudId) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
    if (!fs.existsSync(PROCESSOR)) return false;

    // 인사이트 프로세서는 zsh 스크립트라 macOS 전용이다.
    // 윈도우에서는 전사본만 남기고 조용히 건너뛴다.
    const shell = '/bin/zsh';
    if (process.platform === 'win32' || !fs.existsSync(shell)) return false;

    const child = spawn(shell, [PROCESSOR, transcriptPath, title || 'untitled', plaudId || 'unknown'], {
      detached: true,
      stdio: 'ignore',
    });
    // spawn 실패는 try/catch가 아니라 'error' 이벤트로 온다.
    // 핸들러가 없으면 unhandled error가 되어 서버 프로세스가 통째로 죽는다.
    child.on('error', (err) => {
      console.warn(`[plaud-insight] processor spawn failed: ${err.message}`);
    });
    child.unref();
    return true;
  } catch (err) {
    console.warn(`[plaud-insight] processor spawn failed: ${err.message}`);
    return false;
  }
}

module.exports = { spawnInsightProcessor };
