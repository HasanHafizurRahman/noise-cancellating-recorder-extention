/**
 * CrispRec Options & Audio Settings Controller
 */

import { getSettings, saveSettings, DEFAULT_SETTINGS, NC_PRESETS } from '../utils/storage.js';
import { getAllRecordings, deleteRecording, getStorageUsage } from '../utils/db.js';

// DOM elements
const saveStatus = document.getElementById('save-status');

const optNcPreset = document.getElementById('opt-nc-preset');
const optThreshold = document.getElementById('opt-threshold');
const optThresholdLabel = document.getElementById('opt-threshold-label');
const optSuppression = document.getElementById('opt-suppression');
const optSuppressionLabel = document.getElementById('opt-suppression-label');
const optLowcut = document.getElementById('opt-lowcut');
const optLowcutLabel = document.getElementById('opt-lowcut-label');
const optHighcut = document.getElementById('opt-highcut');
const optHighcutLabel = document.getElementById('opt-highcut-label');
const optPresence = document.getElementById('opt-presence');
const optPresenceLabel = document.getElementById('opt-presence-label');
const optCompressor = document.getElementById('opt-compressor');

const optQuality = document.getElementById('opt-quality');
const optFps = document.getElementById('opt-fps');
const optBitrate = document.getElementById('opt-bitrate');
const optCountdown = document.getElementById('opt-countdown');
const optFloating = document.getElementById('opt-floating');

const optWebcamShape = document.getElementById('opt-webcam-shape');
const optWebcamPos = document.getElementById('opt-webcam-pos');
const optWebcamSize = document.getElementById('opt-webcam-size');

const storageDetail = document.getElementById('storage-detail');
const clearStorageBtn = document.getElementById('clear-storage-btn');
const resetDefaultsBtn = document.getElementById('reset-defaults-btn');

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await getSettings();
  populateForm(settings);
  await refreshStorageStats();
  attachEvents();
});

function populateForm(s) {
  optNcPreset.value = s.ncPreset || 'balanced';

  optThreshold.value = s.thresholdDb;
  optThresholdLabel.textContent = `${s.thresholdDb} dB`;

  optSuppression.value = s.suppressionDb;
  optSuppressionLabel.textContent = `${s.suppressionDb} dB`;

  optLowcut.value = s.lowCutFreq;
  optLowcutLabel.textContent = `${s.lowCutFreq} Hz`;

  optHighcut.value = s.highCutFreq;
  optHighcutLabel.textContent = `${s.highCutFreq} Hz`;

  optPresence.value = s.presenceGain;
  optPresenceLabel.textContent = `+${s.presenceGain} dB`;

  optCompressor.checked = s.compressorEnabled !== false;

  optQuality.value = s.videoQuality || '1080p';
  optFps.value = s.frameRate || 60;
  optBitrate.value = s.videoBitrate || 4500000;
  optCountdown.value = s.countdown !== undefined ? s.countdown : 3;
  optFloating.checked = s.floatingControls !== false;

  optWebcamShape.value = s.webcamShape || 'circle';
  optWebcamPos.value = s.webcamPosition || 'bottom-right';
  optWebcamSize.value = s.webcamSize || 220;
}

function attachEvents() {
  // Preset change
  optNcPreset.addEventListener('change', () => {
    const preset = optNcPreset.value;
    if (preset !== 'custom' && NC_PRESETS[preset]) {
      const p = NC_PRESETS[preset];
      optThreshold.value = p.thresholdDb;
      optThresholdLabel.textContent = `${p.thresholdDb} dB`;
      optSuppression.value = p.suppressionDb;
      optSuppressionLabel.textContent = `${p.suppressionDb} dB`;
      optLowcut.value = p.lowCutFreq;
      optLowcutLabel.textContent = `${p.lowCutFreq} Hz`;
      optHighcut.value = p.highCutFreq;
      optHighcutLabel.textContent = `${p.highCutFreq} Hz`;
      optPresence.value = p.presenceGain;
      optPresenceLabel.textContent = `+${p.presenceGain} dB`;

      triggerSave({
        ncPreset: preset,
        thresholdDb: p.thresholdDb,
        suppressionDb: p.suppressionDb,
        lowCutFreq: p.lowCutFreq,
        highCutFreq: p.highCutFreq,
        presenceGain: p.presenceGain
      });
    } else {
      triggerSave({ ncPreset: 'custom' });
    }
  });

  // Slider events
  optThreshold.addEventListener('input', () => {
    optThresholdLabel.textContent = `${optThreshold.value} dB`;
    triggerSave({ thresholdDb: parseInt(optThreshold.value, 10), ncPreset: 'custom' });
    optNcPreset.value = 'custom';
  });

  optSuppression.addEventListener('input', () => {
    optSuppressionLabel.textContent = `${optSuppression.value} dB`;
    triggerSave({ suppressionDb: parseInt(optSuppression.value, 10), ncPreset: 'custom' });
    optNcPreset.value = 'custom';
  });

  optLowcut.addEventListener('input', () => {
    optLowcutLabel.textContent = `${optLowcut.value} Hz`;
    triggerSave({ lowCutFreq: parseInt(optLowcut.value, 10), ncPreset: 'custom' });
    optNcPreset.value = 'custom';
  });

  optHighcut.addEventListener('input', () => {
    optHighcutLabel.textContent = `${optHighcut.value} Hz`;
    triggerSave({ highCutFreq: parseInt(optHighcut.value, 10), ncPreset: 'custom' });
    optNcPreset.value = 'custom';
  });

  optPresence.addEventListener('input', () => {
    optPresenceLabel.textContent = `+${optPresence.value} dB`;
    triggerSave({ presenceGain: parseFloat(optPresence.value), ncPreset: 'custom' });
    optNcPreset.value = 'custom';
  });

  optCompressor.addEventListener('change', () => {
    triggerSave({ compressorEnabled: optCompressor.checked });
  });

  // Video capture events
  optQuality.addEventListener('change', () => {
    triggerSave({ videoQuality: optQuality.value });
  });

  optFps.addEventListener('change', () => {
    triggerSave({ frameRate: parseInt(optFps.value, 10) });
  });

  optBitrate.addEventListener('change', () => {
    triggerSave({ videoBitrate: parseInt(optBitrate.value, 10) });
  });

  optCountdown.addEventListener('change', () => {
    triggerSave({ countdown: parseInt(optCountdown.value, 10) });
  });

  optFloating.addEventListener('change', () => {
    triggerSave({ floatingControls: optFloating.checked });
  });

  // Webcam events
  optWebcamShape.addEventListener('change', () => {
    triggerSave({ webcamShape: optWebcamShape.value });
  });

  optWebcamPos.addEventListener('change', () => {
    triggerSave({ webcamPosition: optWebcamPos.value });
  });

  optWebcamSize.addEventListener('change', () => {
    triggerSave({ webcamSize: parseInt(optWebcamSize.value, 10) });
  });

  // Clear Storage
  clearStorageBtn.addEventListener('click', async () => {
    const confirmed = confirm('Are you sure you want to delete ALL recordings from local storage?');
    if (confirmed) {
      const all = await getAllRecordings();
      for (const item of all) {
        await deleteRecording(item.id);
      }
      await refreshStorageStats();
      showToast('All recordings deleted');
    }
  });

  // Reset Defaults
  resetDefaultsBtn.addEventListener('click', async () => {
    const confirmed = confirm('Reset all settings to default values?');
    if (confirmed) {
      await saveSettings(DEFAULT_SETTINGS);
      populateForm(DEFAULT_SETTINGS);
      showToast('Settings restored to defaults');
    }
  });
}

async function triggerSave(partial) {
  await saveSettings(partial);
  showToast('Settings saved');
}

function showToast(msg) {
  saveStatus.textContent = msg;
  saveStatus.style.opacity = '1';
  setTimeout(() => {
    saveStatus.textContent = 'Settings saved automatically';
  }, 1500);
}

async function refreshStorageStats() {
  const usage = await getStorageUsage();
  storageDetail.textContent = `${usage.count} saved recordings (${usage.megabytes} MB stored locally)`;
}

