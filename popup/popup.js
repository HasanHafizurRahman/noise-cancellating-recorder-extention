/**
 * CrispRec Popup Controller
 * Manages device selection, live DSP preview, noise cancellation presets,
 * and starts screen capture via background service worker.
 */

import { getSettings, saveSettings, getRecordingState, NC_PRESETS } from '../utils/storage.js';
import { DspAudioEngine } from '../audio/dsp-engine.js';
import { AudioVisualizer } from '../utils/visualizer.js';

// DOM elements
const setupView = document.getElementById('setup-view');
const recordingView = document.getElementById('recording-view');

const micToggle = document.getElementById('mic-toggle');
const micDeviceSelect = document.getElementById('mic-device-select');
const micDeviceContainer = document.getElementById('mic-device-container');

const systemAudioToggle = document.getElementById('system-audio-toggle');
const webcamToggle = document.getElementById('webcam-toggle');
const webcamOptionsContainer = document.getElementById('webcam-options-container');
const webcamDeviceSelect = document.getElementById('webcam-device-select');

const ncMasterToggle = document.getElementById('nc-master-toggle');
const ncStatusTag = document.getElementById('nc-status-tag');
const ncControlsArea = document.getElementById('nc-controls-area');
const presetButtons = document.querySelectorAll('.preset-btn');
const customDspPanel = document.getElementById('custom-dsp-panel');

const thresholdSlider = document.getElementById('threshold-slider');
const thresholdVal = document.getElementById('threshold-val');
const suppressionSlider = document.getElementById('suppression-slider');
const suppressionVal = document.getElementById('suppression-val');
const lowcutSlider = document.getElementById('lowcut-slider');
const lowcutVal = document.getElementById('lowcut-val');

const qualitySelect = document.getElementById('quality-select');
const fpsSelect = document.getElementById('fps-select');
const countdownSelect = document.getElementById('countdown-select');

const micCanvas = document.getElementById('mic-canvas');
const testMicBtn = document.getElementById('test-mic-btn');
const startRecordBtn = document.getElementById('start-record-btn');

const libraryBtn = document.getElementById('library-btn');
const settingsBtn = document.getElementById('settings-btn');

// Active view DOM
const activeTimer = document.getElementById('active-timer');
const activePulseDot = document.getElementById('active-pulse-dot');
const activeStatusText = document.getElementById('active-status-text');
const activePauseBtn = document.getElementById('active-pause-btn');
const activePauseIcon = document.getElementById('active-pause-icon');
const activePauseLabel = document.getElementById('active-pause-label');
const activeMuteBtn = document.getElementById('active-mute-btn');
const activeMuteIcon = document.getElementById('active-mute-icon');
const activeMuteLabel = document.getElementById('active-mute-label');
const activeStopBtn = document.getElementById('active-stop-btn');

// Local audio test preview state
let previewEngine = null;
let visualizer = null;
let previewStream = null;
let isTestingMic = false;
let currentSettings = {};

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  visualizer = new AudioVisualizer(micCanvas);
  currentSettings = await getSettings();

  await checkRecordingState();
  populateUIFromSettings(currentSettings);
  await enumerateMediaDevices();
  setupEventListeners();

  // Listen for background timer updates
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'TIMER_TICK') {
      updateActiveTimer(message.elapsedSeconds, message.isPaused, message.isMicMuted);
    } else if (message.type === 'RECORDING_COMPLETED') {
      showSetupView();
    }
  });
});

async function checkRecordingState() {
  const state = await getRecordingState();
  if (state.status === 'recording' || state.status === 'paused') {
    showRecordingView(state);
  } else {
    showSetupView();
  }
}

function showRecordingView(state) {
  setupView.classList.add('hidden');
  recordingView.classList.remove('hidden');
  updateActiveTimer(state.elapsedSeconds || 0, state.status === 'paused', state.isMicMuted);
}

function showSetupView() {
  recordingView.classList.add('hidden');
  setupView.classList.remove('hidden');
}

function updateActiveTimer(seconds, isPaused, isMuted) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  activeTimer.textContent = `${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;

  if (isPaused) {
    activePulseDot.classList.add('paused');
    activeStatusText.textContent = 'PAUSED';
    activePauseLabel.textContent = 'Resume';
    activePauseIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
  } else {
    activePulseDot.classList.remove('paused');
    activeStatusText.textContent = 'RECORDING';
    activePauseLabel.textContent = 'Pause';
    activePauseIcon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
  }

  if (isMuted) {
    activeMuteBtn.classList.add('active');
    activeMuteLabel.textContent = 'Unmute';
    activeMuteIcon.innerHTML = '<path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>';
  } else {
    activeMuteBtn.classList.remove('active');
    activeMuteLabel.textContent = 'Mute';
    activeMuteIcon.innerHTML = '<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>';
  }
}

function populateUIFromSettings(s) {
  micToggle.checked = s.micAudio;
  micDeviceContainer.style.display = s.micAudio ? 'block' : 'none';

  systemAudioToggle.checked = s.systemAudio;
  webcamToggle.checked = s.webcam;
  webcamOptionsContainer.classList.toggle('hidden', !s.webcam);

  ncMasterToggle.checked = s.noiseCancellation;
  updateNcStatusDisplay(s.noiseCancellation);

  // Set active preset
  presetButtons.forEach((btn) => {
    if (btn.dataset.preset === s.ncPreset) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  if (s.ncPreset === 'custom') {
    customDspPanel.classList.remove('hidden');
  }

  thresholdSlider.value = s.thresholdDb;
  thresholdVal.textContent = `${s.thresholdDb} dB`;
  suppressionSlider.value = s.suppressionDb;
  suppressionVal.textContent = `${s.suppressionDb} dB`;
  lowcutSlider.value = s.lowCutFreq;
  lowcutVal.textContent = `${s.lowCutFreq} Hz`;

  qualitySelect.value = s.videoQuality || '1080p';
  fpsSelect.value = s.frameRate || 60;
  countdownSelect.value = s.countdown !== undefined ? s.countdown : 3;
}

async function enumerateMediaDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    micDeviceSelect.innerHTML = '<option value="default">Default Microphone</option>';
    webcamDeviceSelect.innerHTML = '<option value="default">Default Camera</option>';

    devices.forEach((dev) => {
      if (dev.kind === 'audioinput' && dev.deviceId !== 'default') {
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        opt.textContent = dev.label || `Microphone ${micDeviceSelect.length}`;
        micDeviceSelect.appendChild(opt);
      } else if (dev.kind === 'videoinput' && dev.deviceId !== 'default') {
        const opt = document.createElement('option');
        opt.value = dev.deviceId;
        opt.textContent = dev.label || `Camera ${webcamDeviceSelect.length}`;
        webcamDeviceSelect.appendChild(opt);
      }
    });

    if (currentSettings.micDeviceId) {
      micDeviceSelect.value = currentSettings.micDeviceId;
    }
    if (currentSettings.webcamDeviceId) {
      webcamDeviceSelect.value = currentSettings.webcamDeviceId;
    }
  } catch (err) {
    console.warn('Could not enumerate devices:', err);
  }
}

function updateNcStatusDisplay(enabled) {
  if (enabled) {
    ncStatusTag.textContent = 'Real-Time Denoising ON';
    ncStatusTag.style.color = '#34d399';
    ncControlsArea.style.opacity = '1';
    ncControlsArea.style.pointerEvents = 'auto';
  } else {
    ncStatusTag.textContent = 'Denoising Bypass (Raw Audio)';
    ncStatusTag.style.color = '#94a3b8';
    ncControlsArea.style.opacity = '0.5';
    ncControlsArea.style.pointerEvents = 'none';
  }
}

function setupEventListeners() {
  // Mic toggle
  micToggle.addEventListener('change', () => {
    currentSettings.micAudio = micToggle.checked;
    micDeviceContainer.style.display = micToggle.checked ? 'block' : 'none';
    saveSettings({ micAudio: micToggle.checked });
  });

  micDeviceSelect.addEventListener('change', () => {
    currentSettings.micDeviceId = micDeviceSelect.value;
    saveSettings({ micDeviceId: micDeviceSelect.value });
    if (isTestingMic) restartMicTest();
  });

  // System audio toggle
  systemAudioToggle.addEventListener('change', () => {
    currentSettings.systemAudio = systemAudioToggle.checked;
    saveSettings({ systemAudio: systemAudioToggle.checked });
  });

  // Webcam toggle
  webcamToggle.addEventListener('change', () => {
    currentSettings.webcam = webcamToggle.checked;
    webcamOptionsContainer.classList.toggle('hidden', !webcamToggle.checked);
    saveSettings({ webcam: webcamToggle.checked });
  });

  webcamDeviceSelect.addEventListener('change', () => {
    currentSettings.webcamDeviceId = webcamDeviceSelect.value;
    saveSettings({ webcamDeviceId: webcamDeviceSelect.value });
  });

  // NC Master Switch
  ncMasterToggle.addEventListener('change', () => {
    const isEnabled = ncMasterToggle.checked;
    currentSettings.noiseCancellation = isEnabled;
    updateNcStatusDisplay(isEnabled);
    saveSettings({ noiseCancellation: isEnabled });
    if (previewEngine) previewEngine.setNoiseCancellationEnabled(isEnabled);
  });

  // NC Presets
  presetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      presetButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      const preset = btn.dataset.preset;
      currentSettings.ncPreset = preset;
      customDspPanel.classList.toggle('hidden', preset !== 'custom');

      if (preset !== 'custom' && NC_PRESETS[preset]) {
        const pData = NC_PRESETS[preset];
        thresholdSlider.value = pData.thresholdDb;
        thresholdVal.textContent = `${pData.thresholdDb} dB`;
        suppressionSlider.value = pData.suppressionDb;
        suppressionVal.textContent = `${pData.suppressionDb} dB`;
        lowcutSlider.value = pData.lowCutFreq;
        lowcutVal.textContent = `${pData.lowCutFreq} Hz`;

        saveSettings({
          ncPreset: preset,
          thresholdDb: pData.thresholdDb,
          suppressionDb: pData.suppressionDb,
          lowCutFreq: pData.lowCutFreq
        });
        if (previewEngine) previewEngine.applyPreset(preset);
      } else {
        saveSettings({ ncPreset: 'custom' });
      }
    });
  });

  // Custom DSP Sliders
  thresholdSlider.addEventListener('input', () => {
    const val = parseInt(thresholdSlider.value, 10);
    thresholdVal.textContent = `${val} dB`;
    currentSettings.thresholdDb = val;
    saveSettings({ thresholdDb: val });
    if (previewEngine) previewEngine.updateDspParams({ thresholdDb: val });
  });

  suppressionSlider.addEventListener('input', () => {
    const val = parseInt(suppressionSlider.value, 10);
    suppressionVal.textContent = `${val} dB`;
    currentSettings.suppressionDb = val;
    saveSettings({ suppressionDb: val });
    if (previewEngine) previewEngine.updateDspParams({ suppressionDb: val });
  });

  lowcutSlider.addEventListener('input', () => {
    const val = parseInt(lowcutSlider.value, 10);
    lowcutVal.textContent = `${val} Hz`;
    currentSettings.lowCutFreq = val;
    saveSettings({ lowCutFreq: val });
    if (previewEngine) previewEngine.updateDspParams({ lowCutFreq: val });
  });

  // Video settings
  qualitySelect.addEventListener('change', () => {
    currentSettings.videoQuality = qualitySelect.value;
    saveSettings({ videoQuality: qualitySelect.value });
  });

  fpsSelect.addEventListener('change', () => {
    currentSettings.frameRate = parseInt(fpsSelect.value, 10);
    saveSettings({ frameRate: currentSettings.frameRate });
  });

  countdownSelect.addEventListener('change', () => {
    currentSettings.countdown = parseInt(countdownSelect.value, 10);
    saveSettings({ countdown: currentSettings.countdown });
  });

  // Test Mic Button
  testMicBtn.addEventListener('click', () => {
    if (isTestingMic) {
      stopMicTest();
    } else {
      startMicTest();
    }
  });

  // Start Recording Button
  startRecordBtn.addEventListener('click', async () => {
    stopMicTest(); // Stop test if running
    const countdownSec = currentSettings.countdown || 0;

    if (countdownSec > 0) {
      startCountdown(countdownSec, () => executeStartRecording());
    } else {
      executeStartRecording();
    }
  });

  // Active view buttons
  activePauseBtn.addEventListener('click', () => {
    const state = activePauseLabel.textContent.toLowerCase();
    if (state === 'pause') {
      chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING_FLOW' });
    } else {
      chrome.runtime.sendMessage({ type: 'RESUME_RECORDING_FLOW' });
    }
  });

  activeMuteBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'TOGGLE_MIC_MUTE_FLOW' });
  });

  activeStopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING_FLOW' });
  });

  // Header buttons
  libraryBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('preview/preview.html?view=library') });
  });

  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

function startCountdown(seconds, callback) {
  let count = seconds;
  startRecordBtn.disabled = true;
  startRecordBtn.innerHTML = `<span>Starting in ${count}...</span>`;

  const intId = setInterval(() => {
    count--;
    if (count > 0) {
      startRecordBtn.innerHTML = `<span>Starting in ${count}...</span>`;
    } else {
      clearInterval(intId);
      startRecordBtn.disabled = false;
      startRecordBtn.innerHTML = `
        <span class="btn-glow"></span>
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="#ffffff"/></svg>
        <span>Start Recording</span>
      `;
      callback();
    }
  }, 1000);
}

async function executeStartRecording() {
  chrome.runtime.sendMessage(
    {
      type: 'START_RECORDING_FLOW',
      options: currentSettings
    },
    (res) => {
      if (res && res.success) {
        window.close(); // Close popup once desktop picker appears
      } else if (res && res.error) {
        alert('Could not start recording: ' + res.error);
      }
    }
  );
}

async function startMicTest() {
  try {
    const audioConstraints = {
      sampleRate: 48000,
      echoCancellation: true,
      noiseSuppression: false
    };

    if (currentSettings.micDeviceId && currentSettings.micDeviceId !== 'default') {
      audioConstraints.deviceId = { exact: currentSettings.micDeviceId };
    }

    previewStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    previewEngine = new DspAudioEngine();

    await previewEngine.init(previewStream, null, {
      noiseCancellation: currentSettings.noiseCancellation,
      ncPreset: currentSettings.ncPreset,
      lowCutFreq: currentSettings.lowCutFreq,
      highCutFreq: currentSettings.highCutFreq,
      presenceGain: currentSettings.presenceGain,
      thresholdDb: currentSettings.thresholdDb,
      suppressionDb: currentSettings.suppressionDb
    });

    previewEngine.onMeter((meter) => {
      if (visualizer) visualizer.updateMeter(meter);
    });

    visualizer.attach(previewEngine.getAnalyser());

    isTestingMic = true;
    testMicBtn.textContent = 'Stop Test';
    testMicBtn.classList.add('active');
  } catch (err) {
    console.error('Failed to start mic test:', err);
    alert('Please allow microphone permissions to test audio: ' + err.message);
  }
}

function stopMicTest() {
  isTestingMic = false;
  testMicBtn.textContent = 'Test Mic';
  testMicBtn.classList.remove('active');

  if (visualizer) visualizer.stop();
  if (previewEngine) {
    previewEngine.close();
    previewEngine = null;
  }
  if (previewStream) {
    previewStream.getTracks().forEach((t) => t.stop());
    previewStream = null;
  }
}

async function restartMicTest() {
  stopMicTest();
  await startMicTest();
}

window.addEventListener('unload', () => {
  stopMicTest();
});

