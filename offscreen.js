/**
 * CrispRec Offscreen Media Capture & Audio Processing Controller
 *
 * Handles screen capture via standard navigator.mediaDevices.getDisplayMedia(),
 * microphone capture, webcam overlay, AI DSP audio processing,
 * dynamic screen area cropping, and WebM seekable recording.
 */

import { DspAudioEngine } from './audio/dsp-engine.js';
import { fixWebmDuration } from './audio/ebml-patcher.js';
import { saveRecording } from './utils/db.js';

let mediaRecorder = null;
let recordedChunks = [];
let screenStream = null;
let micStream = null;
let webcamStream = null;
let dspEngine = null;
let videoPipelineCleanup = null;

let recordingStartTime = 0;
let totalPausedDuration = 0;
let pauseStartTime = 0;
let timerInterval = null;
let isPaused = false;
let isMicMuted = false;
let currentOptions = {};

// Message dispatcher from service worker / popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  switch (message.type) {
    case 'START_RECORDING':
      startRecording(message.options || {})
        .then(() => sendResponse({ success: true }))
        .catch((err) => {
          console.warn('startRecording caught error:', err);
          sendResponse({ success: false, error: err.message });
        });
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

/**
 * Starts screen recording and audio DSP graph
 */
async function startRecording(options = {}) {
  currentOptions = options;
  cleanupResources(); // Clean up previous session state
  recordedChunks = [];
  isPaused = false;
  isMicMuted = false;
  totalPausedDuration = 0;
  pauseStartTime = 0;

  // 1. Resolution & Framerate Constraints
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

  // 2. Request Display Stream via standard getDisplayMedia
  const displayMediaOptions = {
    video: {
      width: { ideal: maxWidth, max: maxWidth },
      height: { ideal: maxHeight, max: maxHeight },
      frameRate: { ideal: fps }
    },
    audio: options.systemAudio !== false
  };

  // Surface hints if provided
  if (options.recordingAreaMode === 'window') {
    displayMediaOptions.video.displaySurface = 'window';
  } else if (options.recordingAreaMode === 'tab') {
    displayMediaOptions.video.displaySurface = 'browser';
  }

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
  } catch (err) {
    console.warn('getDisplayMedia was canceled or failed:', err);
    chrome.runtime.sendMessage({ type: 'RECORDING_CANCELED' }).catch(() => {});
    throw err;
  }

  // Handle user ending screen share via Chrome's bottom bar
  const screenVideoTrack = screenStream.getVideoTracks()[0];
  if (screenVideoTrack) {
    screenVideoTrack.onended = () => {
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
        noiseSuppression: false,
        autoGainControl: false
      };

      if (options.micDeviceId && options.micDeviceId !== 'default') {
        audioConstraints.deviceId = { exact: options.micDeviceId };
      }

      micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch (micErr) {
      console.warn('Microphone capture failed or denied in offscreen:', micErr);
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
      console.warn('Webcam access failed or denied in offscreen:', camErr);
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

  // 6. Video Pipeline: Screen Area Cropping & Webcam PiP Compositing
  const pipeline = setupVideoPipeline(screenVideoTrack, webcamStream, options);
  const finalVideoTrack = pipeline.track;
  videoPipelineCleanup = pipeline.cleanup;

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

  // Start recording with 1000ms timeslices for stream integrity
  mediaRecorder.start(1000);
  recordingStartTime = Date.now();

  // Timer broadcast tick (every 1 second)
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

/**
 * Sets up Video Processing Pipeline:
 * - Direct track passthrough when full screen without webcam (zero overhead)
 * - Zero-copy WebCodecs VideoFrame visibleRect cropping when custom region selected
 * - Canvas compositing when webcam PiP is requested
 */
function setupVideoPipeline(screenVideoTrack, webcamStream, options) {
  const isCustomCrop =
    options.recordingAreaMode === 'custom' &&
    options.cropArea &&
    options.cropArea.width > 0 &&
    options.cropArea.height > 0;
  const hasWebcam = Boolean(webcamStream && webcamStream.getVideoTracks().length > 0);

  // If full screen without webcam: direct track passthrough (0% CPU, 60fps)
  if (!isCustomCrop && !hasWebcam) {
    return {
      track: screenVideoTrack,
      cleanup: () => {}
    };
  }

  // Use MediaStreamTrackProcessor & MediaStreamTrackGenerator (Insertable Streams)
  if (typeof MediaStreamTrackProcessor !== 'undefined' && typeof MediaStreamTrackGenerator !== 'undefined') {
    try {
      const processor = new MediaStreamTrackProcessor({ track: screenVideoTrack });
      const generator = new MediaStreamTrackGenerator({ kind: 'video' });

      let webcamVideo = null;
      let offCanvas = null;
      let offCtx = null;

      if (hasWebcam) {
        webcamVideo = document.getElementById('webcam-video');
        if (webcamVideo) {
          webcamVideo.srcObject = webcamStream;
          webcamVideo.play().catch(() => {});
        }
        offCanvas = document.createElement('canvas');
        offCtx = offCanvas.getContext('2d');
      }

      const cropArea = isCustomCrop ? options.cropArea : null;

      const transformer = new TransformStream({
        async transform(frame, controller) {
          const codedW = frame.codedWidth;
          const codedH = frame.codedHeight;

          let sx = 0;
          let sy = 0;
          let sw = codedW;
          let sh = codedH;

          if (cropArea) {
            const screenW = cropArea.screenWidth || codedW;
            const screenH = cropArea.screenHeight || codedH;
            const scaleX = codedW / screenW;
            const scaleY = codedH / screenH;

            // Enforce even dimensions (required by many video codecs)
            sx = Math.max(0, Math.floor((cropArea.x * scaleX) / 2) * 2);
            sy = Math.max(0, Math.floor((cropArea.y * scaleY) / 2) * 2);
            sw = Math.max(64, Math.floor((cropArea.width * scaleX) / 2) * 2);
            sh = Math.max(64, Math.floor((cropArea.height * scaleY) / 2) * 2);

            if (sx + sw > codedW) sw = Math.floor((codedW - sx) / 2) * 2;
            if (sy + sh > codedH) sh = Math.floor((codedH - sy) / 2) * 2;
          }

          if (hasWebcam && webcamVideo && webcamVideo.readyState >= 2 && offCtx) {
            // Composite screen sub-region + Webcam PiP
            if (offCanvas.width !== sw || offCanvas.height !== sh) {
              offCanvas.width = sw;
              offCanvas.height = sh;
            }

            // Draw screen frame (cropped or full)
            offCtx.drawImage(frame, sx, sy, sw, sh, 0, 0, sw, sh);

            // Calculate PiP dimensions and position
            const pipSize = options.webcamSize || Math.round(sh * 0.25);
            const pipShape = options.webcamShape || 'circle';
            const pipPos = options.webcamPosition || 'bottom-right';
            const margin = 24;

            let px = sw - pipSize - margin;
            let py = sh - pipSize - margin;
            if (pipPos === 'bottom-left') {
              px = margin;
              py = sh - pipSize - margin;
            } else if (pipPos === 'top-right') {
              px = sw - pipSize - margin;
              py = margin;
            } else if (pipPos === 'top-left') {
              px = margin;
              py = margin;
            }

            offCtx.save();
            offCtx.shadowColor = 'rgba(0, 0, 0, 0.45)';
            offCtx.shadowBlur = 10;

            if (pipShape === 'circle') {
              const radius = pipSize / 2;
              offCtx.beginPath();
              offCtx.arc(px + radius, py + radius, radius, 0, Math.PI * 2);
              offCtx.closePath();
              offCtx.clip();
              offCtx.drawImage(webcamVideo, px, py, pipSize, pipSize);
              offCtx.restore();

              // Glowing border
              offCtx.save();
              offCtx.strokeStyle = '#38bdf8';
              offCtx.lineWidth = 3;
              offCtx.beginPath();
              offCtx.arc(px + radius, py + radius, radius, 0, Math.PI * 2);
              offCtx.stroke();
              offCtx.restore();
            } else {
              const rectH = Math.round(pipSize * 0.75);
              offCtx.beginPath();
              offCtx.roundRect(px, py, pipSize, rectH, 12);
              offCtx.closePath();
              offCtx.clip();
              offCtx.drawImage(webcamVideo, px, py, pipSize, rectH);
              offCtx.restore();

              offCtx.save();
              offCtx.strokeStyle = '#38bdf8';
              offCtx.lineWidth = 3;
              offCtx.beginPath();
              offCtx.roundRect(px, py, pipSize, rectH, 12);
              offCtx.stroke();
              offCtx.restore();
            }

            try {
              const outFrame = new VideoFrame(offCanvas, { timestamp: frame.timestamp });
              frame.close();
              controller.enqueue(outFrame);
            } catch (err) {
              controller.enqueue(frame);
            }
          } else {
            // Pure Region Crop - Zero-copy visibleRect in GPU memory
            try {
              const croppedFrame = new VideoFrame(frame, {
                visibleRect: { x: sx, y: sy, width: sw, height: sh },
                displayWidth: sw,
                displayHeight: sh
              });
              frame.close();
              controller.enqueue(croppedFrame);
            } catch (err) {
              controller.enqueue(frame);
            }
          }
        }
      });

      processor.readable.pipeThrough(transformer).pipeTo(generator.writable).catch((e) => {
        console.warn('Video pipeline stream closed:', e);
      });

      return {
        track: generator,
        cleanup: () => {
          try {
            generator.stop();
          } catch (e) {}
        }
      };
    } catch (pipelineErr) {
      console.warn('Insertable streams setup failed, falling back to direct track:', pipelineErr);
    }
  }

  // Graceful fallback to raw screen track
  return {
    track: screenVideoTrack,
    cleanup: () => {}
  };
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

        // Determine resolution for database metadata
        let recWidth = 1920;
        let recHeight = 1080;
        if (
          currentOptions.recordingAreaMode === 'custom' &&
          currentOptions.cropArea &&
          currentOptions.cropArea.width > 0
        ) {
          recWidth = currentOptions.cropArea.width;
          recHeight = currentOptions.cropArea.height;
        } else if (currentOptions.videoQuality === '4k') {
          recWidth = 3840;
          recHeight = 2160;
        } else if (currentOptions.videoQuality === '720p') {
          recWidth = 1280;
          recHeight = 720;
        }

        // Save into IndexedDB
        const recordingId = 'rec_' + Date.now();
        await saveRecording({
          id: recordingId,
          blob: seekableBlob,
          mimeType: seekableBlob.type,
          duration: totalDurationSec,
          fileSize: seekableBlob.size,
          width: recWidth,
          height: recHeight,
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
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (videoPipelineCleanup) {
    videoPipelineCleanup();
    videoPipelineCleanup = null;
  }
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
