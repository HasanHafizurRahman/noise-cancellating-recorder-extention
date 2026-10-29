/**
 * CrispRec Real-Time Canvas Audio Visualizer
 * Renders smooth 60fps frequency spectrum bars, waveform oscilloscope,
 * and VU meter on HTML5 Canvas.
 */

export class AudioVisualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.analyser = null;
    this.animationId = null;
    this.dataArray = null;
    this.timeDomainArray = null;
    this.meterData = { inputDb: -100, outputDb: -100, isSpeaking: false };
    this.active = false;
  }

  attach(analyser) {
    this.analyser = analyser;
    const bufferLength = analyser.frequencyBinCount; // 128
    this.dataArray = new Uint8Array(bufferLength);
    this.timeDomainArray = new Uint8Array(bufferLength);
    this.active = true;
    this.render();
  }

  updateMeter(meterData) {
    this.meterData = meterData;
  }

  render() {
    if (!this.active) return;
    this.animationId = requestAnimationFrame(() => this.render());

    const { width, height } = this.canvas;
    const ctx = this.ctx;

    // Clear with dark tech gradient
    ctx.clearRect(0, 0, width, height);

    if (!this.analyser) {
      this.drawIdleState(width, height);
      return;
    }

    this.analyser.getByteFrequencyData(this.dataArray);
    this.analyser.getByteTimeDomainData(this.timeDomainArray);

    // Draw Frequency Bars (cyan-to-emerald modern glow)
    const numBars = 32;
    const barSpacing = 3;
    const totalSpacing = (numBars - 1) * barSpacing;
    const barWidth = Math.max(2, (width - 40 - totalSpacing) / numBars);
    const startX = 20;

    // Create Gradient
    const gradient = ctx.createLinearGradient(0, height, 0, 10);
    gradient.addColorStop(0, '#06b6d4'); // Cyan 500
    gradient.addColorStop(0.5, '#10b981'); // Emerald 500
    gradient.addColorStop(1, '#a7f3d0'); // Emerald 200 (glow top)

    for (let i = 0; i < numBars; i++) {
      // Sample logarithmic frequencies for natural acoustic balance
      const freqIndex = Math.min(this.dataArray.length - 1, Math.floor(Math.pow(i / numBars, 1.6) * this.dataArray.length));
      const val = this.dataArray[freqIndex] || 0;
      const barHeight = Math.max(3, (val / 255) * (height - 35));

      const bx = startX + i * (barWidth + barSpacing);
      const by = height - 15 - barHeight;

      ctx.fillStyle = gradient;
      // Draw rounded bar
      ctx.beginPath();
      ctx.roundRect(bx, by, barWidth, barHeight, [2, 2, 0, 0]);
      ctx.fill();

      // Bar peak dot
      if (barHeight > 8) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(bx, by - 2, barWidth, 1.5);
      }
    }

    // Draw Smooth Waveform Line Overlay
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
    ctx.beginPath();
    const sliceWidth = width / this.timeDomainArray.length;
    let x = 0;
    for (let i = 0; i < this.timeDomainArray.length; i++) {
      const v = this.timeDomainArray[i] / 128.0;
      const y = (v * (height - 30)) / 2 + 10;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.stroke();

    // Draw Status Pill (Voice Active / Noise Gate Closed)
    const isVoice = this.meterData.isSpeaking;
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    const statusText = isVoice ? '🎙️ VOICE ACTIVE' : '🛡️ NOISE SUPPRESSED';
    const statusBg = isVoice ? 'rgba(16, 185, 129, 0.25)' : 'rgba(59, 130, 246, 0.15)';
    const statusColor = isVoice ? '#34d399' : '#93c5fd';

    ctx.fillStyle = statusBg;
    ctx.beginPath();
    ctx.roundRect(width - 140, 8, 125, 20, 10);
    ctx.fill();

    ctx.fillStyle = statusColor;
    ctx.fillText(statusText, width - 130, 18);
  }

  drawIdleState(width, height) {
    const ctx = this.ctx;
    ctx.fillStyle = '#64748b';
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Microphone standby • Test Mic to preview DSP', width / 2, height / 2);

    // Subtle flat line
    ctx.strokeStyle = 'rgba(100, 116, 139, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(20, height / 2 + 16);
    ctx.lineTo(width - 20, height / 2 + 16);
    ctx.stroke();
  }

  stop() {
    this.active = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);
    this.drawIdleState(width, height);
  }
}

