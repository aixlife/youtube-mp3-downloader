const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function registerPlaudExtensionRoutes(app, deps) {
  const {
    jobs,
    plaudQueueDir,
    runPlaudJob,
    uploadToPlaud,
    generateAndExport,
  } = deps;

  app.get('/plaud/failed-files', (req, res) => {
    const failedDir = path.join(plaudQueueDir, 'failed');
    let entries = [];

    try {
      entries = fs.readdirSync(failedDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const filePath = path.join(failedDir, entry.name);
          const stat = fs.statSync(filePath);
          return {
            filename: entry.name,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        return res.status(500).json({ error: err.message });
      }
    }

    res.json({ files: entries });
  });

  // YouTube extension upload flow only: download audio, import it into PLAUD,
  // then export the generated transcript.
  app.post('/plaud/send', (req, res) => {
    const { url, start, end, title, uploadOnly } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const jobId = crypto.randomBytes(8).toString('hex');
    const job = {
      id: jobId,
      type: 'plaud',
      flow: 'extension-upload',
      status: 'downloading',
      progress: 0,
      phase: 'PLAUD 전송 준비 중...',
      filename: 'audio.mp3',
      // 호출자가 준 원제. 있으면 yt-dlp 파싱 대신 이걸 파일명·PLAUD 제목으로 쓴다.
      requestedTitle: typeof title === 'string' && title.trim() ? title.trim() : null,
      // 업로드만 하고 전사본 회수는 plaud-collect.mjs가 나중에 일괄 처리한다.
      uploadOnly: Boolean(uploadOnly),
      createdAt: Date.now(),
    };

    jobs.set(jobId, job);
    res.json({ jobId });
    runPlaudJob(job, url, start, end);
  });

  // 이미 업로드된 PLAUD 파일의 전사를 생성하고 회수한다.
  // 업로드와 회수를 분리한 뒤(긴 라이브 타임아웃 회피) 남는 마지막 단계다.
  app.post('/plaud/generate-export', (req, res) => {
    const { title } = req.body;
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'title is required' });
    }

    const jobId = crypto.randomBytes(8).toString('hex');
    const job = {
      id: jobId,
      type: 'plaud',
      flow: 'generate-export',
      status: 'exporting',
      progress: 90,
      phase: 'PLAUD 전사 생성/회수 준비 중...',
      plaudTitle: title,
      filename: `${title}.m4a`,
      keepFile: true,
      createdAt: Date.now(),
    };

    jobs.set(jobId, job);
    res.json({ jobId });

    generateAndExport(job).catch((err) => {
      console.error(`[job:${job.id}] generate-export error: ${err.message}`);
      job.status = 'error';
      job.phase = err.message;
      job.error = err.message;
    });
  });

  // Retry a PLAUD upload from ~/Movies/PlaudQueue/failed without downloading again.
  app.post('/plaud/retry-failed', (req, res) => {
    const { filename, uploadOnly } = req.body;
    if (!filename || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'filename is required' });
    }

    const failedPath = path.join(plaudQueueDir, 'failed', filename);
    if (!fs.existsSync(failedPath)) {
      return res.status(404).json({ error: 'failed file not found' });
    }

    const jobId = crypto.randomBytes(8).toString('hex');
    const stat = fs.statSync(failedPath);
    const job = {
      id: jobId,
      type: 'plaud',
      flow: 'extension-upload-retry',
      status: 'uploading',
      progress: 74,
      phase: '실패한 파일로 PLAUD 업로드 재시도 중...',
      filename,
      filePath: failedPath,
      fileSize: stat.size,
      keepFile: true,
      // 업로드만 하고 전사본 회수는 나중에 일괄 처리한다(긴 영상 타임아웃 회피).
      uploadOnly: Boolean(uploadOnly),
      createdAt: Date.now(),
    };

    jobs.set(jobId, job);
    res.json({ jobId });

    uploadToPlaud(job).catch((err) => {
      console.error(`[job:${job.id}] plaud retry error: ${err.message}`);
      job.status = 'error';
      job.phase = err.message;
      job.error = err.message;
    });
  });
}

module.exports = {
  registerPlaudExtensionRoutes,
};
