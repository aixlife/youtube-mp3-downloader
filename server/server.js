const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = 3456;

app.use(cors());
app.use(express.json());

// In-memory job store
const jobs = new Map();

// Clean up old jobs every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > 60 * 60 * 1000) {
      cleanupJobFiles(job);
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000);

function cleanupJobFiles(job) {
  if (job.filePath) {
    const dir = path.dirname(job.filePath);
    const base = path.basename(job.filePath, '.mp3');
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        if (f.startsWith(base)) {
          fs.unlink(path.join(dir, f), () => {});
        }
      }
    } catch {}
  }
  // Clean up split files
  if (job.files) {
    for (const f of job.files) {
      if (f.path && fs.existsSync(f.path)) {
        fs.unlink(f.path, () => {});
      }
    }
  }
}

function findOutputFile(basePath) {
  const dir = path.dirname(basePath);
  const base = path.basename(basePath, '.mp3');
  try {
    const files = fs.readdirSync(dir);
    const mp3File = files.find(f => f.startsWith(base) && f.endsWith('.mp3'));
    if (mp3File) return path.join(dir, mp3File);
  } catch {}
  return null;
}

// Chrome cookies for members-only / age-restricted videos
// Auto-detect browser for cookies (members-only / age-restricted videos)
function detectBrowser() {
  const homeDir = os.homedir();
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const isLinux = process.platform === 'linux';

  const browsers = [
    { name: 'chrome', mac: 'Google/Chrome', win: 'Google\\Chrome', linux: 'google-chrome' },
    { name: 'edge', mac: 'Microsoft Edge', win: 'Microsoft\\Edge', linux: 'microsoft-edge' },
    { name: 'brave', mac: 'BraveSoftware/Brave-Browser', win: 'BraveSoftware\\Brave-Browser', linux: 'BraveSoftware/Brave-Browser' },
    { name: 'opera', mac: 'com.operasoftware.Opera', win: 'Opera Software\\Opera Stable', linux: 'opera' },
    { name: 'firefox', mac: 'Firefox', win: 'Mozilla\\Firefox', linux: 'mozilla/firefox' },
  ];

  for (const b of browsers) {
    let checkPath;
    if (isMac) checkPath = path.join(homeDir, 'Library/Application Support', b.mac);
    else if (isWin) checkPath = path.join(process.env.LOCALAPPDATA || '', b.win);
    else if (isLinux) checkPath = path.join(homeDir, '.config', b.linux);
    if (checkPath && fs.existsSync(checkPath)) {
      console.log(`[cookies] Detected browser: ${b.name}`);
      return b.name;
    }
  }
  console.log('[cookies] No supported browser detected, cookies disabled');
  return null;
}

const DETECTED_BROWSER = detectBrowser();
const COOKIES_ARGS = DETECTED_BROWSER ? ['--cookies-from-browser', DETECTED_BROWSER] : [];

function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [...COOKIES_ARGS, '--get-title', '--get-duration', '-s', url]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr));
      const lines = stdout.trim().split('\n');
      const title = lines[0] || 'audio';
      const durationStr = lines[1] || '0';
      // Parse duration: "3:12:45" or "12:45" or "45"
      const parts = durationStr.split(':').map(Number);
      let duration = 0;
      if (parts.length === 3) duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
      else if (parts.length === 2) duration = parts[0] * 60 + parts[1];
      else duration = parts[0];
      resolve({ title, duration });
    });
  });
}

function downloadSegment(url, start, end, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'bestaudio',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '192K',
      '--newline',
      '--no-mtime',
      '-o', outputPath.replace('.mp3', '.%(ext)s'),
      '--download-sections', `*${start}-${end}`,
      '--force-keyframes-at-cuts',
      url,
    ];

    const proc = spawn('yt-dlp', args);
    let stderr = '';
    const progress = { percent: 0, phase: '준비 중...' };

    proc.stdout.on('data', (d) => {
      const line = d.toString();
      const dlMatch = line.match(/\[download\]\s+([\d.]+)%/);
      if (dlMatch) {
        progress.percent = parseFloat(dlMatch[1]);
        progress.phase = `다운로드 ${Math.round(progress.percent)}%`;
      }
      const fragMatch = line.match(/Fragment\s+(\d+)\s*\/\s*(\d+)/i);
      if (fragMatch) {
        progress.percent = (parseInt(fragMatch[1]) / parseInt(fragMatch[2])) * 100;
        progress.phase = `다운로드 ${fragMatch[1]}/${fragMatch[2]} 조각`;
      }
      if (line.includes('[ExtractAudio]')) {
        progress.percent = 95;
        progress.phase = 'MP3 변환 중...';
      }
    });

    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.slice(0, 300)));
      const actual = findOutputFile(outputPath) || outputPath;
      if (!fs.existsSync(actual)) return reject(new Error('파일 생성 실패'));
      resolve({ path: actual, progress });
    });

    // Expose progress getter
    resolve.__progress = progress;
    // Store reference for progress tracking
    downloadSegment._currentProgress = progress;
  });
}

// ===== Single download =====
app.post('/download', (req, res) => {
  const { url, start, end } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const jobId = crypto.randomBytes(8).toString('hex');
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `yt-mp3-${jobId}.mp3`);

  const job = {
    id: jobId,
    status: 'downloading',
    progress: 0,
    phase: '준비 중...',
    filePath: tmpFile,
    filename: 'audio.mp3',
    createdAt: Date.now(),
  };
  jobs.set(jobId, job);

  // Get title
  const titleProc = spawn('yt-dlp', [...COOKIES_ARGS, '--get-title', url]);
  let title = '';
  titleProc.stdout.on('data', (d) => { title += d.toString().trim(); });
  titleProc.on('close', () => {
    const safeName = (title || 'audio').replace(/[^a-zA-Z0-9가-힣\s\-_]/g, '').trim().slice(0, 100);
    job.filename = `${safeName}.mp3`;
  });

  const args = [
    ...COOKIES_ARGS,
    '-f', 'bestaudio',
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '192K',
    '--newline',
    '--no-mtime',
    '-o', tmpFile.replace('.mp3', '.%(ext)s'),
  ];

  const startSec = (start !== undefined && start !== null) ? start : 0;
  const needsTrim = startSec > 0 || (end !== undefined && end !== null);

  if (needsTrim) {
    if (end !== undefined && end !== null) {
      args.push('--download-sections', `*${startSec}-${end}`);
    } else {
      args.push('--download-sections', `*${startSec}-inf`);
    }
    args.push('--force-keyframes-at-cuts');
  }

  args.push(url);
  console.log(`[job:${jobId}] yt-dlp ${args.join(' ')}`);

  const proc = spawn('yt-dlp', args);
  let stderr = '';
  const startTime = Date.now();

  proc.stdout.on('data', (d) => {
    const line = d.toString();
    console.log(line.trimEnd());

    const dlMatch = line.match(/\[download\]\s+([\d.]+)%/);
    if (dlMatch) {
      job.progress = Math.min(parseFloat(dlMatch[1]) * 0.85, 85);
      job.phase = `다운로드 ${Math.round(job.progress)}%`;
      return;
    }
    const fragMatch = line.match(/Fragment\s+(\d+)\s*\/\s*(\d+)/i);
    if (fragMatch) {
      const cur = parseInt(fragMatch[1]), tot = parseInt(fragMatch[2]);
      job.progress = Math.min((cur / tot) * 85, 85);
      job.phase = `다운로드 ${cur}/${tot} 조각`;
      return;
    }
    if (line.includes('[download] Destination:')) {
      job.progress = 5;
      job.phase = '다운로드 시작됨...';
    }
    if (line.includes('[ExtractAudio]')) {
      job.progress = 90;
      job.phase = 'MP3 변환 중...';
    } else if (line.includes('[download] 100%')) {
      job.progress = 85;
      job.phase = '다운로드 완료, 변환 준비...';
    }
  });

  const progressTimer = setInterval(() => {
    if (job.status !== 'downloading') { clearInterval(progressTimer); return; }
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    if (job.progress <= 5) {
      job.phase = `다운로드 중... ${mins}분 ${secs}초 경과`;
    }
  }, 3000);

  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  proc.on('close', (code) => {
    clearInterval(progressTimer);
    if (code !== 0) {
      console.error(`[job:${jobId}] error: ${stderr}`);
      job.status = 'error';
      job.phase = '다운로드 실패';
      job.error = stderr.slice(0, 300);
      return;
    }
    const actualFile = findOutputFile(tmpFile);
    if (actualFile) job.filePath = actualFile;
    else if (!fs.existsSync(tmpFile)) {
      job.status = 'error';
      job.phase = '파일을 찾을 수 없습니다';
      return;
    }
    const stat = fs.statSync(job.filePath);
    job.status = 'done';
    job.progress = 100;
    job.phase = '완료!';
    job.fileSize = stat.size;
    console.log(`[job:${jobId}] done: ${job.filename} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
  });

  res.json({ jobId });
});

// ===== Split download =====
// Strategy: download full audio ONCE → ffmpeg split (instant, no re-encode)
app.post('/download-split', async (req, res) => {
  const { url, splits } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!splits || splits < 2 || splits > 10) return res.status(400).json({ error: 'splits must be 2-10' });

  const jobId = crypto.randomBytes(8).toString('hex');
  const tmpDir = os.tmpdir();
  const fullFile = path.join(tmpDir, `yt-mp3-${jobId}-full.mp3`);

  const job = {
    id: jobId,
    type: 'split',
    status: 'downloading',
    progress: 0,
    phase: '오디오 다운로드 중...',
    currentPart: 0,
    totalParts: splits,
    filename: 'audio',
    filePath: fullFile,
    files: [],
    createdAt: Date.now(),
  };
  jobs.set(jobId, job);
  res.json({ jobId });

  try {
    // Step 1: Get video info (title + duration)
    job.phase = '영상 정보 분석 중...';
    const info = await getVideoInfo(url);
    const safeName = (info.title || 'audio').replace(/[^a-zA-Z0-9가-힣\s\-_]/g, '').trim().slice(0, 100);
    job.filename = safeName;

    console.log(`[job:${jobId}] split: "${safeName}" ${info.duration}s → ${splits} parts`);

    // Step 2: Download full audio (single download, normal progress)
    await new Promise((resolve, reject) => {
      const args = [
        ...COOKIES_ARGS,
        '-f', 'bestaudio',
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '192K',
        '--newline',
        '--no-mtime',
        '-o', fullFile.replace('.mp3', '.%(ext)s'),
        url,
      ];

      console.log(`[job:${jobId}] yt-dlp ${args.join(' ')}`);
      const proc = spawn('yt-dlp', args);
      let stderr = '';
      const startTime = Date.now();

      proc.stdout.on('data', (d) => {
        const line = d.toString();
        console.log(line.trimEnd());

        const dlMatch = line.match(/\[download\]\s+([\d.]+)%/);
        if (dlMatch) {
          // Download is 0-80% of total progress
          job.progress = Math.min(parseFloat(dlMatch[1]) * 0.8, 80);
          job.phase = `오디오 다운로드 ${Math.round(parseFloat(dlMatch[1]))}%`;
          return;
        }
        if (line.includes('[ExtractAudio]')) {
          job.progress = 85;
          job.phase = 'MP3 변환 중...';
        }
        if (line.includes('[download] Destination:')) {
          job.progress = 2;
          job.phase = '오디오 다운로드 시작...';
        }
      });

      const progressTimer = setInterval(() => {
        if (job.status !== 'downloading') { clearInterval(progressTimer); return; }
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        if (job.progress <= 2) {
          job.phase = `오디오 다운로드 중... ${mins}분 ${secs}초 경과`;
        }
      }, 3000);

      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        clearInterval(progressTimer);
        if (code !== 0) return reject(new Error(stderr.slice(0, 300)));

        const actual = findOutputFile(fullFile) || fullFile;
        if (!fs.existsSync(actual)) return reject(new Error('다운로드된 파일을 찾을 수 없습니다'));
        job.filePath = actual;
        resolve();
      });
    });

    console.log(`[job:${jobId}] full audio downloaded, splitting with ffmpeg...`);

    // Step 3: Split with ffmpeg (instant, -c copy = no re-encoding)
    job.progress = 88;
    job.phase = `${splits}개로 분할 중...`;

    const segmentDuration = Math.ceil(info.duration / splits);

    for (let i = 0; i < splits; i++) {
      const partNum = i + 1;
      const segStart = i * segmentDuration;
      const segEnd = Math.min((i + 1) * segmentDuration, info.duration);
      const partFile = path.join(tmpDir, `yt-mp3-${jobId}-part${partNum}.mp3`);

      job.currentPart = partNum;
      job.phase = `분할 중... 파트 ${partNum}/${splits}`;
      job.progress = 88 + (partNum / splits) * 12;

      await new Promise((resolve, reject) => {
        const ffArgs = [
          '-i', job.filePath,
          '-ss', String(segStart),
          '-to', String(segEnd),
          '-c', 'copy',
          '-y',
          partFile,
        ];

        console.log(`[job:${jobId}] ffmpeg split part ${partNum}: ${segStart}s-${segEnd}s`);
        const proc = spawn('ffmpeg', ffArgs);
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
          if (code !== 0) return reject(new Error(`ffmpeg 분할 실패 part${partNum}: ${stderr.slice(0, 200)}`));
          if (!fs.existsSync(partFile)) return reject(new Error(`파트 ${partNum} 파일 생성 실패`));
          resolve();
        });
      });

      const stat = fs.statSync(partFile);
      job.files.push({
        part: partNum,
        path: partFile,
        filename: `${safeName}(${partNum}).mp3`,
        size: stat.size,
      });

      console.log(`[job:${jobId}] part ${partNum} done: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
    }

    // Clean up full file
    fs.unlink(job.filePath, () => {});

    job.status = 'done';
    job.progress = 100;
    job.phase = `${splits}개 파트 완료!`;
    console.log(`[job:${jobId}] all ${splits} parts done`);

  } catch (err) {
    console.error(`[job:${jobId}] split error: ${err.message}`);
    job.status = 'error';
    job.phase = err.message;
    job.error = err.message;
  }
});

// ===== Download split file by part =====
app.get('/file/:id/:part?', (req, res) => {
  const jobId = req.params.id;
  const partNum = req.params.part ? parseInt(req.params.part) : null;
  const job = jobs.get(jobId);

  if (!job || job.status !== 'done') {
    return res.status(404).json({ error: 'File not ready' });
  }

  // Split download - get specific part
  if (job.type === 'split' && partNum) {
    const file = job.files.find(f => f.part === partNum);
    if (!file || !fs.existsSync(file.path)) {
      return res.status(404).json({ error: `Part ${partNum} not found` });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition',
      `attachment; filename="audio.mp3"; filename*=UTF-8''${encodeURIComponent(file.filename)}`
    );
    res.setHeader('Content-Length', file.size);
    const stream = fs.createReadStream(file.path);
    stream.pipe(res);
    // Clean up this part after download
    stream.on('end', () => {
      fs.unlink(file.path, () => {});
      file.downloaded = true;
      // If all parts downloaded, clean up job
      if (job.files.every(f => f.downloaded)) {
        jobs.delete(jobId);
      }
    });
    return;
  }

  // Single download
  if (!fs.existsSync(job.filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const stat = fs.statSync(job.filePath);
  const filename = job.filename || 'audio.mp3';

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition',
    `attachment; filename="audio.mp3"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.setHeader('Content-Length', stat.size);

  const stream = fs.createReadStream(job.filePath);
  stream.pipe(res);
  stream.on('end', () => {
    cleanupJobFiles(job);
    jobs.delete(jobId);
  });
});

// ===== Progress SSE =====
app.get('/progress/:id', (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  req.setTimeout(0);
  res.setTimeout(0);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.write(':heartbeat\n\n');

  const heartbeat = setInterval(() => { res.write(':heartbeat\n\n'); }, 15000);

  const interval = setInterval(() => {
    const data = JSON.stringify({
      status: job.status,
      progress: job.progress,
      phase: job.phase,
      error: job.error,
      filename: job.filename,
      type: job.type,
      currentPart: job.currentPart,
      totalParts: job.totalParts,
      files: job.files ? job.files.map(f => ({ part: f.part, filename: f.filename, size: f.size })) : undefined,
    });
    res.write(`data: ${data}\n\n`);

    if (job.status === 'done' || job.status === 'error') {
      clearInterval(interval);
      clearInterval(heartbeat);
      res.end();
    }
  }, 500);

  req.on('close', () => {
    clearInterval(interval);
    clearInterval(heartbeat);
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`YT MP3 Server running on http://localhost:${PORT}`);
});
