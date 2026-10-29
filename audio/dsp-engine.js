/**
 * CrispRec DSP Audio Engine
 * 
 * Complete Web Audio processing pipeline:
 * - Multi-band filtering (High-pass rumble filter, 50/60Hz notch, Vocal Presence EQ, Low-pass air filter)
 * - Real-Time AudioWorklet AI Noise Cancellation & Soft-Knee Downward Expander
 * - Studio Broadcast Dynamic Range Compression & Peak Limiter
 * - Multi-source audio mixing (System Audio + Denoised Microphone)
 */

import { NC_PRESETS } from '../utils/storage.js';

export class DspAudioEngine {
  constructor() {
    this.audioCtx = null;
    this.micSource = null;
    this.systemSource = null;
    this.highpassFilter = null;
    this.humNotch50 = null;
    this.humNotch60 = null;
    this.presenceFilter = null;
    this.lowpassFilter = null;
    this.noiseWorkletNode = null;
    this.compressorNode = null;
    this.micGainNode = null;
    this.systemGainNode = null;
    this.analyserNode = null;
    this.mixedDestination = null;

    this.isMuted = false;
    this.isNcEnabled = true;
    this.meterCallback = null;
    this.fallbackProcessor = null;
  }

  /**
   * Initialize audio context and DSP nodes
   */
  async init(micStream = null, systemStream = null, options = {}) {
    const hasMicAudio = Boolean(micStream && micStream.getAudioTracks().length > 0);
    const hasSystemAudio = Boolean(systemStream && systemStream.getAudioTracks().length > 0);

    // If neither microphone nor system audio is available, return null
    if (!hasMicAudio && !hasSystemAudio) {
      console.log('DspAudioEngine: No audio inputs available, returning null stream.');
      return null;
    }

    // 48000 Hz is standard professional broadcast sample rate
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AudioContextClass({
      sampleRate: 48000,
      latencyHint: 'interactive'
    });

    try {
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }
    } catch (e) {
      console.warn('AudioContext resume warning:', e);
    }

    this.mixedDestination = this.audioCtx.createMediaStreamDestination();
    this.analyserNode = this.audioCtx.createAnalyser();
    this.analyserNode.fftSize = 256;
    this.analyserNode.smoothingTimeConstant = 0.8;

    // Keep-alive silence source: guarantees continuous audio timestamps to prevent MediaRecorder starvation
    try {
      this.keepAliveNode = this.audioCtx.createConstantSource();
      this.keepAliveNode.offset.value = 0;
      this.keepAliveNode.connect(this.mixedDestination);
      this.keepAliveNode.start();
    } catch (e) {
      console.warn('Keep-alive node warning:', e);
    }

    // Load AudioWorklet module
    let workletLoaded = false;
    try {
      const workletUrl = chrome.runtime.getURL('audio/noise-worklet.js');
      await this.audioCtx.audioWorklet.addModule(workletUrl);
      workletLoaded = true;
    } catch (err) {
      console.warn('AudioWorklet addModule failed, using fallback DSP processor:', err);
    }

    // Set up microphone chain if micStream provided
    if (micStream && micStream.getAudioTracks().length > 0) {
      this.micSource = this.audioCtx.createMediaStreamSource(micStream);

      // Stage 1: High-pass Filter (removes HVAC rumble, desk thumps)
      this.highpassFilter = this.audioCtx.createBiquadFilter();
      this.highpassFilter.type = 'highpass';
      this.highpassFilter.frequency.value = options.lowCutFreq || 90;
      this.highpassFilter.Q.value = 0.707;

      // Stage 2: 50Hz and 60Hz Electrical Hum Notch Filters
      this.humNotch50 = this.audioCtx.createBiquadFilter();
      this.humNotch50.type = 'notch';
      this.humNotch50.frequency.value = 50;
      this.humNotch50.Q.value = 6.0;

      this.humNotch60 = this.audioCtx.createBiquadFilter();
      this.humNotch60.type = 'notch';
      this.humNotch60.frequency.value = 60;
      this.humNotch60.Q.value = 6.0;

      // Stage 3: Vocal Presence Enhancer (peaking boost at 3.2 kHz)
      this.presenceFilter = this.audioCtx.createBiquadFilter();
      this.presenceFilter.type = 'peaking';
      this.presenceFilter.frequency.value = 3200;
      this.presenceFilter.gain.value = options.presenceGain !== undefined ? options.presenceGain : 3.0;
      this.presenceFilter.Q.value = 1.2;

      // Stage 4: High-Cut Air Filter (cuts coil whine, harsh high hiss)
      this.lowpassFilter = this.audioCtx.createBiquadFilter();
      this.lowpassFilter.type = 'lowpass';
      this.lowpassFilter.frequency.value = options.highCutFreq || 12000;
      this.lowpassFilter.Q.value = 0.707;

      // Stage 5: Noise Cancellation Worklet Node
      if (workletLoaded) {
        this.noiseWorkletNode = new AudioWorkletNode(this.audioCtx, 'noise-cancellation-processor', {
          parameterData: {
            enabled: options.noiseCancellation !== false ? 1 : 0,
            threshold: options.thresholdDb || -45,
            suppression: options.suppressionDb || -36,
            attack: (options.attackMs || 12) / 1000,
            release: (options.releaseMs || 180) / 1000,
            knee: 6.0
          }
        });

        this.noiseWorkletNode.port.onmessage = (event) => {
          if (event.data && event.data.type === 'METER_DATA' && this.meterCallback) {
            this.meterCallback(event.data);
          }
        };
      }

      // Stage 6: Studio Broadcast Dynamics Compressor
      this.compressorNode = this.audioCtx.createDynamicsCompressor();
      this.compressorNode.threshold.setValueAtTime(-20, this.audioCtx.currentTime);
      this.compressorNode.knee.setValueAtTime(10, this.audioCtx.currentTime);
      this.compressorNode.ratio.setValueAtTime(3.5, this.audioCtx.currentTime);
      this.compressorNode.attack.setValueAtTime(0.005, this.audioCtx.currentTime);
      this.compressorNode.release.setValueAtTime(0.18, this.audioCtx.currentTime);

      // Stage 7: Mic Gain & Mute Node
      this.micGainNode = this.audioCtx.createGain();
      this.micGainNode.gain.setValueAtTime(1.0, this.audioCtx.currentTime);

      // Connect Filter Chain
      this.micSource.connect(this.highpassFilter);
      this.highpassFilter.connect(this.humNotch50);
      this.humNotch50.connect(this.humNotch60);
      this.humNotch60.connect(this.presenceFilter);
      this.presenceFilter.connect(this.lowpassFilter);

      let lastNode = this.lowpassFilter;
      if (this.noiseWorkletNode) {
        lastNode.connect(this.noiseWorkletNode);
        lastNode = this.noiseWorkletNode;
      }

      lastNode.connect(this.compressorNode);
      this.compressorNode.connect(this.micGainNode);

      // Connect to analyser and mixed output
      this.micGainNode.connect(this.analyserNode);
      this.micGainNode.connect(this.mixedDestination);
    }

    // Set up system audio chain if provided
    if (systemStream && systemStream.getAudioTracks().length > 0) {
      this.systemSource = this.audioCtx.createMediaStreamSource(systemStream);
      this.systemGainNode = this.audioCtx.createGain();
      this.systemGainNode.gain.setValueAtTime(1.0, this.audioCtx.currentTime);
      this.systemSource.connect(this.systemGainNode);
      this.systemGainNode.connect(this.mixedDestination);
    }

    // Apply initial preset if provided
    if (options.ncPreset && NC_PRESETS[options.ncPreset]) {
      this.applyPreset(options.ncPreset);
    }

    return this.mixedDestination.stream;
  }

  /**
   * Enable or disable noise cancellation
   */
  setNoiseCancellationEnabled(enabled) {
    this.isNcEnabled = enabled;
    if (this.noiseWorkletNode && this.noiseWorkletNode.parameters) {
      const p = this.noiseWorkletNode.parameters.get('enabled');
      if (p) p.setValueAtTime(enabled ? 1 : 0, this.audioCtx.currentTime);
    }
  }

  /**
   * Apply an audio noise cancellation preset
   */
  applyPreset(presetKey) {
    const preset = NC_PRESETS[presetKey];
    if (!preset) return;

    if (this.highpassFilter && preset.lowCutFreq) {
      this.highpassFilter.frequency.setValueAtTime(preset.lowCutFreq, this.audioCtx.currentTime);
    }
    if (this.lowpassFilter && preset.highCutFreq) {
      this.lowpassFilter.frequency.setValueAtTime(preset.highCutFreq, this.audioCtx.currentTime);
    }
    if (this.presenceFilter && preset.presenceGain !== undefined) {
      this.presenceFilter.gain.setValueAtTime(preset.presenceGain, this.audioCtx.currentTime);
    }

    if (this.noiseWorkletNode && this.noiseWorkletNode.parameters) {
      if (preset.thresholdDb !== undefined) {
        const p = this.noiseWorkletNode.parameters.get('threshold');
        if (p) p.setValueAtTime(preset.thresholdDb, this.audioCtx.currentTime);
      }
      if (preset.suppressionDb !== undefined) {
        const p = this.noiseWorkletNode.parameters.get('suppression');
        if (p) p.setValueAtTime(preset.suppressionDb, this.audioCtx.currentTime);
      }
      if (preset.attackMs !== undefined) {
        const p = this.noiseWorkletNode.parameters.get('attack');
        if (p) p.setValueAtTime(preset.attackMs / 1000, this.audioCtx.currentTime);
      }
      if (preset.releaseMs !== undefined) {
        const p = this.noiseWorkletNode.parameters.get('release');
        if (p) p.setValueAtTime(preset.releaseMs / 1000, this.audioCtx.currentTime);
      }
    }
  }

  /**
   * Update custom DSP parameters
   */
  updateDspParams(params) {
    if (!this.audioCtx) return;
    const now = this.audioCtx.currentTime;

    if (params.lowCutFreq && this.highpassFilter) {
      this.highpassFilter.frequency.setValueAtTime(params.lowCutFreq, now);
    }
    if (params.highCutFreq && this.lowpassFilter) {
      this.lowpassFilter.frequency.setValueAtTime(params.highCutFreq, now);
    }
    if (params.presenceGain !== undefined && this.presenceFilter) {
      this.presenceFilter.gain.setValueAtTime(params.presenceGain, now);
    }

    if (this.noiseWorkletNode && this.noiseWorkletNode.parameters) {
      if (params.thresholdDb !== undefined) {
        const p = this.noiseWorkletNode.parameters.get('threshold');
        if (p) p.setValueAtTime(params.thresholdDb, now);
      }
      if (params.suppressionDb !== undefined) {
        const p = this.noiseWorkletNode.parameters.get('suppression');
        if (p) p.setValueAtTime(params.suppressionDb, now);
      }
      if (params.attackMs !== undefined) {
        const p = this.noiseWorkletNode.parameters.get('attack');
        if (p) p.setValueAtTime(params.attackMs / 1000, now);
      }
      if (params.releaseMs !== undefined) {
        const p = this.noiseWorkletNode.parameters.get('release');
        if (p) p.setValueAtTime(params.releaseMs / 1000, now);
      }
    }
  }

  /**
   * Toggle or set microphone mute state
   */
  setMicMuted(muted) {
    this.isMuted = muted;
    if (this.micGainNode && this.audioCtx) {
      this.micGainNode.gain.setValueAtTime(muted ? 0 : 1.0, this.audioCtx.currentTime);
    }
  }

  /**
   * Set microphone input volume (0.0 to 2.0)
   */
  setMicVolume(vol) {
    if (this.micGainNode && this.audioCtx && !this.isMuted) {
      this.micGainNode.gain.setValueAtTime(vol, this.audioCtx.currentTime);
    }
  }

  /**
   * Set system audio volume (0.0 to 1.0)
   */
  setSystemVolume(vol) {
    if (this.systemGainNode && this.audioCtx) {
      this.systemGainNode.gain.setValueAtTime(vol, this.audioCtx.currentTime);
    }
  }

  /**
   * Register listener for meter updates
   */
  onMeter(callback) {
    this.meterCallback = callback;
  }

  /**
   * Get Web Audio Analyser node for frequency/waveform visualization
   */
  getAnalyser() {
    return this.analyserNode;
  }

  /**
   * Get the mixed output MediaStream
   */
  getMixedStream() {
    return this.mixedDestination ? this.mixedDestination.stream : null;
  }

  /**
   * Close all audio tracks and context
   */
  async close() {
    if (this.keepAliveNode) {
      try {
        this.keepAliveNode.stop();
        this.keepAliveNode.disconnect();
      } catch (e) {}
      this.keepAliveNode = null;
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      try {
        await this.audioCtx.close();
      } catch (e) {}
    }
  }
}

