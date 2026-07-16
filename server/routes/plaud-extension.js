const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function registerPlaudExtensionRoutes(app, deps) {
  const {
    jobs,
    plaudQueueDir,
    runPlaudJob,
    uploadToPlaud,
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
    const { url, start, end } = req.body;
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
      createdAt: Date.now(),
    };

    jobs.set(jobId, job);
    res.json({ jobId });
    runPlaudJob(job, url, start, end);
  });

  // Retry a PLAUD upload from ~/Movies/PlaudQueue/failed without downloading again.
  app.post('/plaud/retry-failed', (req, res) => {
    const { filename } = req.body;
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
