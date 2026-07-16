const crypto = require('crypto');

function registerGet(app, paths, handler) {
  for (const routePath of paths) app.get(routePath, handler);
}

function registerPost(app, paths, handler) {
  for (const routePath of paths) app.post(routePath, handler);
}

function registerPlaudMeetingRoutes(app, deps) {
  const {
    jobs,
    plaudHeadless,
    plaudFileRowSelector,
    getPlaudContext,
    getPlaudPageSignals,
    listPlaudFilesWithFallback,
    exportExistingPlaudFile,
    plaudCli,
    plaudDownloadDir,
    plaudGeneratedTimeoutMs,
    ensureDir,
    safeFilename,
    uniqueFilePath,
    fileTitleFromJob,
    humanElapsed,
  } = deps;

  function cliFallbackWarning(scope, err) {
    const detail = err && err.message
      ? `: ${err.message.replace(/\s+/g, ' ').slice(0, 200)}`
      : '';
    console.warn(`[plaud:meeting] Official CLI ${scope} unavailable; falling back to Playwright${detail}`);
  }

  function cliListItem(file, meta = null) {
    const name = meta && meta.name ? meta.name : file.name;
    return {
      name,
      duration: file.duration,
      date: file.date,
      generating: false,
      generated: Boolean(meta && meta.transcriptAvailable),
      text: `${name} ${file.date || ''} ${file.duration || ''}`.trim(),
    };
  }

  async function listPlaudFilesWithCli(limit) {
    const pageSize = Math.max(10, Math.min(100, limit));
    const files = await plaudCli.listFiles(1, pageSize);
    const expanded = [];

    for (const file of files.slice(0, limit)) {
      if (/(?:\u2026|\.\.\.)$/.test(file.name)) {
        const meta = await plaudCli.getFileMeta(file.id);
        expanded.push(cliListItem(file, meta));
      } else {
        expanded.push(cliListItem(file));
      }
    }
    return expanded;
  }

  async function exportExistingPlaudFileWithCli(job, includeNote) {
    const title = fileTitleFromJob(job);
    job.progress = 92;
    job.phase = 'PLAUD CLI에서 대상 회의 녹음을 찾는 중...';

    const file = await plaudCli.findRecentByTitle(title, 0);
    if (!file) throw new Error('PLAUD CLI 파일 목록에서 대상 회의를 찾지 못했습니다.');

    job.plaudFileId = file.id;
    job.progress = 93;
    job.phase = 'PLAUD CLI에서 transcript 생성 상태를 확인하는 중...';
    const meta = await plaudCli.waitForTranscriptReady(file.id, {
      timeoutMs: plaudGeneratedTimeoutMs,
      pollIntervalMs: 30000,
      onPoll: ({ elapsedMs }) => {
        job.progress = 94;
        job.phase = `PLAUD Generated 대기 중... (${humanElapsed(elapsedMs)})`;
      },
    });

    job.status = 'exporting';
    job.progress = 96;
    job.phase = 'PLAUD CLI로 Transcript 다운로드 중...';
    ensureDir(plaudDownloadDir);
    const transcriptPath = uniqueFilePath(
      plaudDownloadDir,
      `${safeFilename(title, 'transcript')}.txt`
    );
    job.downloadPath = await plaudCli.fetchTranscript(file.id, transcriptPath);

    if (!includeNote) return;
    if (!meta.summaryAvailable) {
      job.noteError = 'PLAUD summary가 아직 생성되지 않았습니다. Generate 버튼은 자동으로 누르지 않습니다.';
      return;
    }

    const summaryPath = uniqueFilePath(
      plaudDownloadDir,
      `${safeFilename(title, 'summary')}-summary.txt`
    );
    job.progress = 98;
    job.phase = 'PLAUD CLI로 Note/Summary 다운로드 중...';
    job.notePath = await plaudCli.fetchSummary(file.id, summaryPath);
  }

  // Meeting-end flow only: read existing PLAUD records and export artifacts.
  // This route group must never import/upload audio or click paid Generate actions.
  registerPost(app, ['/meeting/plaud/export-existing', '/plaud/export-existing'], (req, res) => {
    const { title, includeNote = false, visible = false } = req.body;
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'title is required' });
    }

    const jobId = crypto.randomBytes(8).toString('hex');
    const job = {
      id: jobId,
      type: 'plaud',
      flow: 'meeting-export',
      status: 'exporting',
      progress: 90,
      phase: includeNote
        ? '기존 PLAUD 파일에서 transcript/note export 준비 중...'
        : '기존 PLAUD 파일에서 transcript export 준비 중...',
      filename: `${title}.mp3`,
      plaudTitle: title,
      includeNote: Boolean(includeNote),
      keepFile: true,
      createdAt: Date.now(),
    };

    jobs.set(jobId, job);
    res.json({ jobId });

    (async () => {
      try {
        if (visible) {
          await exportExistingPlaudFile(job, Boolean(includeNote), { visible: true });
        } else {
          const recoveryMode = plaudCli.selectPlaudRecoveryMode(await plaudCli.cliAvailable());
          if (recoveryMode === 'cli') {
            try {
              await exportExistingPlaudFileWithCli(job, Boolean(includeNote));
            } catch (err) {
              cliFallbackWarning('export', err);
              await exportExistingPlaudFile(job, Boolean(includeNote));
            }
          } else {
            cliFallbackWarning('export');
            await exportExistingPlaudFile(job, Boolean(includeNote));
          }
        }
        job.status = 'done';
        job.progress = 100;
        if (includeNote && job.notePath) {
          job.phase = `Transcript/Note 다운로드 완료: ${job.downloadPath} / ${job.notePath}`;
        } else if (includeNote && job.noteError) {
          job.phase = `Transcript 다운로드 완료, Note export 실패: ${job.noteError}`;
        } else {
          job.phase = `Transcript 다운로드 완료: ${job.downloadPath}`;
        }
      } catch (err) {
        console.error(`[job:${job.id}] plaud meeting export error: ${err.message}`);
        job.status = 'error';
        job.phase = err.message;
        job.error = err.message;
      }
    })();
  });

  // Read recent PLAUD files without exporting, generating, or mutating anything.
  registerGet(app, ['/meeting/plaud/list', '/plaud/list'], async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10) || 20, 1), 50);
    const visible = /^(1|true|yes|on)$/i.test(String(req.query.visible || ''));

    try {
      if (!visible) {
        const recoveryMode = plaudCli.selectPlaudRecoveryMode(await plaudCli.cliAvailable());
        if (recoveryMode === 'cli') {
          try {
            const files = await listPlaudFilesWithCli(limit);
            return res.json({
              files,
              mode: 'cli',
              status: { cliAvailable: true, authenticated: true, fileCount: files.length },
            });
          } catch (err) {
            cliFallbackWarning('list', err);
          }
        } else {
          cliFallbackWarning('list');
        }
      }

      const { files, headless, status } = await listPlaudFilesWithFallback(limit, { visible });
      res.json({ files, mode: headless ? 'headless' : 'visible', status });
    } catch (err) {
      console.error(`[plaud:meeting] list error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Read only sanitized PLAUD browser state for troubleshooting.
  registerGet(app, ['/meeting/plaud/status', '/plaud/status'], async (req, res) => {
    const visible = /^(1|true|yes|on)$/i.test(String(req.query.visible || ''));
    const headless = visible ? false : plaudHeadless;

    try {
      if (!visible) {
        const recoveryMode = plaudCli.selectPlaudRecoveryMode(await plaudCli.cliAvailable());
        if (recoveryMode === 'cli') {
          return res.json({
            mode: 'cli',
            status: { cliAvailable: true, authenticated: true },
          });
        }
        cliFallbackWarning('status');
      }

      const context = await getPlaudContext({ headless, forceNew: true });
      try {
        const page = context.pages()[0] || await context.newPage();
        page.setDefaultTimeout(30000);
        await page.goto('https://web.plaud.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await Promise.race([
          page.locator(plaudFileRowSelector).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => null),
          page.getByText(/최근\s*파일|Recent files|로그인|Sign in|Log in/i).first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => null),
          page.waitForTimeout(8000),
        ]);
        const status = await getPlaudPageSignals(page);
        res.json({ mode: headless ? 'headless' : 'visible', status });
      } finally {
        await context.close().catch(() => {});
      }
    } catch (err) {
      console.error(`[plaud:meeting] status error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Open the persistent PLAUD automation browser so the user can log in once.
  registerGet(app, ['/meeting/plaud/login', '/plaud/login'], async (_req, res) => {
    try {
      const context = await getPlaudContext({ headless: false, forceNew: true });
      const page = context.pages()[0] || await context.newPage();
      page.setDefaultTimeout(30000);
      await page.goto('https://web.plaud.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.bringToFront().catch(() => {});
      const status = await getPlaudPageSignals(page);
      res.json({
        ok: true,
        mode: 'visible',
        status,
        message: 'PLAUD automation browser is open. Log in there if needed, then run /meeting/plaud/status or 회의끝 again.',
      });
    } catch (err) {
      console.error(`[plaud:meeting] login open error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  registerPlaudMeetingRoutes,
};
