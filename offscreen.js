/**
 * CrispRec Offscreen Media Capture & Audio Processing Controller
 */

import { DspAudioEngine } from './audio/dsp-engine.js';
import { fixWebmDuration } from './audio/ebml-patcher.js';
import { saveRecording } from './utils/db.js';

let mediaRecorder = null;
let recordedChunks = [];
let screenStream = null;
let micStream = null;
let webcamStream = null;
let compositeStream = null;
let dspEngine = null;

let recordingStartTime = 0;
let totalPausedDuration = 0;
let pauseStartTime = 0;
let timerInterval = null;
let isPaused = false;
let isMicMuted = false;
let currentOptions = {};
let renderLoopId = null;

// Message dispatcher from service worker / popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  switch (message.type) {
    case 'START_RECORDING':
      startRecording(message.streamId, message.options)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // async response

    case 'STOP_RECORDING':
      stopRecording()
        .then((recId) => sendResponse({ success: true, recordingId: recId }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'PAUSE_RECORDING':
      pauseRecording();
      sendResponse({ success: true });
      break;

    case 'RESUME_RECORDING':
      resumeRecording();
      sendResponse({ success: true });
      break;

    case 'SET_MIC_MUTED':
      setMicMuted(message.muted);
      sendResponse({ success: true });
      break;

    case 'UPDATE_DSP':
      if (dspEngine) {
        if (message.preset) dspEngine.applyPreset(message.preset);
        if (message.params) dspEngine.updateDspParams(message.params);
        if (message.enabled !== undefined) dspEngine.setNoiseCancellationEnabled(message.enabled);
      }
      sendResponse({ success: true });
      break;

    case 'GET_STATUS':
      sendResponse({
        isRecording: mediaRecorder && mediaRecorder.state !== 'inactive',
        isPaused,
        isMicMuted,
        elapsedSeconds: getElapsedSeconds()
      });
      break;
  }
});

async function startRecording(streamId, options = {}) {
  currentOptions = options;
  recordedChunks = [];
  isPaused = false;
  isMicMuted = false;
  totalPausedDuration = 0;
  pauseStartTime = 0;

  // 1. Determine Resolution constraints
  let maxWidth = 1920;
  let maxHeight = 1080;
  if (options.videoQuality === '720p') {
    maxWidth = 1280;
    maxHeight = 720;
  } else if (options.videoQuality === '4k') {
    maxWidth = 3840;
    maxHeight = 2160;
  }
  const fps = options.frameRate || 60;

  // 2. Capture Screen / Window / Tab via streamId with system audio fallback
  try {
    screenStream = await navigator.mediaDevices.getUserMedia({
      audio: options.systemAudio ? {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: streamId
        }
      } : false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: streamId,
          maxWidth: maxWidth,
          maxHeight: maxHeight,
          maxFrameRate: fps
        }
      }
    });
  } catch (err) {
    // If capture failed and system audio was requested, the user may have unchecked "Share audio" in the picker
    if (options.systemAudio) {
      console.warn('Screen capture with audio failed (user may have deselected audio in prompt), retrying video only:', err);
      try {
        screenStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: streamId,
              maxWidth: maxWidth,
              maxHeight: maxHeight,
              maxFrameRate: fps
            }
          }
        });
      } catch (videoOnlyErr) {
        console.error('Failed to capture desktop stream video:', videoOnlyErr);
        throw new Error('Could not access screen media: ' + videoOnlyErr.message);
      }
    } else {
      console.error('Failed to capture desktop stream:', err);
      throw new Error('Could not access screen media: ' + err.message);
    }
  }

  // Listen for user ending share via Chrome's native bottom bar
  const videoTrack = screenStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.onended = () => {
      console.log('Screen sharing track ended by user');
      stopRecording();
    };
  }

  // 3. Capture Microphone if enabled
  if (options.micAudio) {
    try {
      const audioConstraints = {
        sampleRate: 48000,
        channelCount: 2,
        echoCancellation: true,
        // Disable browser aggressive noise suppression so our custom AI DSP takes full control
        noiseSuppression: false,
        autoGainControl: false
      };

      if (options.micDeviceId && options.micDeviceId !== 'default') {
        audioConstraints.deviceId = { exact: options.micDeviceId };
      }

      micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch (micErr) {
      console.warn('Microphone access failed or denied:', micErr);
      micStream = null;
    }
  }

  // 4. Capture Webcam if enabled
  if (options.webcam) {
    try {
      const videoConstraints = {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 }
      };

      if (options.webcamDeviceId && options.webcamDeviceId !== 'default') {
        videoConstraints.deviceId = { exact: options.webcamDeviceId };
      }

      webcamStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
    } catch (camErr) {
      console.warn('Webcam access failed or denied:', camErr);
      webcamStream = null;
    }
  }

  // 5. Initialize DSP Audio Engine (Noise Cancellation & Mixing)
  dspEngine = new DspAudioEngine();
  const mixedAudioStream = await dspEngine.init(micStream, screenStream, {
    noiseCancellation: options.noiseCancellation !== false,
    ncPreset: options.ncPreset || 'balanced',
    lowCutFreq: options.lowCutFreq,
    highCutFreq: options.highCutFreq,
    presenceGain: options.presenceGain,
    thresholdDb: options.thresholdDb,
    suppressionDb: options.suppressionDb,
    attackMs: options.attackMs,
    releaseMs: options.releaseMs
  });

  // 6. Handle Video Source (Direct or Canvas Compositing for Webcam PiP)
  let finalVideoTrack = null;

  if (webcamStream) {
    // Set up canvas compositing
    const canvas = document.getElementById('composite-canvas');
    const screenVideo = document.getElementById('screen-video');
    const webcamVideo = document.getElementById('webcam-video');

    screenVideo.srcObject = screenStream;
    webcamVideo.srcObject = webcamStream;

    await Promise.all([
      new Promise((res) => (screenVideo.onloadedmetadata = res)),
      new Promise((res) => (webcamVideo.onloadedmetadata = res))
    ]);

    const cWidth = screenVideo.videoWidth || maxWidth;
    const cHeight = screenVideo.videoHeight || maxHeight;
    canvas.width = cWidth;
    canvas.height = cHeight;

    const ctx = canvas.getContext('2d');
    const pipSize = options.webcamSize || Math.round(cHeight * 0.25);
    const pipShape = options.webcamShape || 'circle';
    const pipPos = options.webcamPosition || 'bottom-right';

    function renderFrame() {
      // Draw screen frame
      ctx.drawImage(screenVideo, 0, 0, cWidth, cHeight);

      // Calculate PiP coordinates
      const margin = 28;
      let px = cWidth - pipSize - margin;
      let py = cHeight - pipSize - margin;

      if (pipPos === 'bottom-left') {
        px = margin;
        py = cHeight - pipSize - margin;
      } else if (pipPos === 'top-right') {
        px = cWidth - pipSize - margin;
        py = margin;
      } else if (pipPos === 'top-left') {
        px = margin;
        py = margin;
      }

      ctx.save();
      // Draw PiP shadow
      ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
      ctx.shadowBlur = 12;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 4;

      if (pipShape === 'circle') {
        const radius = pipSize / 2;
        ctx.beginPath();
        ctx.arc(px + radius, py + radius, radius, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(webcamVideo, px, py, pipSize, pipSize);
        ctx.restore();

        // Glowing border
        ctx.save();
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.arc(px + radius, py + radius, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      } else {
        // Rounded rectangle
        ctx.beginPath();
        ctx.roundRect(px, py, pipSize, Math.round(pipSize * 0.75), 14);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(webcamVideo, px, py, pipSize, Math.round(pipSize * 0.75));
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.roundRect(px, py, pipSize, Math.round(pipSize * 0.75), 14);
        ctx.stroke();
        ctx.restore();
      }

      renderLoopId = requestAnimationFrame(renderFrame);
    }

    renderFrame();
    compositeStream = canvas.captureStream(fps);
    finalVideoTrack = compositeStream.getVideoTracks()[0];
  } else {
    // Pure screen video track
    finalVideoTrack = screenStream.getVideoTracks()[0];
  }

  // 7. Combine Video + Mixed Audio
  const combinedStream = new MediaStream();
  if (finalVideoTrack) {
    combinedStream.addTrack(finalVideoTrack);
  }

  if (mixedAudioStream && mixedAudioStream.getAudioTracks().length > 0) {
    combinedStream.addTrack(mixedAudioStream.getAudioTracks()[0]);
  }

  // 8. Select optimal MediaRecorder MIME type
  const mimeTypes = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];

  let chosenMime = 'video/webm';
  for (const m of mimeTypes) {
    if (MediaRecorder.isTypeSupported(m)) {
      chosenMime = m;
      break;
    }
  }

  const recorderOptions = {
    mimeType: chosenMime,
    videoBitsPerSecond: options.videoBitrate || 4500000
  };

  try {
    mediaRecorder = new MediaRecorder(combinedStream, recorderOptions);
  } catch (recErr) {
    console.warn('MediaRecorder init with bitrate failed, falling back to default:', recErr);
    mediaRecorder = new MediaRecorder(combinedStream);
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      recordedChunks.push(e.data);
    }
  };

  // Start recording with 1000ms timeslices for safety
  mediaRecorder.start(1000);
  recordingStartTime = Date.now();

  // Start timer broadcast tick (every 1 sec)
  timerInterval = setInterval(() => {
    const elapsed = getElapsedSeconds();
    chrome.runtime.sendMessage({
      type: 'TIMER_TICK',
      elapsedSeconds: elapsed,
      isPaused,
      isMicMuted
    }).catch(() => {});
  }, 1000);

  chrome.runtime.sendMessage({
    type: 'RECORDING_STARTED',
    startedAt: recordingStartTime
  }).catch(() => {});

  return true;
}

function pauseRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    isPaused = true;
    pauseStartTime = Date.now();
    chrome.runtime.sendMessage({ type: 'RECORDING_PAUSED' }).catch(() => {});
  }
}

function resumeRecording() {
  if (mediaRecorder && mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    isPaused = false;
    if (pauseStartTime > 0) {
      totalPausedDuration += Date.now() - pauseStartTime;
      pauseStartTime = 0;
    }
    chrome.runtime.sendMessage({ type: 'RECORDING_RESUMED' }).catch(() => {});
  }
}

function setMicMuted(muted) {
  isMicMuted = muted;
  if (dspEngine) {
    dspEngine.setMicMuted(muted);
  }
  chrome.runtime.sendMessage({
    type: 'MIC_MUTE_CHANGED',
    isMicMuted: muted
  }).catch(() => {});
}

function getElapsedSeconds() {
  if (!recordingStartTime) return 0;
  const now = Date.now();
  let currentPause = 0;
  if (isPaused && pauseStartTime > 0) {
    currentPause = now - pauseStartTime;
  }
  const totalMs = now - recordingStartTime - totalPausedDuration - currentPause;
  return Math.max(0, Math.floor(totalMs / 1000));
}

async function stopRecording() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  if (renderLoopId) {
    cancelAnimationFrame(renderLoopId);
    renderLoopId = null;
  }

  const totalDurationSec = getElapsedSeconds();
  const totalDurationMs = totalDurationSec * 1000;

  return new Promise((resolve, reject) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      cleanupResources();
      return resolve(null);
    }

    mediaRecorder.onstop = async () => {
      try {
        const rawBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'video/webm' });
        
        // Patch EBML duration so WebM is 100% seekable and duration is accurate
        const seekableBlob = await fixWebmDuration(rawBlob, totalDurationMs);

        // Save into IndexedDB
        const recordingId = 'rec_' + Date.now();
        await saveRecording({
          id: recordingId,
          blob: seekableBlob,
          mimeType: seekableBlob.type,
          duration: totalDurationSec,
          fileSize: seekableBlob.size,
          width: currentOptions.videoQuality === '4k' ? 3840 : (currentOptions.videoQuality === '720p' ? 1280 : 1920),
          height: currentOptions.videoQuality === '4k' ? 2160 : (currentOptions.videoQuality === '720p' ? 720 : 1080),
          hasMic: !!currentOptions.micAudio,
          hasNoiseCancellation: !!currentOptions.noiseCancellation,
          preset: currentOptions.ncPreset || 'balanced',
          createdAt: Date.now()
        });

        cleanupResources();

        // Notify service worker that recording is ready
        chrome.runtime.sendMessage({
          type: 'RECORDING_COMPLETED',
          recordingId: recordingId,
          duration: totalDurationSec
        }).catch(() => {});

        resolve(recordingId);
      } catch (err) {
        console.error('Error finalizing recording:', err);
        cleanupResources();
        reject(err);
      }
    };

    mediaRecorder.stop();
  });
}

function cleanupResources() {
  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (webcamStream) {
    webcamStream.getTracks().forEach((t) => t.stop());
    webcamStream = null;
  }
  if (compositeStream) {
    compositeStream.getTracks().forEach((t) => t.stop());
    compositeStream = null;
  }
  if (dspEngine) {
    dspEngine.close();
    dspEngine = null;
  }
  mediaRecorder = null;
  recordedChunks = [];
  recordingStartTime = 0;
  totalPausedDuration = 0;
  pauseStartTime = 0;
  isPaused = false;
}
