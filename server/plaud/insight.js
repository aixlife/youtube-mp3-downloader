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
    const child = spawn('/bin/zsh', [PROCESSOR, transcriptPath, title || 'untitled', plaudId || 'unknown'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch (err) {
    console.warn(`[plaud-insight] processor spawn failed: ${err.message}`);
    return false;
  }
}

module.exports = { spawnInsightProcessor };
