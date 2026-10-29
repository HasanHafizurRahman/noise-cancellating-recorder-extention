/**
 * CrispRec In-Page Floating Recording Bar
 * Shadow-DOM isolated, draggable, with live timer, pause/resume, mic mute, and stop buttons.
 */

let hostElement = null;
let shadowRoot = null;
let isDragging = false;
let startX = 0;
let startY = 0;
let initialLeft = 0;
let initialTop = 0;
let isPaused = false;
let isMicMuted = false;

// Check existing recording state on injection
chrome.storage.local.get(['recordingState'], (res) => {
  if (res.recordingState && (res.recordingState.status === 'recording' || res.recordingState.status === 'paused')) {
    createFloatingBar();
    updateTimerText(formatTime(res.recordingState.elapsedSeconds || 0));
    if (res.recordingState.status === 'paused') setPausedUI(true);
    if (res.recordingState.isMicMuted) setMicMutedUI(true);
  }
});

// Listen for broadcast messages from background
chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'FLOATING_BAR_SHOW':
      createFloatingBar();
      break;

    case 'FLOATING_BAR_HIDE':
      removeFloatingBar();
      break;

    case 'FLOATING_BAR_TICK':
      if (!hostElement) createFloatingBar();
      updateTimerText(message.timeFormatted);
      if (message.isPaused !== isPaused) setPausedUI(message.isPaused);
      if (message.isMicMuted !== isMicMuted) setMicMutedUI(message.isMicMuted);
      break;

    case 'FLOATING_BAR_PAUSE':
      setPausedUI(true);
      break;

    case 'FLOATING_BAR_RESUME':
      setPausedUI(false);
      break;

    case 'FLOATING_BAR_MIC_MUTE':
      setMicMutedUI(message.isMuted);
      break;
  }
});

function createFloatingBar() {
  if (hostElement) return;

  hostElement = document.createElement('div');
  hostElement.id = 'crisprec-floating-host';
  document.body.appendChild(hostElement);

  shadowRoot = hostElement.attachShadow({ mode: 'open' });

  shadowRoot.innerHTML = `
    <style>
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
        user-select: none;
      }
      .bar-container {
        display: flex;
        align-items: center;
        gap: 10px;
        background: rgba(15, 23, 42, 0.88);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        border: 1px solid rgba(56, 189, 248, 0.35);
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 0 15px rgba(56, 189, 248, 0.2);
        border-radius: 9999px;
        padding: 6px 12px 6px 14px;
        color: #f8fafc;
        cursor: grab;
        transition: border-color 0.2s, box-shadow 0.2s;
      }
      .bar-container:hover {
        border-color: rgba(56, 189, 248, 0.6);
      }
      .bar-container:active {
        cursor: grabbing;
      }
      .rec-indicator {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .rec-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #ef4444;
        box-shadow: 0 0 8px #ef4444;
        animation: pulse 1.5s infinite;
      }
      .rec-dot.paused {
        background: #f59e0b;
        box-shadow: 0 0 8px #f59e0b;
        animation: none;
      }
      @keyframes pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.4; transform: scale(0.9); }
      }
      .rec-timer {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.5px;
        color: #e2e8f0;
        min-width: 44px;
      }
      .divider {
        width: 1px;
        height: 18px;
        background: rgba(148, 163, 184, 0.25);
      }
      .btn-group {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .action-btn {
        background: rgba(30, 41, 59, 0.7);
        border: 1px solid rgba(148, 163, 184, 0.2);
        color: #cbd5e1;
        width: 30px;
        height: 30px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .action-btn:hover {
        background: rgba(51, 65, 85, 0.9);
        color: #ffffff;
        border-color: rgba(56, 189, 248, 0.4);
        transform: translateY(-1px);
      }
      .action-btn:active {
        transform: translateY(0);
      }
      .action-btn.active {
        background: rgba(239, 68, 68, 0.2);
        border-color: #ef4444;
        color: #ef4444;
      }
      .stop-btn {
        background: #ef4444 !important;
        border-color: #dc2626 !important;
        color: #ffffff !important;
        box-shadow: 0 0 10px rgba(239, 68, 68, 0.4);
      }
      .stop-btn:hover {
        background: #dc2626 !important;
      }
      .nc-badge {
        font-size: 10px;
        background: rgba(16, 185, 129, 0.2);
        color: #34d399;
        border: 1px solid rgba(16, 185, 129, 0.4);
        padding: 2px 7px;
        border-radius: 9999px;
        font-weight: 500;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      svg {
        width: 14px;
        height: 14px;
        fill: currentColor;
      }
    </style>

    <div class="bar-container" id="bar">
      <div class="rec-indicator">
        <div class="rec-dot" id="dot"></div>
        <span class="rec-timer" id="timer">0:00</span>
      </div>

      <div class="nc-badge" title="AI Noise Cancellation Active">
        🛡️ NC ON
      </div>

      <div class="divider"></div>

      <div class="btn-group">
        <button class="action-btn" id="pause-btn" title="Pause / Resume (Alt+Shift+P)">
          <svg id="pause-icon" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
        </button>

        <button class="action-btn" id="mute-btn" title="Mute / Unmute Mic (Alt+Shift+M)">
          <svg id="mic-icon" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>
        </button>

        <button class="action-btn stop-btn" id="stop-btn" title="Finish & Save Recording (Alt+Shift+R)">
          <svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>
        </button>
      </div>
    </div>
  `;

  // Attach drag events
  const bar = shadowRoot.getElementById('bar');
  bar.addEventListener('mousedown', onDragStart);

  // Attach button events
  const pauseBtn = shadowRoot.getElementById('pause-btn');
  pauseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isPaused) {
      chrome.runtime.sendMessage({ type: 'RESUME_RECORDING_FLOW' });
    } else {
      chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING_FLOW' });
    }
  });

  const muteBtn = shadowRoot.getElementById('mute-btn');
  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'TOGGLE_MIC_MUTE_FLOW' });
  });

  const stopBtn = shadowRoot.getElementById('stop-btn');
  stopBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING_FLOW' });
  });
}

function removeFloatingBar() {
  if (hostElement) {
    hostElement.remove();
    hostElement = null;
    shadowRoot = null;
  }
}

function updateTimerText(str) {
  if (!shadowRoot) return;
  const timer = shadowRoot.getElementById('timer');
  if (timer) timer.textContent = str;
}

function setPausedUI(paused) {
  isPaused = paused;
  if (!shadowRoot) return;
  const dot = shadowRoot.getElementById('dot');
  const pauseIcon = shadowRoot.getElementById('pause-icon');
  if (dot) {
    if (paused) dot.classList.add('paused');
    else dot.classList.remove('paused');
  }
  if (pauseIcon) {
    pauseIcon.innerHTML = paused
      ? '<path d="M8 5v14l11-7z"/>' // Play icon
      : '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>'; // Pause icon
  }
}

function setMicMutedUI(muted) {
  isMicMuted = muted;
  if (!shadowRoot) return;
  const muteBtn = shadowRoot.getElementById('mute-btn');
  const micIcon = shadowRoot.getElementById('mic-icon');
  if (muteBtn) {
    if (muted) muteBtn.classList.add('active');
    else muteBtn.classList.remove('active');
  }
  if (micIcon) {
    micIcon.innerHTML = muted
      ? '<path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>'
      : '<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>';
  }
}

// Dragging logic
function onDragStart(e) {
  if (e.target.closest('button')) return; // ignore button clicks
  isDragging = true;
  startX = e.clientX;
  startY = e.clientY;

  const rect = hostElement.getBoundingClientRect();
  initialLeft = rect.left;
  initialTop = rect.top;

  // Change transform to absolute positioning
  hostElement.style.transform = 'none';
  hostElement.style.left = `${initialLeft}px`;
  hostElement.style.top = `${initialTop}px`;
  hostElement.style.bottom = 'auto';

  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e) {
  if (!isDragging) return;
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;

  let newLeft = initialLeft + dx;
  let newTop = initialTop + dy;

  // Keep within viewport bounds
  const w = hostElement.offsetWidth;
  const h = hostElement.offsetHeight;
  newLeft = Math.max(10, Math.min(window.innerWidth - w - 10, newLeft));
  newTop = Math.max(10, Math.min(window.innerHeight - h - 10, newTop));

  hostElement.style.left = `${newLeft}px`;
  hostElement.style.top = `${newTop}px`;
}

function onDragEnd() {
  isDragging = false;
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

