/**
 * CrispRec Real-Time AI Noise Cancellation AudioWorkletProcessor
 * 
 * Provides low-latency, zero-stutter downward expansion, adaptive noise gate,
 * soft-knee voice isolation, and transient preservation on the Web Audio render thread.
 */

class NoiseCancellationProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'enabled', defaultValue: 1, minValue: 0, maxValue: 1 },
      { name: 'threshold', defaultValue: -45, minValue: -80, maxValue: -10 }, // dB
      { name: 'suppression', defaultValue: -36, minValue: -60, maxValue: 0 }, // dB
      { name: 'attack', defaultValue: 0.012, minValue: 0.001, maxValue: 0.1 }, // seconds
      { name: 'release', defaultValue: 0.180, minValue: 0.020, maxValue: 0.5 }, // seconds
      { name: 'hold', defaultValue: 0.060, minValue: 0.005, maxValue: 0.2 }, // seconds
      { name: 'knee', defaultValue: 6.0, minValue: 1.0, maxValue: 12.0 } // dB
    ];
  }

  constructor() {
    super();
    this.currentGain = 1.0;
    this.holdFramesRemaining = 0;
    this.noiseFloorDb = -60.0;
    this.sampleRateVal = 48000;
    this.meterUpdateCounter = 0;
    this.peakInputDb = -100;
    this.peakOutputDb = -100;

    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'RESET') {
        this.currentGain = 1.0;
        this.holdFramesRemaining = 0;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];

    // If no input channels, continue
    if (!input || input.length === 0) {
      return true;
    }

    const numChannels = input.length;
    const blockSize = input[0].length; // typically 128 samples

    const enabled = parameters.enabled[0] > 0.5;
    const thresholdDb = parameters.threshold[0];
    const suppressionDb = parameters.suppression[0];
    const attackSec = parameters.attack[0];
    const releaseSec = parameters.release[0];
    const holdSec = parameters.hold[0];
    const kneeDb = parameters.knee[0];

    // If disabled / bypassed, copy input straight to output
    if (!enabled) {
      for (let ch = 0; ch < numChannels; ch++) {
        output[ch].set(input[ch]);
      }
      this.sendMeterUpdate(-100, -100, 0, false);
      return true;
    }

    // 1. Calculate RMS energy across all channels for this block
    let sumSquares = 0;
    let sampleCount = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const channelData = input[ch];
      for (let i = 0; i < blockSize; i++) {
        const val = channelData[i];
        sumSquares += val * val;
        sampleCount++;
      }
    }

    const rms = Math.sqrt(sumSquares / Math.max(1, sampleCount));
    const inputDb = rms > 0.000001 ? 20 * Math.log10(rms) : -100;

    // Track stationary noise floor during quiet periods
    if (inputDb < this.noiseFloorDb + 8 && inputDb > -90) {
      this.noiseFloorDb = 0.995 * this.noiseFloorDb + 0.005 * inputDb;
    } else if (inputDb < this.noiseFloorDb) {
      this.noiseFloorDb = inputDb;
    }

    // 2. Soft-knee expansion curve
    const halfKnee = kneeDb / 2;
    const lowerBound = thresholdDb - halfKnee;
    const upperBound = thresholdDb + halfKnee;

    let targetGainDb = 0;
    let isSpeaking = false;

    if (inputDb >= upperBound) {
      // Voice active: 0dB (unity gain)
      targetGainDb = 0;
      isSpeaking = true;
      this.holdFramesRemaining = Math.round(holdSec * (48000 / blockSize));
    } else if (inputDb <= lowerBound) {
      // Below knee: full attenuation
      if (this.holdFramesRemaining > 0) {
        this.holdFramesRemaining--;
        targetGainDb = 0;
        isSpeaking = true;
      } else {
        targetGainDb = suppressionDb;
        isSpeaking = false;
      }
    } else {
      // Inside soft-knee zone: smooth cubic Hermite interpolation
      if (this.holdFramesRemaining > 0) {
        this.holdFramesRemaining--;
        targetGainDb = 0;
        isSpeaking = true;
      } else {
        const norm = (inputDb - lowerBound) / kneeDb; // 0.0 to 1.0
        const smoothFactor = norm * norm * (3 - 2 * norm); // S-curve
        targetGainDb = suppressionDb * (1.0 - smoothFactor);
        isSpeaking = norm > 0.5;
      }
    }

    const targetGain = Math.pow(10, targetGainDb / 20);

    // 3. Envelope ballistics: Asymmetric Attack & Release coefficients
    // Attack: fast transition up when voice begins
    // Release: smooth decay down to suppress background noise without sudden click
    const attackCoeff = 1.0 - Math.exp(-blockSize / (attackSec * 48000));
    const releaseCoeff = 1.0 - Math.exp(-blockSize / (releaseSec * 48000));

    const startGain = this.currentGain;
    const coeff = targetGain > startGain ? attackCoeff : releaseCoeff;
    const endGain = startGain + (targetGain - startGain) * coeff;
    this.currentGain = endGain;

    // 4. Sample-accurate gain interpolation to eliminate zipper noise
    const gainStep = (endGain - startGain) / blockSize;

    let blockMaxOut = 0;
    for (let i = 0; i < blockSize; i++) {
      const g = startGain + gainStep * i;
      for (let ch = 0; ch < numChannels; ch++) {
        const outVal = input[ch][i] * g;
        output[ch][i] = outVal;
        const absVal = Math.abs(outVal);
        if (absVal > blockMaxOut) blockMaxOut = absVal;
      }
    }

    const outputDb = blockMaxOut > 0.000001 ? 20 * Math.log10(blockMaxOut) : -100;
    const gainReductionDb = targetGainDb;

    // 5. Throttled UI metering update (~30 times/sec)
    this.meterUpdateCounter++;
    if (this.meterUpdateCounter >= 12) { // 12 * 128 / 48000 = ~32ms
      this.meterUpdateCounter = 0;
      this.sendMeterUpdate(inputDb, outputDb, gainReductionDb, isSpeaking);
    }

    return true;
  }

  sendMeterUpdate(inputDb, outputDb, gainReductionDb, isSpeaking) {
    this.port.postMessage({
      type: 'METER_DATA',
      inputDb: Math.round(inputDb * 10) / 10,
      outputDb: Math.round(outputDb * 10) / 10,
      gainReductionDb: Math.round(gainReductionDb * 10) / 10,
      isSpeaking: isSpeaking,
      noiseFloorDb: Math.round(this.noiseFloorDb * 10) / 10
    });
  }
}

registerProcessor('noise-cancellation-processor', NoiseCancellationProcessor);

