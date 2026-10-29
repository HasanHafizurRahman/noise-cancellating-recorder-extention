/**
 * CrispRec Recording Studio & Preview Controller
 * Handles HD/4K video playback, custom player scrubbing, WAV audio extraction,
 * metadata editing, and local recordings library.
 */

import { getRecording, getAllRecordings, deleteRecording, updateRecording, getStorageUsage } from '../utils/db.js';

let currentRecording = null;
let currentBlobUrl = null;

// DOM references
const player = document.getElementById('player');
const playPauseBtn = document.getElementById('play-pause-btn');
const playIcon = document.getElementById('play-icon');
const progressWrap = document.getElementById('progress-wrap');
const progressFill = document.getElementById('progress-fill');
const scrubber = document.getElementById('scrubber');
const currentTimeEl = document.getElementById('current-time');
const totalDurationEl = document.getElementById('total-duration');
const skipBackBtn = document.getElementById('skip-back-btn');
const skipFwdBtn = document.getElementById('skip-fwd-btn');

const speedBtn = document.getElementById('speed-btn');
const speedMenu = document.getElementById('speed-menu');
const muteBtn = document.getElementById('mute-btn');
const volIcon = document.getElementById('vol-icon');
const volSlider = document.getElementById('vol-slider');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const videoWrapper = document.getElementById('video-wrapper');

const titleInput = document.getElementById('recording-title-input');
const saveTitleBtn = document.getElementById('save-title-btn');
const metaDuration = document.getElementById('meta-duration');
const metaSize = document.getElementById('meta-size');
const metaRes = document.getElementById('meta-res');
const metaNc = document.getElementById('meta-nc');

const downloadWebmBtn = document.getElementById('download-webm-btn');
const exportAudioWavBtn = document.getElementById('export-audio-wav-btn');
const copyVideoBtn = document.getElementById('copy-video-btn');
const deleteRecordingBtn = document.getElementById('delete-recording-btn');

const toggleLibraryBtn = document.getElementById('toggle-library-btn');
const libraryDrawer = document.getElementById('library-drawer');
const closeLibraryBtn = document.getElementById('close-library-btn');
const libraryItemsContainer = document.getElementById('library-items-container');
const libraryCount = document.getElementById('library-count');
const storageUsageText = document.getElementById('storage-usage-text');

document.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const targetId = urlParams.get('id');
  const view = urlParams.get('view');

  await loadRecording(targetId);
  await refreshLibrary();

  if (view === 'library') {
    openLibraryDrawer();
  }

  setupEventListeners();
});

async function loadRecording(id) {
  let rec = null;
  if (id) {
    rec = await getRecording(id);
  }

  if (!rec) {
    // Fall back to most recent recording
    const all = await getAllRecordings();
    if (all.length > 0) {
      rec = all[0];
    }
  }

  if (!rec) {
    showEmptyStudio();
    return;
  }

  currentRecording = rec;

  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
  }
  currentBlobUrl = URL.createObjectURL(rec.blob);
  player.src = currentBlobUrl;

  titleInput.value = rec.title || 'Untitled Recording';
  metaDuration.textContent = formatTime(rec.duration || 0);
  metaSize.textContent = `${(rec.fileSize / (1024 * 1024)).toFixed(1)} MB`;
  metaRes.textContent = `${rec.width || 1920} x ${rec.height || 1080}`;
  
  const presetLabels = {
    balanced: '🛡️ Balanced AI Voice',
    studio: '🎙️ Studio Podcast',
    aggressive: '🌪️ Fan & HVAC Killer',
    custom: '🎛️ Custom Pro DSP'
  };
  metaNc.textContent = rec.hasNoiseCancellation
    ? presetLabels[rec.preset] || '🛡️ AI Denoised'
    : 'Raw Audio (No NC)';

  totalDurationEl.textContent = formatTime(rec.duration || 0);
}

function showEmptyStudio() {
  titleInput.value = 'No Recordings Found';
  titleInput.disabled = true;
  saveTitleBtn.disabled = true;
  downloadWebmBtn.disabled = true;
  exportAudioWavBtn.disabled = true;
  deleteRecordingBtn.disabled = true;
  metaDuration.textContent = '00:00';
  metaSize.textContent = '0 MB';
  metaRes.textContent = '--';
  metaNc.textContent = '--';
}

function setupEventListeners() {
  // Video playback
  playPauseBtn.addEventListener('click', togglePlayPause);
  player.addEventListener('click', togglePlayPause);

  player.addEventListener('play', () => {
    playIcon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
  });

  player.addEventListener('pause', () => {
    playIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
  });

  player.addEventListener('timeupdate', () => {
    const dur = player.duration || currentRecording?.duration || 1;
    const progress = (player.currentTime / dur) * 100;
    progressFill.style.width = `${progress}%`;
    scrubber.style.left = `${progress}%`;
    currentTimeEl.textContent = formatTime(Math.floor(player.currentTime));
  });

  player.addEventListener('loadedmetadata', () => {
    if (player.duration && isFinite(player.duration)) {
      totalDurationEl.textContent = formatTime(Math.floor(player.duration));
    }
  });

  // Scrubbing
  progressWrap.addEventListener('click', (e) => {
    const rect = progressWrap.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    const dur = player.duration || currentRecording?.duration || 0;
    player.currentTime = pos * dur;
  });

  // Skip buttons
  skipBackBtn.addEventListener('click', () => {
    player.currentTime = Math.max(0, player.currentTime - 5);
  });

  skipFwdBtn.addEventListener('click', () => {
    const dur = player.duration || currentRecording?.duration || 0;
    player.currentTime = Math.min(dur, player.currentTime + 5);
  });

  // Speed controls
  speedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    speedMenu.classList.toggle('hidden');
  });

  document.querySelectorAll('.dropdown-item').forEach((item) => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.dropdown-item').forEach((i) => i.classList.remove('active'));
      item.classList.add('active');
      const rate = parseFloat(item.dataset.speed);
      player.playbackRate = rate;
      speedBtn.textContent = `${rate}x`;
      speedMenu.classList.add('hidden');
    });
  });

  document.addEventListener('click', () => {
    speedMenu.classList.add('hidden');
  });

  // Volume
  volSlider.addEventListener('input', () => {
    player.volume = parseFloat(volSlider.value);
    player.muted = false;
    updateVolIcon();
  });

  muteBtn.addEventListener('click', () => {
    player.muted = !player.muted;
    updateVolIcon();
  });

  // Fullscreen
  fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      videoWrapper.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  // Keyboard navigation
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlayPause();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      player.currentTime = Math.max(0, player.currentTime - 5);
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      const dur = player.duration || currentRecording?.duration || 0;
      player.currentTime = Math.min(dur, player.currentTime + 5);
    }
  });

  // Save title
  saveTitleBtn.addEventListener('click', async () => {
    if (!currentRecording) return;
    const newTitle = titleInput.value.trim() || 'Untitled Recording';
    await updateRecording(currentRecording.id, { title: newTitle });
    currentRecording.title = newTitle;
    await refreshLibrary();
    saveTitleBtn.textContent = 'Saved!';
    setTimeout(() => (saveTitleBtn.textContent = 'Save'), 1500);
  });

  // Download WebM
  downloadWebmBtn.addEventListener('click', () => {
    if (!currentRecording || !currentRecording.blob) return;
    const filename = sanitizeFilename(currentRecording.title) + '.webm';
    triggerDownload(currentRecording.blob, filename);
  });

  // Export Audio WAV
  exportAudioWavBtn.addEventListener('click', async () => {
    if (!currentRecording || !currentRecording.blob) return;
    exportAudioWavBtn.disabled = true;
    exportAudioWavBtn.querySelector('.export-btn-title').textContent = 'Extracting WAV...';

    try {
      const wavBlob = await extractAudioToWav(currentRecording.blob);
      const filename = sanitizeFilename(currentRecording.title) + '_audio.wav';
      triggerDownload(wavBlob, filename);
    } catch (err) {
      console.error('Audio extraction failed:', err);
      alert('Could not export audio: ' + err.message);
    } finally {
      exportAudioWavBtn.disabled = false;
      exportAudioWavBtn.querySelector('.export-btn-title').textContent = 'Export Denoised Audio';
    }
  });

  // Copy to clipboard
  copyVideoBtn.addEventListener('click', async () => {
    if (!currentRecording || !currentRecording.blob) return;
    try {
      const clipboardItem = new ClipboardItem({ [currentRecording.blob.type]: currentRecording.blob });
      await navigator.clipboard.write([clipboardItem]);
      alert('Recording copied to clipboard!');
    } catch (err) {
      // Fallback
      navigator.clipboard.writeText(window.location.href);
      alert('Link to recording copied to clipboard!');
    }
  });

  // Delete recording
  deleteRecordingBtn.addEventListener('click', async () => {
    if (!currentRecording) return;
    const confirmed = confirm(`Are you sure you want to delete "${currentRecording.title}"?`);
    if (confirmed) {
      await deleteRecording(currentRecording.id);
      await loadRecording(null);
      await refreshLibrary();
    }
  });

  // Library Drawer toggle
  toggleLibraryBtn.addEventListener('click', openLibraryDrawer);
  closeLibraryBtn.addEventListener('click', closeLibraryDrawer);
}

function togglePlayPause() {
  if (player.paused) {
    player.play();
  } else {
    player.pause();
  }
}

function updateVolIcon() {
  if (player.muted || player.volume === 0) {
    volIcon.innerHTML = '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>';
  } else {
    volIcon.innerHTML = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
  }
}

function openLibraryDrawer() {
  libraryDrawer.classList.remove('hidden');
}

function closeLibraryDrawer() {
  libraryDrawer.classList.add('hidden');
}

async function refreshLibrary() {
  const recordings = await getAllRecordings();
  const usage = await getStorageUsage();

  libraryCount.textContent = recordings.length;
  storageUsageText.textContent = `${recordings.length} recordings • ${usage.megabytes} MB used`;

  libraryItemsContainer.innerHTML = '';
  if (recordings.length === 0) {
    libraryItemsContainer.innerHTML = '<div style="color:#64748b; font-size:12px; text-align:center; padding:20px;">No recordings yet.</div>';
    return;
  }

  recordings.forEach((rec) => {
    const item = document.createElement('div');
    item.className = `library-item ${currentRecording && currentRecording.id === rec.id ? 'active' : ''}`;
    item.innerHTML = `
      <div class="lib-meta">
        <h4>${escapeHtml(rec.title)}</h4>
        <div class="lib-sub">
          <span>⏱️ ${formatTime(rec.duration || 0)}</span>
          <span>💾 ${(rec.fileSize / (1024 * 1024)).toFixed(1)} MB</span>
          <span>📅 ${new Date(rec.createdAt).toLocaleDateString()}</span>
        </div>
      </div>
      <div class="lib-actions">
        <button class="lib-del-btn" title="Delete">&times;</button>
      </div>
    `;

    item.addEventListener('click', (e) => {
      if (e.target.closest('.lib-del-btn')) {
        e.stopPropagation();
        deleteRecording(rec.id).then(() => {
          if (currentRecording && currentRecording.id === rec.id) {
            loadRecording(null);
          }
          refreshLibrary();
        });
        return;
      }
      loadRecording(rec.id);
      refreshLibrary();
      closeLibraryDrawer();
    });

    libraryItemsContainer.appendChild(item);
  });
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

/**
 * Extracts and decodes audio from WebM video blob and renders a 16-bit PCM WAV
 */
async function extractAudioToWav(videoBlob) {
  const arrayBuffer = await videoBlob.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  // Convert AudioBuffer to 16-bit PCM WAV
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length * numChannels * 2;
  const buffer = new ArrayBuffer(44 + length);
  const view = new DataView(buffer);

  // RIFF Chunk
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + length, true);
  writeString(view, 8, 'WAVE');

  // fmt Sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true); // ByteRate
  view.setUint16(32, numChannels * 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample

  // data Sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, length, true);

  // Write interleaved PCM samples
  let offset = 44;
  for (let i = 0; i < audioBuffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let sample = audioBuffer.getChannelData(ch)[i];
      sample = Math.max(-1, Math.min(1, sample));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  await audioCtx.close();
  return new Blob([view], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function sanitizeFilename(name) {
  return (name || 'recording').replace(/[^a-z0-9_\-\s]/gi, '_').trim();
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

