const fs = require('fs');
const path = require('path');
const { spawnInsightProcessor } = require('./insight');
const audioSplit = require('./audio-split');
const { mergeTranscripts } = require('./transcript-merge');

function createPlaudExtensionUpload(deps) {
  const {
    cookiesArgs,
    plaudQueueDir,
    plaudMaxSeconds,
    plaudPartTargetSeconds,
    plaudMaxUploadBytes,
    plaudCompressBitrateK,
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

  // 업로드(브라우저)와 전사 수확(CLI)을 분리한 단계. 분할 업로드에서 수확만 병렬로 돌리기 위한 것.
  // 컨텍스트를 닫지 않으므로 다음 파트가 같은 브라우저를 재사용한다.
  async function uploadPartFile(job) {
    const startedAt = Date.now();
    const { page } = await startPlaudUploadPage(job);

    job.progress = 90;
    job.phase = 'PLAUD에 파일을 전달했습니다. 업로드 시작을 기다리는 중...';
    await page.waitForTimeout(plaudPostSelectWaitMs);

    await waitForImportComplete(page, job);
    await closeImportDialog(page);
    console.log(`[plaud-timing] ${fileTitleFromJob(job)} 업로드+import: ${humanElapsed(Date.now() - startedAt)}`);
  }

  // 전사 대기와 다운로드. 브라우저를 쓰지 않아 파트끼리 동시에 돌 수 있다.
  async function harvestPartTranscript(job) {
    const startedAt = Date.now();
    await recoverPlaudWithCli(job);
    job.keepFile = true;
    job.status = 'done';
    job.progress = 100;
    console.log(`[plaud-timing] ${fileTitleFromJob(job)} 전사대기+다운로드: ${humanElapsed(Date.now() - startedAt)}`);
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

    // 분할 파트는 여기서 인사이트를 만들지 않는다. 파트별로 만들면 반쪽짜리 노트가 파트 수만큼 생긴다.
    // 병합된 transcript 하나로 uploadInParts가 마지막에 한 번만 호출한다.
    if (!job.skipInsight && spawnInsightProcessor(job.downloadPath, fileTitleFromJob(job), job.plaudFileId)) {
      job.phase += ' (인사이트 노트 생성 중 — Obsidian insights/videos/)';
    }
  }

  // ===== PLAUD 업로드 한계 대응 =====
  // 길이(5시간)는 분할로만, 용량(500MB)은 모노 재인코딩으로 넘긴다.

  const MB = 1024 * 1024;

  async function ensureUnderSizeLimit(job, filePath, label) {
    let current = filePath;
    let size = fs.statSync(current).size;
    if (size <= plaudMaxUploadBytes) return current;

    // 64kbps 모노면 6시간도 약 170MB. 그래도 넘으면 32kbps로 한 번 더.
    for (const bitrate of [plaudCompressBitrateK, 32]) {
      job.phase = `${label} ${(size / MB).toFixed(0)}MB — 업로드 한계 초과로 모노 ${bitrate}kbps 압축 중...`;
      console.log(`[plaud-size] ${label} ${(size / MB).toFixed(1)}MB > 한계, 모노 ${bitrate}kbps 압축`);

      const compressed = uniqueFilePath(
        plaudQueueDir,
        `${path.basename(current, path.extname(current))} mono${bitrate}.m4a`
      );
      await audioSplit.compressToMono(current, compressed, bitrate);

      fs.unlink(current, () => {});
      current = compressed;
      size = fs.statSync(current).size;
      console.log(`[plaud-size] ${label} 압축 결과 ${(size / MB).toFixed(1)}MB`);
      if (size <= plaudMaxUploadBytes) return current;
    }

    throw new Error(
      `${label}이(가) 압축 후에도 업로드 한계(${Math.round(plaudMaxUploadBytes / MB)}MB)를 넘습니다. (${(size / MB).toFixed(0)}MB)`
    );
  }

  // PLAUD 파일 매칭이 제목 앞 32자로 이뤄지므로 파트 구분자는 반드시 제목 앞에 온다.
  function partJobTitle(baseTitle, partNum) {
    return `${partNum}부 ${baseTitle}`;
  }

  // 파트 업로드는 별도 job으로 돌리되, 진행 상황은 부모 job에 그대로 비친다.
  function createPartJob(parentJob, { partIndex, partCount, filePath, title, spanStart, spanEnd }) {
    const span = (spanEnd - spanStart) / partCount;
    const base = {
      id: `${parentJob.id}-p${partIndex + 1}`,
      type: 'plaud',
      flow: 'extension-upload-part',
      status: 'uploading',
      progress: 0,
      phase: '',
      filename: path.basename(filePath),
      filePath,
      plaudTitle: title,
      includeNote: parentJob.includeNote,
      keepFile: true,
      skipInsight: true,
      // 전사 수확은 파트끼리 동시에 돌기 때문에, 그때 각자 부모 phase를 쓰면 화면이 요동친다.
      // 업로드 단계에서만 미러링하고 수확 단계 진입 시 끈다.
      mirrorToParent: true,
      createdAt: Date.now(),
    };

    return new Proxy(base, {
      set(target, prop, value) {
        target[prop] = value;
        if (!target.mirrorToParent) return true;
        if (prop === 'phase') {
          parentJob.phase = `[파트 ${partIndex + 1}/${partCount}] ${value}`;
        } else if (prop === 'progress' && typeof value === 'number') {
          // uploadToPlaud는 75~100 구간을 쓴다. 파트 구간으로 정규화해 부모에 반영.
          const norm = Math.max(0, Math.min(1, (value - 70) / 30));
          parentJob.progress = spanStart + span * partIndex + norm * span;
        }
        return true;
      },
    });
  }

  async function uploadInParts(job, baseTitle) {
    const PLAN_START = 50;
    const CUT_START = 56;
    const UPLOAD_START = 60;
    const UPLOAD_END = 97;

    const sourcePath = job.filePath;
    const totalSeconds = await audioSplit.probeDuration(sourcePath);

    job.progress = PLAN_START;
    job.phase = 'PLAUD 5시간 한계 초과 — 분할 지점 찾는 중...';

    const { partCount, marks } = await audioSplit.planSplitPoints(
      sourcePath,
      totalSeconds,
      plaudPartTargetSeconds,
      {
        onBoundary: (doneCount, totalCount) => {
          job.progress = PLAN_START + (doneCount / totalCount) * (CUT_START - PLAN_START);
          job.phase = `분할 지점 탐색 ${doneCount}/${totalCount} (말이 끊기지 않게 무음에서 자릅니다)`;
        },
      }
    );

    job.totalParts = partCount;
    job.currentPart = 0;
    console.log(`[job:${job.id}] plaud 자동 분할: ${Math.round(totalSeconds)}s → ${partCount}개 파트`);

    // 1) 파트 파일 생성 — -c copy 스트림 복사라 음질 손실이 없다
    const parts = [];
    for (let i = 0; i < partCount; i++) {
      const partNum = i + 1;
      const title = partJobTitle(baseTitle, partNum);
      const outPath = uniqueFilePath(plaudQueueDir, `${safeFilename(title)}.m4a`);

      job.currentPart = partNum;
      job.progress = CUT_START + (i / partCount) * (UPLOAD_START - CUT_START);
      job.phase = `파트 ${partNum}/${partCount} 잘라내는 중...`;

      await audioSplit.cutSegment(sourcePath, marks[i], marks[i + 1], outPath);
      const readyPath = await ensureUnderSizeLimit(job, outPath, `파트 ${partNum}`);

      parts.push({ partNum, path: readyPath, title, offsetSec: marks[i], endSec: marks[i + 1] });
      console.log(
        `[job:${job.id}] 파트 ${partNum}/${partCount} 준비: ` +
        `${(fs.statSync(readyPath).size / MB).toFixed(1)}MB (${Math.round(marks[i])}s-${Math.round(marks[i + 1])}s)`
      );
    }

    fs.unlink(sourcePath, () => {});

    // 2) 업로드는 순차. 전사 대기(수 분)는 브라우저를 쓰지 않으므로 3)에서 한꺼번에 병렬로 돌린다.
    //    순차로 다 하면 파트1이 전사되는 동안 파트2가 놀고, 브라우저도 파트마다 새로 뜬다.
    const HARVEST_START = 75;
    const cliReady = plaudCli.selectPlaudRecoveryMode(await plaudCli.cliAvailable()) === 'cli';
    if (!cliReady) {
      // CLI가 없으면 전사 수확에도 브라우저가 필요해 병렬이 불가능하다. 기존 순차 경로로 간다.
      console.warn('[plaud] PLAUD CLI를 쓸 수 없어 파트 전사를 순차로 처리합니다.');
    }

    const succeeded = [];
    const failed = [];
    const uploaded = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      job.currentPart = part.partNum;

      const partJob = createPartJob(job, {
        partIndex: i,
        partCount,
        filePath: part.path,
        title: part.title,
        spanStart: UPLOAD_START,
        spanEnd: cliReady ? HARVEST_START : UPLOAD_END,
      });

      try {
        if (cliReady) {
          await uploadPartFile(partJob);
          uploaded.push({ part, partJob });
        } else {
          await uploadToPlaud(partJob);
          succeeded.push({ ...part, transcriptPath: partJob.downloadPath, plaudFileId: partJob.plaudFileId });
          console.log(`[job:${job.id}] 파트 ${part.partNum}/${partCount} 완료: ${partJob.downloadPath}`);
        }
      } catch (err) {
        console.error(`[job:${job.id}] 파트 ${part.partNum}/${partCount} 실패: ${err.message}`);
        failed.push({ partNum: part.partNum, error: err.message });
        try { moveJobFile(partJob, 'failed'); } catch {}
      }
    }

    // 3) 전사 대기 + 다운로드를 파트끼리 동시에
    if (cliReady && uploaded.length) {
      await resetPlaudContext().catch(() => {});  // 업로드가 끝났으니 브라우저를 놓아준다

      let harvested = 0;
      job.progress = HARVEST_START;
      job.phase = `파트 ${uploaded.length}개 전사 대기 중... (0/${uploaded.length} 완료)`;

      const results = await Promise.allSettled(uploaded.map(async ({ partJob }) => {
        partJob.mirrorToParent = false;   // 동시 진행이라 각자 부모 phase를 덮어쓰면 안 된다
        await harvestPartTranscript(partJob);
        harvested += 1;
        job.progress = HARVEST_START + (harvested / uploaded.length) * (UPLOAD_END - HARVEST_START);
        job.phase = `파트 전사 완료 ${harvested}/${uploaded.length}`;
      }));

      results.forEach((result, idx) => {
        const { part, partJob } = uploaded[idx];
        if (result.status === 'fulfilled') {
          succeeded.push({ ...part, transcriptPath: partJob.downloadPath, plaudFileId: partJob.plaudFileId });
          console.log(`[job:${job.id}] 파트 ${part.partNum}/${partCount} 완료: ${partJob.downloadPath}`);
        } else {
          const message = result.reason && result.reason.message ? result.reason.message : '원인 미상';
          console.error(`[job:${job.id}] 파트 ${part.partNum}/${partCount} 전사 실패: ${message}`);
          failed.push({ partNum: part.partNum, error: message });
          try { moveJobFile(partJob, 'failed'); } catch {}
        }
      });

      succeeded.sort((a, b) => a.partNum - b.partNum);   // 병렬 완료 순서가 아니라 시간순으로 병합해야 한다
    }

    if (!succeeded.length) {
      throw new Error(
        `파트 ${partCount}개가 모두 업로드에 실패했습니다. 파일은 PlaudQueue/failed에 있습니다. ` +
        `(${failed[0] ? failed[0].error : '원인 미상'})`
      );
    }

    // 3) transcript 병합 — 이게 없으면 인사이트 후처리기가 앞뒤 반쪽만 읽는다
    job.progress = UPLOAD_END;
    job.phase = `파트 ${succeeded.length}개 transcript 병합 중...`;
    ensureDir(plaudDownloadDir);

    const mergedPath = uniqueFilePath(plaudDownloadDir, `${safeFilename(baseTitle, 'transcript')}.txt`);
    mergeTranscripts(
      succeeded.map((s) => ({ path: s.transcriptPath, offsetSec: s.offsetSec, endSec: s.endSec, partNum: s.partNum })),
      mergedPath,
      { title: baseTitle, totalSeconds, totalParts: partCount }
    );

    job.downloadPath = mergedPath;
    job.plaudTitle = baseTitle;
    job.keepFile = true;
    job.status = 'done';
    job.progress = 100;
    job.phase = failed.length
      ? `${succeeded.length}/${partCount}개 파트만 병합됨: ${mergedPath} — 실패 파트는 PlaudQueue/failed에서 재시도하세요`
      : `${partCount}개 파트 병합 완료: ${mergedPath}`;

    // 파트별 transcript는 내용이 전부 병합본에 들어갔다. 남겨두면 한 영상에 파일이 3개가 되어
    // 나중에 "어느 걸 AI에게 읽혀야 하지"를 매번 판단하게 된다. 한 영상당 파일 하나만 남긴다.
    for (const item of succeeded) {
      if (item.transcriptPath && item.transcriptPath !== mergedPath) {
        fs.unlink(item.transcriptPath, () => {});
      }
    }

    const fileIds = succeeded.map((s) => s.plaudFileId).filter(Boolean).join(',');
    if (spawnInsightProcessor(mergedPath, baseTitle, fileIds || 'split')) {
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

      // 5시간을 넘으면 거절하지 않고 자동 분할한다. 분할 경로는 뒤 작업이 길어 다운로드 진행률 구간을 좁게 잡는다.
      const willSplit = segmentSeconds > plaudMaxSeconds;
      const dlSpan = willSplit ? 48 : 70;
      if (willSplit) {
        console.log(`[job:${job.id}] 길이 ${Math.round(segmentSeconds)}s > 한계 ${plaudMaxSeconds}s → 자동 분할 예정`);
      }

      // 호출자가 제목을 알고 있으면 그걸 쓴다(배치 러너의 큐에는 정확한 원제가 있다).
      // yt-dlp 출력 파싱은 콘솔 인코딩에 좌우되므로 신뢰도가 낮다.
      const baseTitle = safeFilename(job.requestedTitle || info.title);
      const filename = `${baseTitle}.m4a`;
      const targetPath = uniqueFilePath(plaudQueueDir, filename);
      job.plaudTitle = baseTitle;
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
              job.progress = Math.min(parseFloat(dlMatch[1]) * (dlSpan / 100), dlSpan);
              job.phase = `오디오 다운로드 ${Math.round(parseFloat(dlMatch[1]))}%`;
              return;
            }
            const fragMatch = line.match(/Fragment\s+(\d+)\s*\/\s*(\d+)/i);
            if (fragMatch) {
              const cur = parseInt(fragMatch[1]), tot = parseInt(fragMatch[2]);
              job.progress = Math.min((cur / tot) * dlSpan, dlSpan);
              job.phase = `오디오 다운로드 ${cur}/${tot} 조각`;
              return;
            }
            if (line.includes('[download] Destination:')) {
              job.progress = 5;
              job.phase = '오디오 다운로드 시작...';
            }
            if (line.includes('[ExtractAudio]')) {
              job.progress = dlSpan + 2;
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
      job.phase = `오디오 파일 준비 완료 (${(stat.size / MB).toFixed(1)}MB)`;

      if (willSplit) {
        await uploadInParts(job, baseTitle);
      } else {
        job.filePath = await ensureUnderSizeLimit(job, job.filePath, '오디오');
        job.filename = path.basename(job.filePath);
        job.fileSize = fs.statSync(job.filePath).size;
        job.progress = 74;
        await uploadToPlaud(job);
      }
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
