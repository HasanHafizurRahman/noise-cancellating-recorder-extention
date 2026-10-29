/**
 * CrispRec Background Service Worker (Manifest V3)
 * Manages extension lifecycle, offscreen recording document, badge timers,
 * keyboard shortcuts, and preview studio launching.
 */

import { getSettings, getRecordingState, updateRecordingState } from './utils/storage.js';

const OFFSCREEN_PATH = 'offscreen.html';

// Initialize context menus and state on installation
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'crisprec-quick-record',
    title: 'Record Screen with Noise Cancellation',
    contexts: ['action']
  });

  updateRecordingState({
    status: 'idle',
    startedAt: null,
    elapsedSeconds: 0,
    isMicMuted: false,
    activeTabId: null
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'crisprec-quick-record') {
    handleToggleRecording(tab);
  }
});

// Ensure offscreen document exists
async function ensureOffscreenDocument() {
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
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

// Format seconds into MM:SS
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

// Global keyboard shortcuts
chrome.commands.onCommand.addListener(async (command) => {
  const state = await getRecordingState();
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

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
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
      chrome.action.setBadgeText({ text: 'REC' });
      notifyTabs({ type: 'FLOATING_BAR_SHOW' });
      break;

    case 'RECORDING_PAUSED':
      updateRecordingState({ status: 'paused' });
      chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
      chrome.action.setBadgeText({ text: 'PAUSE' });
      notifyTabs({ type: 'FLOATING_BAR_PAUSE' });
      break;

    case 'RECORDING_RESUMED':
      updateRecordingState({ status: 'recording' });
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
      notifyTabs({ type: 'FLOATING_BAR_RESUME' });
      break;

    case 'RECORDING_COMPLETED':
      handleRecordingCompleted(message.recordingId);
      break;
  }
});

async function initiateRecording(targetTab, customOptions = null) {
  const settings = customOptions || (await getSettings());
  await ensureOffscreenDocument();

  // If no tab provided, find the active tab
  let tabToCapture = targetTab;
  if (!tabToCapture) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tabToCapture = tabs[0];
  }

  // Request desktopCapture native picker
  const sources = ['screen', 'window', 'tab'];
  if (settings.systemAudio) {
    sources.push('audio');
  }

  return new Promise((resolve, reject) => {
    chrome.desktopCapture.chooseDesktopMedia(sources, tabToCapture, async (streamId) => {
      if (!streamId) {
        // User cancelled the prompt
        await closeOffscreenDocument();
        return resolve(false);
      }

      await updateRecordingState({
        status: 'starting',
        activeTabId: tabToCapture ? tabToCapture.id : null
      });

      chrome.runtime.sendMessage(
        {
          target: 'offscreen',
          type: 'START_RECORDING',
          streamId: streamId,
          options: settings
        },
        (response) => {
          if (chrome.runtime.lastError || (response && !response.success)) {
            const err = chrome.runtime.lastError?.message || response?.error || 'Unknown error';
            console.error('Failed to start in offscreen:', err);
            updateRecordingState({ status: 'idle' });
            chrome.action.setBadgeText({ text: '' });
            reject(new Error(err));
          } else {
            resolve(true);
          }
        }
      );
    });
  });
}

async function stopRecording() {
  await updateRecordingState({ status: 'saving' });
  chrome.action.setBadgeText({ text: 'SAVING' });
  chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });

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

  if (!isPaused) {
    chrome.action.setBadgeText({ text: timeStr });
  }

  // Forward to floating controls in active tabs
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

  chrome.action.setBadgeText({ text: '' });
  notifyTabs({ type: 'FLOATING_BAR_HIDE' });

  // Open Preview Studio in a new tab
  if (recordingId) {
    chrome.tabs.create({
      url: chrome.runtime.getURL(`preview/preview.html?id=${recordingId}`)
    });
  }

  // Gracefully close offscreen document after delay
  setTimeout(async () => {
    const state = await getRecordingState();
    if (state.status === 'idle') {
      await closeOffscreenDocument();
    }
  }, 2000);
}

// Broadcast message to content script in all active tabs
async function notifyTabs(message) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id && tab.url && !tab.url.startsWith('chrome://')) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  }
}

async function handleToggleRecording(tab) {
  const state = await getRecordingState();
  if (state.status === 'recording' || state.status === 'paused') {
    stopRecording();
  } else {
    initiateRecording(tab);
  }
}

