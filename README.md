# CrispRec: AI Noise-Cancelling Screen Recorder
> **Modern Chrome Extension (Manifest V3)** designed for high-definition screen & webcam recording with real-time digital signal processing (DSP) noise cancellation, microphone denoising, floating in-page controls, and an instant video preview studio.

---

## 🌟 Key Features

- **Real-Time AI Noise Cancellation**:
  - Web Audio `AudioWorkletProcessor` running on the high-priority audio render thread.
  - Sub-bass rumble high-pass filter (cuts 80–200 Hz HVAC hum, computer fan vibrations, and desk thuds).
  - 50 Hz & 60 Hz electrical mains hum notch filters.
  - Soft-knee downward expander and dynamic noise gate to eliminate room background hiss during speech pauses.
  - Vocal presence booster (+3 dB at 3.2 kHz) for broadcast-quality speech clarity.
  - Studio dynamics compressor and peak limiter to prevent distortion and clipping.
- **Audio Profile Presets**:
  - 🟢 **Balanced Voice**: Default setting for online meetings, presentations, and tutorials.
  - 🎙️ **Studio Podcast**: Warm low-end, rich presence EQ, gentle gating, and broadcast compression.
  - 🌪️ **Fan & Room Killer**: Aggressive suppression for noisy mechanical keyboards and loud laptop cooling fans.
  - 🎛️ **Custom Pro DSP**: Full manual control over gate threshold, suppression depth, low-cut, and high-cut frequencies.
- **High-Definition Screen Capture**:
  - Capture **Entire Screen / Desktop** (multi-monitor support), **Specific Application Window**, or **Browser Tab**.
  - Crisp resolution options: **1080p Full HD**, **720p HD**, and **4K Ultra HD** at up to **60 FPS**.
  - System audio capture cleanly mixed with denoised microphone audio.
- **Webcam Picture-in-Picture (PiP) Overlay**:
  - Optional circular or rounded camera overlay composited onto the screen recording.
  - Configurable anchor corners (Bottom-Right, Bottom-Left, Top-Right, Top-Left) and size options.
- **Seekable WebM EBML Patcher**:
  - Resolves Chrome's `MediaRecorder` indefinite duration bug (`Infinity` duration) by injecting exact millisecond duration into WebM Segment Info headers.
- **In-Page Floating Recording Bar**:
  - Shadow-DOM isolated widget injected into active tabs.
  - Draggable anywhere on the screen with live elapsed timer, pause/resume, mic mute, and stop actions.
- **Post-Recording Studio & Library**:
  - Instant HTML5 playback player with scrubber, speed controls (0.5x to 2x), and volume sliders.
  - Inline title renaming with automatic persistence.
  - **Export Denoised Audio**: Extract cleaned 16-bit PCM `.wav` directly from video.
  - **Persistent Local Library**: Recordings stored safely in browser `IndexedDB`.
- **Global Keyboard Shortcuts**:
  - `Alt + Shift + R`: Start / Stop recording
  - `Alt + Shift + P`: Pause / Resume recording
  - `Alt + Shift + M`: Mute / Unmute microphone

---

## 📁 Project Architecture

```
noise-cancellation-screen-record/
├── manifest.json              # Manifest V3 configuration & permissions
├── background.js              # Service Worker: lifecycle, hotkeys, offscreen manager
├── offscreen.html             # DOM context for MediaRecorder & AudioContext
├── offscreen.js               # Media stream acquisition, mixer, canvas compositing
├── audio/
│   ├── noise-worklet.js       # Real-time Web Audio Worklet (downward expander & gate)
│   ├── dsp-engine.js          # Multi-stage Web Audio filter bank & compressor graph
│   └── ebml-patcher.js        # WebM binary parser & seekable duration patcher
├── popup/
│   ├── popup.html             # Sleek dark glassmorphism popup UI
│   ├── popup.css              # Custom styling, switches, and glowing meters
│   └── popup.js               # Setup controls, device selection, mic test visualizer
├── content/
│   ├── content.js             # Draggable floating bar (Shadow DOM isolated)
│   └── content.css            # Host positioning & isolation styling
├── preview/
│   ├── preview.html           # Post-recording studio, video player, and library
│   ├── preview.css            # Studio layout styling
│   └── preview.js             # Scrubbing, WAV extraction, IndexedDB management
├── options/
│   ├── options.html           # Full-page settings & DSP parameter customizer
│   ├── options.css            # Settings dashboard styling
│   └── options.js             # Auto-save preferences controller
├── utils/
│   ├── storage.js             # chrome.storage.local wrapper & preset definitions
│   ├── db.js                  # IndexedDB persistent media storage manager
│   └── visualizer.js          # Canvas 60 FPS spectrum analyzer & VU meter
├── icons/                     # Sharp PNG & SVG extension icons (16, 32, 48, 128)
└── generate-icons.js          # Pure Node.js PNG generator
```

---

## 🚀 How to Install and Run in Google Chrome

1. Open Google Chrome and navigate to:
   ```
   chrome://extensions
   ```
2. In the top-right corner, toggle **Developer mode** to **ON**.
3. Click the **Load unpacked** button in the top-left corner.
4. Select the directory:
   ```
   d:\noise-cancellation-screen-record
   ```
5. The **CrispRec: Noise-Cancelling Screen Recorder** extension icon will appear in your Chrome toolbar.
6. (Optional) Pin the extension icon to your toolbar for 1-click access.

---

## 🎙️ How to Use

1. Click the CrispRec toolbar icon to open the popup.
2. Select your desired inputs:
   - **Microphone**: Toggle ON and pick your microphone.
   - **System Audio**: Toggle ON to record tab/desktop audio.
   - **Webcam Overlay**: Toggle ON if you want a picture-in-picture camera bubble.
3. Choose an **AI Noise Profile**:
   - `Balanced` (Default)
   - `Studio` (Rich podcast warmth)
   - `Fan Killer` (Heavy background noise reduction)
   - `Pro DSP` (Fine-tune your own gate and filters)
4. Click **Test Mic** to speak into your microphone and view the real-time spectrum and voice activity indicator on the canvas.
5. Click **Start Recording** (or press <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>R</kbd>).
6. Pick your screen, window, or tab from Chrome's native prompt.
7. While recording:
   - Use the in-page floating toolbar or keyboard shortcuts to Pause, Resume, or Mute.
8. When finished, click **Stop**:
   - The **CrispRec Studio** opens automatically with full playback, seekability, and 1-click download options!

---

## 🔬 DSP Noise Cancellation Pipeline

```
[Microphone In] 
       │
       ▼
[High-Pass Filter (80-160 Hz)]  --> Eliminates desk bumps, room vibrations, AC rumble
       │
       ▼
[50 Hz / 60 Hz Notch Filters]   --> Removes electrical hum & ground loops
       │
       ▼
[Vocal Presence EQ (3.2 kHz)]   --> Boosts vocal clarity & speech intelligibility
       │
       ▼
[High-Cut Air Filter (12 kHz)]  --> Cuts ultrasonic coil whine and hiss
       │
       ▼
[AudioWorklet Downward Expander] -> Soft-knee noise gate with adaptive noise-floor tracking
       │
       ▼
[Dynamics Compressor & Limiter] --> Leveling & digital peak protection
       │
       ▼
[Mixed Audio Stream Destination] <-- Combined with System Audio from desktop share
```

---

## 🛡️ Best Practices Followed

- **Manifest V3 Compliant**: Follows Google Chrome MV3 architecture using an Offscreen Document for persistent media processing without blocking service worker timeouts.
- **Shadow DOM Isolation**: The in-page floating toolbar uses an isolated Shadow Root so host page CSS cannot break extension styling, and extension CSS cannot bleed into websites.
- **Seekable WebM Standard**: Fixes the Chromium `MediaRecorder` duration bug by injecting proper EBML timecode headers.
- **Fail-Safe Capture Fallback**: Handles cases where the user deselects audio in the native screen picker by automatically falling back to video-only capture.
- **Offline & Private**: 100% of audio DSP processing, video recording, and storage occurs locally on your machine. No video or audio is ever sent to external cloud servers.

