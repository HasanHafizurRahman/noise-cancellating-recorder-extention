/**
 * CrispRec Background Service Worker (Manifest V3)
 * Manages extension lifecycle, offscreen recording document, badge timers,
 * keyboard shortcuts, and preview studio launching.
 */

const OFFSCREEN_PATH = 'offscreen.html';

const DEFAULT_SETTINGS = {
  videoQuality: '1080p',
  frameRate: 60,
  videoBitrate: 4500000,
  videoCodec: 'vp9',
  systemAudio: true,
  micAudio: true,
  micDeviceId: 'default',
  webcam: false,
  webcamDeviceId: 'default',
  webcamPosition: 'bottom-right',
  webcamShape: 'circle',
  webcamSize: 220,
  countdown: 3,
  floatingControls: true,
  noiseCancellation: true,
  ncPreset: 'balanced',
  thresholdDb: -45,
  suppressionDb: -36,
  lowCutFreq: 90,
  highCutFreq: 12000,
  presenceGain: 3.0,
  attackMs: 12,
  releaseMs: 180,
  compressorEnabled: true,
};

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings'], (result) => {
      resolve({ ...DEFAULT_SETTINGS, ...(result.settings || {}) });
    });
  });
}

function getRecordingState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['recordingState'], (result) => {
      resolve(
        result.recordingState || {
          status: 'idle',
          startedAt: null,
          elapsedSeconds: 0,
          isMicMuted: false,
          activeTabId: null
        }
      );
    });
  });
}

function updateRecordingState(partialState) {
  return new Promise((resolve) => {
    getRecordingState().then((current) => {
      const updated = { ...current, ...partialState };
      chrome.storage.local.set({ recordingState: updated }, () => resolve(updated));
    });
  });
}

// Format seconds into MM:SS
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

// Initialize context menus and state on installation
chrome.runtime.onInstalled.addListener(() => {
  try {
    if (chrome.contextMenus && chrome.contextMenus.removeAll) {
      chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
          id: 'crisprec-quick-record',
          title: 'Record Screen with Noise Cancellation',
          contexts: ['action']
        });
      });
    }
  } catch (err) {
    console.warn('Context menu creation warning:', err);
  }

  updateRecordingState({
    status: 'idle',
    startedAt: null,
    elapsedSeconds: 0,
    isMicMuted: false,
    activeTabId: null
  });
});

// Context menu click handler
if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'crisprec-quick-record') {
      handleToggleRecording(tab);
    }
  });
}

// Global keyboard shortcuts
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    const state = await getRecordingState();
    let activeTab = null;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs.length > 0) activeTab = tabs[0];
    } catch (e) {}

    if (command === 'start-stop-recording') {
      if (state.status === 'recording' || state.status === 'paused') {
        stopRecording();
      } else {
        initiateRecording(activeTab);
      }
    } else if (command === 'pause-resume-recording') {
      if (state.status === 'recording') {
        pauseRecording();
      } else if (state.status === 'paused') {
        resumeRecording();
      }
    } else if (command === 'mute-unmute-mic') {
      toggleMicMute();
    }
  });
}

// Runtime message router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'START_RECORDING_FLOW':
      initiateRecording(message.targetTab || sender.tab, message.options)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'STOP_RECORDING_FLOW':
      stopRecording()
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'PAUSE_RECORDING_FLOW':
      pauseRecording();
      sendResponse({ success: true });
      break;

    case 'RESUME_RECORDING_FLOW':
      resumeRecording();
      sendResponse({ success: true });
      break;

    case 'TOGGLE_MIC_MUTE_FLOW':
      toggleMicMute();
      sendResponse({ success: true });
      break;

    case 'TIMER_TICK':
      handleTimerTick(message.elapsedSeconds, message.isPaused, message.isMicMuted);
      break;

    case 'RECORDING_STARTED':
      updateRecordingState({
        status: 'recording',
        startedAt: message.startedAt,
        elapsedSeconds: 0
      });
      if (chrome.action) {
        chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
        chrome.action.setBadgeText({ text: 'REC' });
      }
      notifyTabs({ type: 'FLOATING_BAR_SHOW' });
      break;

    case 'RECORDING_PAUSED':
      updateRecordingState({ status: 'paused' });
      if (chrome.action) {
        chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
        chrome.action.setBadgeText({ text: 'PAUSE' });
      }
      notifyTabs({ type: 'FLOATING_BAR_PAUSE' });
      break;

    case 'RECORDING_RESUMED':
      updateRecordingState({ status: 'recording' });
      if (chrome.action) {
        chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
      }
      notifyTabs({ type: 'FLOATING_BAR_RESUME' });
      break;

    case 'RECORDING_COMPLETED':
      handleRecordingCompleted(message.recordingId);
      break;

    case 'RECORDING_CANCELED':
      updateRecordingState({ status: 'idle' });
      if (chrome.action) chrome.action.setBadgeText({ text: '' });
      closeOffscreenDocument();
      break;
  }
});

// Ensure offscreen document exists
async function ensureOffscreenDocument() {
  if (!chrome.offscreen) return;
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
    justification: 'Real-time screen recording and Web Audio noise cancellation'
  });
}

// Safely close offscreen document to reclaim memory
async function closeOffscreenDocument() {
  if (!chrome.offscreen) return;
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

async function initiateRecording(targetTab, customOptions = null) {
  const settings = customOptions || (await getSettings());
  await ensureOffscreenDocument();

  let tabToCapture = targetTab;
  if (!tabToCapture) {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs.length > 0) tabToCapture = tabs[0];
    } catch (e) {}
  }

  updateRecordingState({
    status: 'starting',
    activeTabId: tabToCapture ? tabToCapture.id : null
  });

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        target: 'offscreen',
        type: 'START_RECORDING',
        options: settings
      },
      (response) => {
        if (chrome.runtime.lastError || (response && !response.success)) {
          const err = chrome.runtime.lastError?.message || response?.error || 'Recording canceled or failed';
          console.warn('Failed to start in offscreen:', err);
          updateRecordingState({ status: 'idle' });
          if (chrome.action) chrome.action.setBadgeText({ text: '' });
          closeOffscreenDocument();
          reject(new Error(err));
        } else {
          resolve(true);
        }
      }
    );
  });
}

async function stopRecording() {
  await updateRecordingState({ status: 'saving' });
  if (chrome.action) {
    chrome.action.setBadgeText({ text: 'SAVING' });
    chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
  }

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        target: 'offscreen',
        type: 'STOP_RECORDING'
      },
      (response) => {
        resolve(response?.recordingId);
      }
    );
  });
}

function pauseRecording() {
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'PAUSE_RECORDING' }).catch(() => {});
}

function resumeRecording() {
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'RESUME_RECORDING' }).catch(() => {});
}

async function toggleMicMute() {
  const state = await getRecordingState();
  const nextMuted = !state.isMicMuted;
  await updateRecordingState({ isMicMuted: nextMuted });
  chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'SET_MIC_MUTED',
    muted: nextMuted
  }).catch(() => {});
  notifyTabs({ type: 'FLOATING_BAR_MIC_MUTE', isMuted: nextMuted });
}

function handleTimerTick(elapsedSeconds, isPaused, isMicMuted) {
  updateRecordingState({ elapsedSeconds, isMicMuted });
  const timeStr = formatTime(elapsedSeconds);

  if (!isPaused && chrome.action) {
    chrome.action.setBadgeText({ text: timeStr });
  }

  notifyTabs({
    type: 'FLOATING_BAR_TICK',
    elapsedSeconds,
    timeFormatted: timeStr,
    isPaused,
    isMicMuted
  });
}

async function handleRecordingCompleted(recordingId) {
  await updateRecordingState({
    status: 'idle',
    startedAt: null,
    elapsedSeconds: 0,
    isMicMuted: false
  });

  if (chrome.action) {
    chrome.action.setBadgeText({ text: '' });
  }
  notifyTabs({ type: 'FLOATING_BAR_HIDE' });

  if (recordingId) {
    chrome.tabs.create({
      url: chrome.runtime.getURL(`preview/preview.html?id=${recordingId}`)
    });
  }

  setTimeout(async () => {
    const state = await getRecordingState();
    if (state.status === 'idle') {
      await closeOffscreenDocument();
    }
  }, 2000);
}

async function notifyTabs(message) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && tab.url && !tab.url.startsWith('chrome://')) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    }
  } catch (err) {}
}

async function handleToggleRecording(tab) {
  const state = await getRecordingState();
  if (state.status === 'recording' || state.status === 'paused') {
    stopRecording();
  } else {
    initiateRecording(tab);
  }
}
