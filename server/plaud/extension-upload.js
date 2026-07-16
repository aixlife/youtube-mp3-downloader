const fs = require('fs');
const path = require('path');
const { spawnInsightProcessor } = require('./insight');

function createPlaudExtensionUpload(deps) {
  const {
    cookiesArgs,
    plaudQueueDir,
    plaudMaxSeconds,
    plaudLoginWaitMs,
    plaudPostSelectWaitMs,
    plaudImportTimeoutMs,
    plaudGeneratedTimeoutMs,
    plaudDownloadDir,
    plaudHeadlessLoginWaitMs,
    plaudHeadless,
    plaudVisibleOnError,
    plaudCli,
    ensureDir,
    safeFilename,
    uniqueFilePath,
    fileTitleFromJob,
    humanElapsed,
    getPlaudContext,
    resetPlaudContext,
    closePlaudContext,
    visibleCount,
    clickVisible,
    findVisibleLocator,
    waitForPlaudGenerated,
    exportPlaudTranscript,
    getVideoInfo,
    findOutputFile,
    runYtDlpWithCookieFallback,
  } = deps;

  function buildYtDlpArgs(url, outputPath, start, end) {
    const args = [
      ...cookiesArgs,
      '-f', 'bestaudio[ext=m4a]/bestaudio',
      '--newline',
      '--no-mtime',
      '-o', outputPath.replace(path.extname(outputPath), '.%(ext)s'),
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
    return args;
  }

  function findPlaudUploadOutputFile(basePath) {
    const dir = path.dirname(basePath);
    const base = path.basename(basePath, path.extname(basePath));
    const preferredExts = ['.m4a', '.mp4', '.aac', '.mp3', '.webm', '.opus', '.wav'];
    try {
      const files = fs.readdirSync(dir)
        .filter((file) => file.startsWith(base))
        .sort((a, b) => preferredExts.indexOf(path.extname(a).toLowerCase()) - preferredExts.indexOf(path.extname(b).toLowerCase()));
      const found = files.find((file) => preferredExts.includes(path.extname(file).toLowerCase()));
      if (found) return path.join(dir, found);
    } catch {}
    return null;
  }

  function moveJobFile(job, bucket) {
    if (!job.filePath || !fs.existsSync(job.filePath)) return;
    const bucketDir = path.join(plaudQueueDir, bucket);
    const nextPath = uniqueFilePath(bucketDir, path.basename(job.filePath));
    fs.renameSync(job.filePath, nextPath);
    job.filePath = nextPath;
  }

  async function setAnyFileInput(page, filePath) {
    const inputs = page.locator('input[type="file"]');
    const count = await inputs.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);
      try {
        await input.setInputFiles(filePath, { timeout: 5000 });
        return true;
      } catch {}
    }
    return false;
  }

  function addAudioCandidates(page) {
    return [
      page.getByText(/^Add audio$/i),
      page.getByRole('button', { name: /^Add audio$/i }),
      page.locator('[aria-label="Add audio" i], [title="Add audio" i]'),
    ];
  }

  function importMenuCandidates(page) {
    return [
      page.locator('[data-testid="new-recording-import-item"]'),
      page.getByText(/^Import audio$/i),
      page.getByRole('menuitem', { name: /^Import audio$/i }),
      page.locator('[aria-label="Import audio" i], [title="Import audio" i]'),
    ];
  }

  function uploadDropzoneCandidates(page) {
    return [
      page.getByText(/click or drag audio files to upload/i),
      page.getByText(/drag audio files/i),
      page.locator('[data-testid*="upload" i], [data-testid*="import" i]').filter({ hasText: /audio|file|upload|drag/i }),
      page.locator('.el-upload, .el-upload-dragger, [class*="upload" i], [class*="drop" i]').filter({ hasText: /audio|file|upload|drag/i }),
      page.locator('[class*="upload" i], [class*="drop" i]').filter({ hasText: /audio files/i }),
    ];
  }

  async function clickForFileChooser(page, locator, filePath) {
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null);
    if (!await clickVisible(locator)) return false;
    const chooser = await chooserPromise;
    if (!chooser) return false;
    await chooser.setFiles(filePath);
    return true;
  }

  async function clickImportMenuItem(page) {
    const importAudio = await findVisibleLocator(page, importMenuCandidates(page), 10000);
    if (!importAudio) return false;
    if (await clickVisible(importAudio)) return true;

    return page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const target = Array.from(document.querySelectorAll('[data-testid="new-recording-import-item"], [role="menuitem"], [aria-label="Import audio"]'))
        .filter((el) => visible(el) && /Import audio/i.test(el.getAttribute('aria-label') || el.innerText || el.textContent || ''))[0];
      if (!target) return false;
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    }).catch(() => false);
  }

  async function waitForAnyFileInput(page, filePath, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await setAnyFileInput(page, filePath)) return true;
      await page.waitForTimeout(500);
    }
    return false;
  }

  async function waitForImportComplete(page, job) {
    const title = fileTitleFromJob(job);
    const startedAt = Date.now();
    let sawUploadActivity = false;

    job.progress = 88;
    job.phase = 'PLAUD 파일 import 완료 대기 중...';

    while (Date.now() - startedAt < plaudImportTimeoutMs) {
      const state = await page.evaluate((needle) => {
        const norm = (value) => (value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };

        const text = norm(document.body.innerText || document.body.textContent || '');
        const importDialog = Array.from(document.querySelectorAll('[role="dialog"], .el-dialog, [class*="dialog"], [class*="modal"]'))
          .filter((el) => visible(el) && /Import audio|upload/i.test(el.innerText || el.textContent || ''))[0];
        const fileRows = Array.from(document.querySelectorAll('li.file-list-item, [data-testid^="file-list-item-"], [role="listitem"], [class*="file-list-item"]'))
          .filter((el) => visible(el))
          .map((el) => norm(el.innerText || el.textContent))
          .filter(Boolean);
        const matchingRow = fileRows.find((rowText) => rowText.includes(needle));

        return {
          imported: /Imported|Import complete|Upload complete|Uploaded|Success/i.test(text),
          processing: /Uploading|Importing|Processing|Transcribing|Generating|Summarizing/i.test(text),
          failed: /Upload failed|Import failed|Network error|Failed to upload|Try again/i.test(text),
          hasImportDialog: Boolean(importDialog),
          hasMatchingRow: Boolean(matchingRow),
        };
      }, title.normalize('NFC').slice(0, Math.min(32, title.length))).catch(() => null);

      if (state && state.failed) {
        throw new Error('PLAUD 파일 import가 실패했습니다. 네트워크 상태나 PLAUD 로그인 상태를 확인한 뒤 다시 시도하세요.');
      }

      if (state && (state.processing || state.imported || state.hasMatchingRow)) {
        sawUploadActivity = true;
      }

      if (state && (state.imported || state.hasMatchingRow || (sawUploadActivity && !state.hasImportDialog))) {
        job.progress = 90;
        job.phase = 'PLAUD 파일 import 완료 확인!';
        return;
      }

      const elapsed = humanElapsed(Date.now() - startedAt);
      job.progress = 88;
      job.phase = sawUploadActivity
        ? `PLAUD 업로드/Import 처리 중... (${elapsed})`
        : `PLAUD 업로드 시작 대기 중... (${elapsed})`;
      await page.waitForTimeout(5000);
    }

    throw new Error(`PLAUD 파일 import 대기 시간이 초과되었습니다. (${humanElapsed(plaudImportTimeoutMs)})`);
  }

  async function closeImportDialog(page) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);

    if (!await visibleCount(page.getByText(/Click or drag audio files to upload/i))) return;

    await page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .el-dialog, [class*="dialog"], [class*="modal"]'))
        .filter((el) => visible(el) && /Import audio/i.test(el.innerText || ''));
      const dialog = dialogs.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      })[0];
      if (!dialog) return false;

      const rect = dialog.getBoundingClientRect();
      const candidates = Array.from(dialog.querySelectorAll('button, [role="button"], [class*="close"], svg, span, i'))
        .filter(visible)
        .map((el) => {
          const r = el.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          return {
            el,
            score: Math.abs(x - (rect.right - 24)) + Math.abs(y - (rect.top + 24)),
          };
        })
        .sort((a, b) => a.score - b.score);
      const target = candidates[0] && candidates[0].el;
      if (!target) return false;
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    }).catch(() => false);

    await page.waitForTimeout(1000);
  }

  async function choosePlaudFile(page, filePath, job, options = {}) {
    const loginWaitMs = options.loginWaitMs ?? plaudLoginWaitMs;

    if (await setAnyFileInput(page, filePath)) return;

    if (await visibleCount(page.getByText(/click or drag audio files to upload/i)) === 0) {
      const addAudio = await findVisibleLocator(page, addAudioCandidates(page), loginWaitMs);
      if (!addAudio) {
        throw new Error('PLAUD Web에서 Add audio 버튼을 찾지 못했습니다. 열린 브라우저에서 로그인한 뒤 다시 시도하세요.');
      }

      job.progress = 80;
      job.phase = 'PLAUD Add audio 메뉴 여는 중...';

      if (!await clickVisible(addAudio)) {
        throw new Error('PLAUD Add audio 버튼을 클릭하지 못했습니다.');
      }
      await page.waitForTimeout(500);

      if (await waitForAnyFileInput(page, filePath, 1500)) return;

      if (!await clickImportMenuItem(page)) {
        throw new Error('PLAUD Import audio 메뉴를 찾지 못했습니다.');
      }

      job.progress = 82;
      job.phase = 'PLAUD Import audio 메뉴 클릭 중...';
      if (await waitForAnyFileInput(page, filePath, 5000)) return;
    }

    if (await waitForAnyFileInput(page, filePath, 3000)) return;

    const dropzone = await findVisibleLocator(page, uploadDropzoneCandidates(page), 10000);
    if (dropzone) {
      job.progress = 84;
      job.phase = 'PLAUD 파일 업로드 영역 클릭 중...';
      if (await clickForFileChooser(page, dropzone, filePath)) return;
      if (await waitForAnyFileInput(page, filePath, 3000)) return;
    }

    if (await waitForAnyFileInput(page, filePath, 3000)) return;
    throw new Error('PLAUD 파일 선택 창을 열지 못했습니다. Import audio 모달의 업로드 영역을 수동으로 눌러야 할 수 있습니다.');
  }

  function shouldRetryPlaudVisible(err) {
    if (!plaudVisibleOnError || !plaudHeadless) return false;
    const message = err && err.message ? err.message : '';
    return /Add audio|Import audio|파일 선택|Target page|Timeout|로그인/i.test(message);
  }

  function cliFallbackWarning(err) {
    const detail = err && err.message
      ? `: ${err.message.replace(/\s+/g, ' ').slice(0, 200)}`
      : '';
    console.warn(`[plaud] Official CLI recovery unavailable; falling back to Playwright${detail}`);
  }

  async function recoverPlaudWithCli(job) {
    const title = fileTitleFromJob(job);
    const sinceEpochMs = job.plaudLookupSinceMs || job.createdAt || 0;

    job.progress = 92;
    job.phase = 'PLAUD CLI에서 업로드한 파일 ID를 찾는 중...';
    const file = await plaudCli.waitForRecentByTitle(title, sinceEpochMs, {
      timeoutMs: plaudImportTimeoutMs,
      pollIntervalMs: 30000,
      onPoll: ({ elapsedMs }) => {
        job.progress = 92;
        job.phase = `PLAUD CLI 파일 목록 반영 대기 중... (${humanElapsed(elapsedMs)})`;
      },
    });

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

    job.progress = 95;
    job.phase = 'PLAUD Generated 완료 확인!';
    job.status = 'exporting';
    ensureDir(plaudDownloadDir);

    const transcriptPath = uniqueFilePath(
      plaudDownloadDir,
      `${safeFilename(title, 'transcript')}.txt`
    );
    job.progress = 98;
    job.phase = 'PLAUD CLI로 Transcript 다운로드 중...';
    job.downloadPath = await plaudCli.fetchTranscript(file.id, transcriptPath);

    if (job.includeNote) {
      if (!meta.summaryAvailable) {
        job.noteError = 'PLAUD summary가 아직 생성되지 않았습니다. Generate 버튼은 자동으로 누르지 않습니다.';
      } else {
        const summaryPath = uniqueFilePath(
          plaudDownloadDir,
          `${safeFilename(title, 'summary')}-summary.txt`
        );
        job.phase = 'PLAUD CLI로 Note/Summary 다운로드 중...';
        job.notePath = await plaudCli.fetchSummary(file.id, summaryPath);
      }
    }
  }

  async function exportPlaudWithPlaywright(context, page, job) {
    const generatedInList = await waitForPlaudGenerated(page, job);
    await exportPlaudTranscript(page, job, { verifyDetailGenerated: !generatedInList, allowGenerate: false });
    await closePlaudContext(context);
  }

  async function openPlaudRecoveryPage(headless) {
    const context = await getPlaudContext({ headless, forceNew: true });
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(30000);
    return { context, page };
  }

  async function openPlaudUploadPage(job, headless) {
    job.status = 'uploading';
    job.progress = 75;
    job.phase = headless
      ? 'PLAUD Web 백그라운드로 여는 중...'
      : 'PLAUD Web 여는 중...';

    const context = await getPlaudContext({ headless });
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(30000);

    await page.goto('https://app.plaud.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    job.progress = 78;
    job.phase = 'PLAUD Web 준비 중... 로그인 창이 보이면 로그인하세요.';

    await choosePlaudFile(page, job.filePath, job, {
      loginWaitMs: headless ? plaudHeadlessLoginWaitMs : plaudLoginWaitMs,
    });

    job.plaudLookupSinceMs = Date.now() - 60000;
    return { context, page, headless };
  }

  async function startPlaudUploadPage(job) {
    try {
      return await openPlaudUploadPage(job, plaudHeadless);
    } catch (err) {
      if (!shouldRetryPlaudVisible(err)) throw err;

      console.warn(`[plaud] Headless upload setup failed, retrying visible browser: ${err.message}`);
      job.phase = '백그라운드 PLAUD 준비 실패. 로그인/확인을 위해 브라우저를 표시합니다.';
      await resetPlaudContext();
      return openPlaudUploadPage(job, false);
    }
  }

  async function uploadToPlaud(job) {
    let { context, page, headless } = await startPlaudUploadPage(job);

    job.progress = 90;
    job.phase = 'PLAUD에 파일을 전달했습니다. 업로드 시작을 기다리는 중...';
    await page.waitForTimeout(plaudPostSelectWaitMs);

    await waitForImportComplete(page, job);
    await closeImportDialog(page);

    const recoveryMode = plaudCli.selectPlaudRecoveryMode(await plaudCli.cliAvailable());
    if (recoveryMode === 'cli') {
      await closePlaudContext(context).catch(() => {});
      context = null;
      page = null;
      try {
        await recoverPlaudWithCli(job);
      } catch (err) {
        cliFallbackWarning(err);
        job.status = 'uploading';
        ({ context, page } = await openPlaudRecoveryPage(headless));
        await exportPlaudWithPlaywright(context, page, job);
      }
    } else {
      cliFallbackWarning();
      await exportPlaudWithPlaywright(context, page, job);
    }

    job.keepFile = true;
    job.status = 'done';
    job.progress = 100;
    job.phase = `Transcript 다운로드 완료: ${job.downloadPath}`;

    if (spawnInsightProcessor(job.downloadPath, fileTitleFromJob(job), job.plaudFileId)) {
      job.phase += ' (인사이트 노트 생성 중 — Obsidian insights/videos/)';
    }
  }

  async function runPlaudJob(job, url, start, end) {
    try {
      ensureDir(plaudQueueDir);

      job.phase = '영상 정보 분석 중...';
      const info = await getVideoInfo(url);
      const startSec = (start !== undefined && start !== null) ? Number(start) : 0;
      const endSec = (end !== undefined && end !== null) ? Number(end) : info.duration;
      const segmentSeconds = Math.max(0, endSec - startSec);

      if (segmentSeconds > plaudMaxSeconds) {
        throw new Error('PLAUD Web import는 최대 5시간까지 지원합니다. 구간을 줄여서 다시 보내세요.');
      }

      const filename = `${safeFilename(info.title)}.m4a`;
      const targetPath = uniqueFilePath(plaudQueueDir, filename);
      job.plaudTitle = safeFilename(info.title);
      job.filename = path.basename(targetPath);
      job.filePath = targetPath;

      const args = buildYtDlpArgs(url, targetPath, start, end);
      const startTime = Date.now();
      const progressTimer = setInterval(() => {
        if (job.status !== 'downloading') { clearInterval(progressTimer); return; }
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        if (job.progress <= 5) {
          job.phase = `오디오 추출 중... ${mins}분 ${secs}초 경과`;
        }
      }, 3000);

      try {
        await runYtDlpWithCookieFallback(args, {
          label: `job:${job.id} plaud`,
          onFallback: () => {
            job.progress = Math.max(job.progress, 6);
            job.phase = '브라우저 쿠키 접근이 403으로 막혀 쿠키 없이 재시도 중...';
          },
          onStdout: (d) => {
            const line = d.toString();
            console.log(line.trimEnd());

            const dlMatch = line.match(/\[download\]\s+([\d.]+)%/);
            if (dlMatch) {
              job.progress = Math.min(parseFloat(dlMatch[1]) * 0.7, 70);
              job.phase = `오디오 다운로드 ${Math.round(job.progress)}%`;
              return;
            }
            const fragMatch = line.match(/Fragment\s+(\d+)\s*\/\s*(\d+)/i);
            if (fragMatch) {
              const cur = parseInt(fragMatch[1]), tot = parseInt(fragMatch[2]);
              job.progress = Math.min((cur / tot) * 70, 70);
              job.phase = `오디오 다운로드 ${cur}/${tot} 조각`;
              return;
            }
            if (line.includes('[download] Destination:')) {
              job.progress = 5;
              job.phase = '오디오 다운로드 시작...';
            }
            if (line.includes('[ExtractAudio]')) {
              job.progress = 72;
              job.phase = '오디오 변환 중...';
            }
          },
        });
      } finally {
        clearInterval(progressTimer);
      }

      const actualFile = findPlaudUploadOutputFile(targetPath) || findOutputFile(targetPath);
      if (actualFile) job.filePath = actualFile;
      if (!fs.existsSync(job.filePath)) throw new Error('PLAUD 업로드용 오디오 파일 생성 실패');
      job.filename = path.basename(job.filePath);

      const stat = fs.statSync(job.filePath);
      job.fileSize = stat.size;
      job.progress = 74;
      job.phase = `오디오 파일 준비 완료 (${(stat.size / 1024 / 1024).toFixed(1)}MB)`;

      await uploadToPlaud(job);
    } catch (err) {
      console.error(`[job:${job.id}] plaud error: ${err.message}`);
      try {
        if (job.filePath && fs.existsSync(job.filePath)) {
          moveJobFile(job, 'failed');
          job.keepFile = true;
        }
      } catch {}
      job.status = 'error';
      job.phase = err.message;
      job.error = err.message;
    }
  }

  return {
    runPlaudJob,
    uploadToPlaud,
  };
}

module.exports = {
  createPlaudExtensionUpload,
};
