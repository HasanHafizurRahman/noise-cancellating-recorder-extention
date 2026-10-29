// Storage utilities for CrispRec extension
export const DEFAULT_SETTINGS = {
  // Video settings
  videoQuality: '1080p', // '720p', '1080p', '4k'
  frameRate: 60, // 30, 60
  videoBitrate: 4500000, // 4.5 Mbps
  videoCodec: 'vp9', // 'vp9', 'vp8', 'avc'
  systemAudio: true,
  micAudio: true,
  micDeviceId: 'default',
  webcam: false,
  webcamDeviceId: 'default',
  webcamPosition: 'bottom-right', // 'bottom-right', 'bottom-left', 'top-right', 'top-left'
  webcamShape: 'circle', // 'circle', 'rounded'
  webcamSize: 220,
  countdown: 3, // 0, 3, 5, 10
  floatingControls: true,

  // Noise cancellation settings
  noiseCancellation: true,
  ncPreset: 'balanced', // 'balanced', 'studio', 'aggressive', 'custom'

  // Custom DSP settings
  thresholdDb: -45, // dB
  suppressionDb: -36, // dB
  lowCutFreq: 90, // Hz
  highCutFreq: 12000, // Hz
  presenceGain: 3.0, // dB
  attackMs: 12, // ms
  releaseMs: 180, // ms
  compressorEnabled: true,
};

export const NC_PRESETS = {
  balanced: {
    name: 'Balanced Voice',
    description: 'Optimal for meetings, online lectures, and general screencasts.',
    thresholdDb: -45,
    suppressionDb: -32,
    lowCutFreq: 95,
    highCutFreq: 12000,
    presenceGain: 2.5,
    attackMs: 12,
    releaseMs: 180,
    compressorEnabled: true,
    badge: 'Standard'
  },
  studio: {
    name: 'Studio Podcast',
    description: 'Broadcast warmth with gentle gating and voice clarity EQ.',
    thresholdDb: -42,
    suppressionDb: -24,
    lowCutFreq: 80,
    highCutFreq: 14000,
    presenceGain: 4.0,
    attackMs: 15,
    releaseMs: 240,
    compressorEnabled: true,
    badge: 'Pro Audio'
  },
  aggressive: {
    name: 'Fan & HVAC Killer',
    description: 'Heavy attenuation for loud laptop fans, typing, and room hum.',
    thresholdDb: -36,
    suppressionDb: -48,
    lowCutFreq: 140,
    highCutFreq: 8500,
    presenceGain: 2.0,
    attackMs: 8,
    releaseMs: 130,
    compressorEnabled: true,
    badge: 'High Noise'
  },
  custom: {
    name: 'Custom DSP',
    description: 'Manual control over all digital signal processing stages.',
    badge: 'Custom'
  }
};

/**
 * Get stored settings merged with defaults
 */
export async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings'], (result) => {
      resolve({ ...DEFAULT_SETTINGS, ...(result.settings || {}) });
    });
  });
}

/**
 * Save updated settings
 */
export async function saveSettings(partialSettings) {
  const current = await getSettings();
  const updated = { ...current, ...partialSettings };
  return new Promise((resolve) => {
    chrome.storage.local.set({ settings: updated }, () => resolve(updated));
  });
}

/**
 * Get current recording state
 */
export async function getRecordingState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['recordingState'], (result) => {
      resolve(
        result.recordingState || {
          status: 'idle', // 'idle' | 'countdown' | 'recording' | 'paused' | 'saving'
          startedAt: null,
          elapsedSeconds: 0,
          isMicMuted: false,
          activeTabId: null
        }
      );
    });
  });
}

/**
 * Update recording state
 */
export async function updateRecordingState(partialState) {
  const current = await getRecordingState();
  const updated = { ...current, ...partialState };
  return new Promise((resolve) => {
    chrome.storage.local.set({ recordingState: updated }, () => resolve(updated));
  });
}

