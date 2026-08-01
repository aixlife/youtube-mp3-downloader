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
      input:focus { border-color: #2563eb; }
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
      .plaud-btn {
        padding: 7px 18px;
        border: none;
        border-radius: 20px;
        background: #2563eb;
        color: #fff;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.15s;
      }
      .plaud-btn:hover { background: #1d4ed8; }
      .plaud-btn:disabled { background: #555; cursor: wait; }
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
        background: linear-gradient(90deg, #2563eb, #60a5fa);
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
        color: #60a5fa;
        font-weight: 600;
        font-size: 12px;
      }
      .part-info {
        margin-top: 4px;
        font-size: 11px;
        color: #888;
      }
      .part-info:empty { display: none; }
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

        <button class="plaud-btn" id="plaud-btn">PLAUD로 보내기</button>
        <span class="status" id="status"></span>
      </div>

      <div class="progress-area" id="progress-area">
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" id="progress-fill"></div>
        </div>
        <div class="progress-info">
          <span id="progress-phase">준비 중...</span>
          <span class="progress-percent" id="progress-percent">0%</span>
        </div>
        <div class="part-info" id="part-info"></div>
      </div>
    </div>
  `;

  target.parentNode.insertBefore(host, target.nextSibling);

  const root = shadow;

  root.getElementById('cur-start').addEventListener('click', () => {
    const video = document.querySelector('video');
    if (video) root.getElementById('start').value = formatTime(video.currentTime);
  });

  root.getElementById('cur-end').addEventListener('click', () => {
    const video = document.querySelector('video');
    if (video) root.getElementById('end').value = formatTime(video.currentTime);
  });

  root.getElementById('plaud-btn').addEventListener('click', () => {
    handlePlaudSend(root);
  });
}

// ===== Send to PLAUD =====
async function handlePlaudSend(root) {
  const btn = root.getElementById('plaud-btn');
  const status = root.getElementById('status');
  const progressArea = root.getElementById('progress-area');
  const progressFill = root.getElementById('progress-fill');
  const progressPhase = root.getElementById('progress-phase');
  const progressPercent = root.getElementById('progress-percent');
  const partInfo = root.getElementById('part-info');
  const startVal = root.getElementById('start').value;
  const endVal = root.getElementById('end').value;

  const url = window.location.href;
  const start = parseTime(startVal);
  const end = parseTime(endVal);

  btn.disabled = true;
  btn.textContent = 'PLAUD 전송 중...';
  status.textContent = '';
  partInfo.textContent = '';
  progressArea.classList.add('active');
  progressFill.style.width = '0%';
  progressPhase.textContent = 'PLAUD 전송 준비 중...';
  progressPercent.textContent = '0%';

  try {
    try { await fetch(`${SERVER_URL}/health`); }
    catch { status.textContent = '⚠️ 서버 꺼짐!'; progressArea.classList.remove('active'); return; }

    const startRes = await fetch(`${SERVER_URL}/plaud/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, start, end }),
    });
    if (!startRes.ok) throw new Error((await startRes.json()).error || 'Failed');

    const { jobId } = await startRes.json();
    await listenProgress(jobId, progressFill, progressPercent, progressPhase, (data) => {
      // 5시간 초과로 자동 분할된 경우 파트 진행 상황을 보여준다
      if (data.totalParts > 1) {
        partInfo.textContent = `자동 분할 ${data.totalParts}개 · 현재 파트 ${data.currentPart || 1}/${data.totalParts}`;
      }
    });

    progressFill.style.width = '100%';
    progressPercent.textContent = '100%';
    progressPhase.textContent = 'PLAUD 업로드 제출 완료!';
    status.textContent = '✅ PLAUD 전송 완료!';
    setTimeout(() => progressArea.classList.remove('active'), 5000);

  } catch (err) {
    status.textContent = `❌ ${err.message}`;
    progressArea.classList.remove('active');
  } finally {
    btn.disabled = false;
    btn.textContent = 'PLAUD로 보내기';
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
