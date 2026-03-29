const SERVER_URL = 'http://localhost:3456';

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function parseTime(str) {
  if (!str || str.trim() === '') return undefined;
  const parts = str.split(':');
  if (parts.length === 2) {
    return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(str);
}

function waitForElement(selectors, maxAttempts = 30) {
  return new Promise((resolve) => {
    let attempts = 0;
    const check = () => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return resolve(el);
      }
      attempts++;
      if (attempts < maxAttempts) {
        setTimeout(check, 500);
      } else {
        resolve(null);
      }
    };
    check();
  });
}

async function createUI() {
  if (document.getElementById('yt-mp3-host')) return;

  const target = await waitForElement([
    'ytd-watch-metadata #owner',
    '#above-the-fold #owner',
    '#owner',
    '#above-the-fold',
    'ytd-watch-metadata',
    '#info',
    '#below',
  ]);

  if (!target) return;

  const host = document.createElement('div');
  host.id = 'yt-mp3-host';
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      :host { display: block; margin-top: 10px; margin-bottom: 6px; }
      .container {
        padding: 10px 14px;
        background: #1e1e1e;
        border: 1px solid #333;
        border-radius: 10px;
        font-family: 'Roboto', Arial, sans-serif;
        font-size: 13px;
        color: #fff;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .row + .row { margin-top: 8px; }
      input {
        width: 58px;
        padding: 5px 6px;
        border: 1px solid #555;
        border-radius: 6px;
        background: #2c2c2c;
        color: #fff;
        font-size: 13px;
        text-align: center;
        outline: none;
      }
      input::placeholder { color: #777; }
      input:focus { border-color: #ff0050; }
      label {
        color: #aaa;
        font-size: 12px;
        white-space: nowrap;
      }
      .cur-btn {
        padding: 3px 8px;
        border: 1px solid #555;
        border-radius: 5px;
        background: transparent;
        color: #999;
        font-size: 11px;
        cursor: pointer;
        white-space: nowrap;
      }
      .cur-btn:hover { border-color: #aaa; color: #fff; }
      .dl-btn {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 7px 18px;
        border: none;
        border-radius: 20px;
        background: #ff0050;
        color: #fff;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.15s;
      }
      .dl-btn:hover { background: #e00045; }
      .dl-btn:disabled { background: #555; cursor: wait; }
      .dl-btn svg { width: 16px; height: 16px; fill: #fff; }
      .status {
        color: #aaa;
        font-size: 12px;
        margin-left: 4px;
        white-space: nowrap;
      }
      .sep {
        width: 1px;
        height: 20px;
        background: #444;
        margin: 0 4px;
      }

      /* Split controls */
      .split-group {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .split-btn {
        padding: 4px 10px;
        border: 1px solid #555;
        border-radius: 6px;
        background: transparent;
        color: #aaa;
        font-size: 12px;
        cursor: pointer;
        white-space: nowrap;
        transition: all 0.15s;
      }
      .split-btn:hover { border-color: #aaa; color: #fff; }
      .split-btn.active {
        border-color: #ff0050;
        color: #ff0050;
        background: rgba(255, 0, 80, 0.1);
      }

      /* Progress */
      .progress-area {
        display: none;
        margin-top: 8px;
      }
      .progress-area.active { display: block; }
      .progress-bar-bg {
        width: 100%;
        height: 6px;
        background: #333;
        border-radius: 3px;
        overflow: hidden;
      }
      .progress-bar-fill {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #ff0050, #ff4081);
        border-radius: 3px;
        transition: width 0.3s ease;
      }
      .progress-info {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 5px;
        font-size: 11px;
        color: #999;
      }
      .progress-percent {
        color: #ff0050;
        font-weight: 600;
        font-size: 12px;
      }
    </style>
    <div class="container">
      <div class="row">
        <label>시작</label>
        <input type="text" id="start" placeholder="0:00" />
        <button class="cur-btn" id="cur-start">◀ 현재</button>

        <div class="sep"></div>

        <label>끝</label>
        <input type="text" id="end" placeholder="끝까지" />
        <button class="cur-btn" id="cur-end">◀ 현재</button>

        <div class="sep"></div>

        <button class="dl-btn" id="dl-btn">
          <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 13.5v-7l5.5 3.5-5.5 3.5z"/></svg>
          MP3 다운로드
        </button>
        <span class="status" id="status"></span>
      </div>

      <div class="row">
        <label>분할</label>
        <div class="split-group">
          <button class="split-btn active" data-split="1">전체</button>
          <button class="split-btn" data-split="2">2분할</button>
          <button class="split-btn" data-split="3">3분할</button>
          <button class="split-btn" data-split="4">4분할</button>
          <button class="split-btn" data-split="5">5분할</button>
        </div>
      </div>

      <div class="progress-area" id="progress-area">
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" id="progress-fill"></div>
        </div>
        <div class="progress-info">
          <span id="progress-phase">준비 중...</span>
          <span class="progress-percent" id="progress-percent">0%</span>
        </div>
      </div>
    </div>
  `;

  target.parentNode.insertBefore(host, target.nextSibling);

  const root = shadow;
  let selectedSplit = 1;

  // Split button handlers
  root.querySelectorAll('.split-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('.split-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedSplit = parseInt(btn.dataset.split);
    });
  });

  root.getElementById('cur-start').addEventListener('click', () => {
    const video = document.querySelector('video');
    if (video) root.getElementById('start').value = formatTime(video.currentTime);
  });

  root.getElementById('cur-end').addEventListener('click', () => {
    const video = document.querySelector('video');
    if (video) root.getElementById('end').value = formatTime(video.currentTime);
  });

  root.getElementById('dl-btn').addEventListener('click', () => {
    if (selectedSplit > 1) {
      handleSplitDownload(root, selectedSplit);
    } else {
      handleDownload(root);
    }
  });
}

// ===== Single download =====
async function handleDownload(root) {
  const btn = root.getElementById('dl-btn');
  const status = root.getElementById('status');
  const progressArea = root.getElementById('progress-area');
  const progressFill = root.getElementById('progress-fill');
  const progressPhase = root.getElementById('progress-phase');
  const progressPercent = root.getElementById('progress-percent');
  const startVal = root.getElementById('start').value;
  const endVal = root.getElementById('end').value;

  const url = window.location.href;
  const start = parseTime(startVal);
  const end = parseTime(endVal);

  btn.disabled = true;
  btn.textContent = '⏳ 다운로드 중...';
  status.textContent = '';
  progressArea.classList.add('active');
  progressFill.style.width = '0%';
  progressPhase.textContent = '준비 중...';
  progressPercent.textContent = '0%';

  try {
    try { await fetch(`${SERVER_URL}/health`); }
    catch { status.textContent = '⚠️ 서버 꺼짐!'; btn.disabled = false; resetBtn(btn); progressArea.classList.remove('active'); return; }

    const startRes = await fetch(`${SERVER_URL}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, start, end }),
    });
    if (!startRes.ok) throw new Error((await startRes.json()).error || 'Failed');

    const { jobId } = await startRes.json();
    let serverFilename = 'audio.mp3';

    await listenProgress(jobId, progressFill, progressPercent, progressPhase, (data) => {
      if (data.filename) serverFilename = data.filename;
    });

    await downloadFile(`${SERVER_URL}/file/${jobId}`, serverFilename);

    progressFill.style.width = '100%';
    progressPercent.textContent = '100%';
    progressPhase.textContent = '완료!';
    status.textContent = '✅ 완료!';
    setTimeout(() => progressArea.classList.remove('active'), 3000);

  } catch (err) {
    status.textContent = `❌ ${err.message}`;
    progressArea.classList.remove('active');
  } finally {
    btn.disabled = false;
    resetBtn(btn);
  }
}

// ===== Split download =====
async function handleSplitDownload(root, splits) {
  const btn = root.getElementById('dl-btn');
  const status = root.getElementById('status');
  const progressArea = root.getElementById('progress-area');
  const progressFill = root.getElementById('progress-fill');
  const progressPhase = root.getElementById('progress-phase');
  const progressPercent = root.getElementById('progress-percent');

  const url = window.location.href;

  btn.disabled = true;
  btn.textContent = `⏳ ${splits}분할 다운로드 중...`;
  status.textContent = '';
  progressArea.classList.add('active');
  progressFill.style.width = '0%';
  progressPhase.textContent = '영상 정보 분석 중...';
  progressPercent.textContent = '0%';

  try {
    try { await fetch(`${SERVER_URL}/health`); }
    catch { status.textContent = '⚠️ 서버 꺼짐!'; btn.disabled = false; resetBtn(btn); progressArea.classList.remove('active'); return; }

    const startRes = await fetch(`${SERVER_URL}/download-split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, splits }),
    });
    if (!startRes.ok) throw new Error((await startRes.json()).error || 'Failed');

    const { jobId } = await startRes.json();
    let filesList = [];

    // Listen to progress
    await listenProgress(jobId, progressFill, progressPercent, progressPhase, (data) => {
      if (data.files) filesList = data.files;
    });

    // Download all parts sequentially
    progressPhase.textContent = '파일 저장 중...';
    for (let i = 0; i < filesList.length; i++) {
      const file = filesList[i];
      progressPhase.textContent = `파일 저장 중... (${i + 1}/${filesList.length})`;
      await downloadFile(`${SERVER_URL}/file/${jobId}/${file.part}`, file.filename);
      // Small delay between downloads
      await new Promise(r => setTimeout(r, 500));
    }

    progressFill.style.width = '100%';
    progressPercent.textContent = '100%';
    progressPhase.textContent = `${splits}개 파트 다운로드 완료!`;
    status.textContent = `✅ ${splits}개 파일 완료!`;
    setTimeout(() => progressArea.classList.remove('active'), 5000);

  } catch (err) {
    status.textContent = `❌ ${err.message}`;
    progressArea.classList.remove('active');
  } finally {
    btn.disabled = false;
    resetBtn(btn);
  }
}

// ===== Shared helpers =====
function listenProgress(jobId, progressFill, progressPercent, progressPhase, onData) {
  return new Promise((resolve, reject) => {
    let reconnectAttempts = 0;
    const maxReconnects = 60;

    function connect() {
      const evtSource = new EventSource(`${SERVER_URL}/progress/${jobId}`);

      evtSource.onmessage = (event) => {
        reconnectAttempts = 0;
        const data = JSON.parse(event.data);

        progressFill.style.width = `${data.progress}%`;
        progressPercent.textContent = `${Math.round(data.progress)}%`;
        progressPhase.textContent = data.phase;

        if (onData) onData(data);

        if (data.status === 'done') {
          evtSource.close();
          resolve(data);
        } else if (data.status === 'error') {
          evtSource.close();
          reject(new Error(data.error || data.phase));
        }
      };

      evtSource.onerror = () => {
        evtSource.close();
        reconnectAttempts++;
        if (reconnectAttempts <= maxReconnects) {
          progressPhase.textContent = `재연결 중... (${reconnectAttempts})`;
          setTimeout(connect, 2000);
        } else {
          reject(new Error('서버 연결이 끊어졌습니다'));
        }
      };
    }

    connect();
  });
}

async function downloadFile(url, filename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`파일 다운로드 실패: ${filename}`);
  const blob = await res.blob();
  const downloadUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(downloadUrl);
}

function resetBtn(btn) {
  btn.innerHTML = `
    <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 13.5v-7l5.5 3.5-5.5 3.5z"/></svg>
    MP3 다운로드
  `;
}

// ===== YouTube SPA navigation =====
function removeOldUI() {
  const old = document.getElementById('yt-mp3-host');
  if (old) old.remove();
}

function isVideoPage() {
  return window.location.pathname === '/watch' || window.location.pathname.startsWith('/live/');
}

function onNavigate() {
  if (isVideoPage()) {
    removeOldUI();
    createUI();
  } else {
    removeOldUI();
  }
}

window.addEventListener('yt-navigate-finish', onNavigate);
window.addEventListener('popstate', () => setTimeout(onNavigate, 300));

let lastUrl = location.href;
const urlObserver = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    onNavigate();
  }
});
urlObserver.observe(document.body, { childList: true, subtree: true });

if (isVideoPage()) createUI();
