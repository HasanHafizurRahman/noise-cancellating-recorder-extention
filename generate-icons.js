const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 implementation for PNG chunks
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function createChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const body = Buffer.concat([typeBuf, data]);
  const crcVal = crc32(body);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);

  return Buffer.concat([lenBuf, body, crcBuf]);
}

function createPNG(size, drawPixel) {
  const width = size;
  const height = size;

  // Scanlines with filter byte 0
  const rowStride = width * 4;
  const rawData = Buffer.alloc(height * (rowStride + 1));

  let offset = 0;
  for (let y = 0; y < height; y++) {
    rawData[offset++] = 0; // Filter byte 0: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = drawPixel(x, y, width, height);
      rawData[offset++] = r;
      rawData[offset++] = g;
      rawData[offset++] = b;
      rawData[offset++] = a;
    }
  }

  const deflated = zlib.deflateSync(rawData);

  // PNG Signature
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // 8 bits per channel
  ihdrData[9] = 6; // RGBA color type
  ihdrData[10] = 0; // compression (deflate)
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace method (none)

  const ihdrChunk = createChunk('IHDR', ihdrData);
  const idatChunk = createChunk('IDAT', deflated);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function drawIconPixel(x, y, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
  const maxR = (w / 2) * 0.94;

  // Anti-aliased outer rounded badge
  if (r > maxR) {
    const alpha = Math.max(0, Math.min(1, (maxR + 1 - r)));
    if (alpha <= 0) return [0, 0, 0, 0];
  }

  // Background Gradient: Deep slate / modern indigo (#0f172a to #312e81)
  const normY = y / h;
  let bgR = Math.round(15 + normY * 34);
  let bgG = Math.round(23 + normY * 23);
  let bgB = Math.round(42 + normY * 87);

  // Outer border ring (cyan glow)
  if (r > maxR - 2 && r <= maxR) {
    return [56, 189, 248, 240];
  }

  // Draw monitor/screen frame
  const screenLeft = w * 0.20;
  const screenRight = w * 0.80;
  const screenTop = h * 0.22;
  const screenBottom = h * 0.70;

  const inScreen = x >= screenLeft && x <= screenRight && y >= screenTop && y <= screenBottom;
  const onScreenBorder = inScreen && (
    x <= screenLeft + (w > 32 ? 2 : 1) ||
    x >= screenRight - (w > 32 ? 2 : 1) ||
    y <= screenTop + (w > 32 ? 2 : 1) ||
    y >= screenBottom - (w > 32 ? 2 : 1)
  );

  // Monitor stand base
  const standTop = screenBottom + 2;
  const standBottom = h * 0.82;
  const isStandPole = y >= standTop && y <= standBottom && Math.abs(x - cx) <= (w > 32 ? 2 : 1);
  const isStandBase = y >= standBottom && y <= standBottom + (w > 32 ? 2 : 1) && Math.abs(x - cx) <= w * 0.2;

  if (onScreenBorder || isStandPole || isStandBase) {
    return [148, 163, 184, 255]; // Slate 400
  }

  // Inside screen
  if (inScreen) {
    // Inner screen background: dark tech cyan tint
    bgR = 10;
    bgG = 18;
    bgB = 30;

    // Red Recording Dot (top-left inside screen)
    const dotX = screenLeft + (w * 0.12);
    const dotY = screenTop + (h * 0.12);
    const dotR = Math.sqrt((x - dotX) ** 2 + (y - dotY) ** 2);
    if (dotR <= (w > 32 ? 3 : 1.5)) {
      return [239, 68, 68, 255]; // Bright red dot
    }

    // Sound Wave / Noise Cancellation Waveform (emerald cyan equalizer bars)
    // 5 bars centered inside screen
    const barWidth = Math.max(1, Math.round(w * 0.05));
    const barSpacing = Math.max(1, Math.round(w * 0.04));
    const totalBarsWidth = 5 * barWidth + 4 * barSpacing;
    const startX = cx - totalBarsWidth / 2;

    const barHeights = [0.18, 0.32, 0.42, 0.28, 0.16];
    for (let i = 0; i < 5; i++) {
      const bx = startX + i * (barWidth + barSpacing);
      const bHeight = h * barHeights[i];
      const by1 = cy - bHeight / 2 + 1;
      const by2 = cy + bHeight / 2 + 1;

      if (x >= bx && x < bx + barWidth && y >= by1 && y <= by2) {
        // Glowing cyan to emerald gradient
        return [16, 185, 129, 255]; // Emerald
      }
    }
  }

  return [bgR, bgG, bgB, 255];
}

// Generate icons
const sizes = [16, 32, 48, 128];
const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

sizes.forEach((size) => {
  const pngBuf = createPNG(size, drawIconPixel);
  const filePath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filePath, pngBuf);
  console.log(`Generated: ${filePath} (${pngBuf.length} bytes)`);
});

// Also create an SVG version for high-res preview and web use
const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a" />
      <stop offset="100%" stop-color="#312e81" />
    </linearGradient>
    <linearGradient id="cyanGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#38bdf8" />
      <stop offset="100%" stop-color="#10b981" />
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="3" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#bgGrad)" stroke="#38bdf8" stroke-width="2" />
  
  <!-- Monitor frame -->
  <rect x="24" y="26" width="80" height="54" rx="8" fill="#090d16" stroke="#94a3b8" stroke-width="3" />
  <path d="M58 80 L54 98 M70 80 L74 98 M42 98 L86 98" stroke="#94a3b8" stroke-width="3" stroke-linecap="round" />
  
  <!-- Red Recording indicator -->
  <circle cx="36" cy="38" r="4.5" fill="#ef4444" filter="url(#glow)">
    <animate attributeName="opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite" />
  </circle>
  
  <!-- Equalizer / Noise Cancellation Sound Wave -->
  <g fill="url(#cyanGrad)">
    <rect x="46" y="47" width="4.5" height="18" rx="2.2" />
    <rect x="54" y="39" width="4.5" height="34" rx="2.2" />
    <rect x="62" y="33" width="4.5" height="46" rx="2.2" />
    <rect x="70" y="41" width="4.5" height="30" rx="2.2" />
    <rect x="78" y="49" width="4.5" height="14" rx="2.2" />
  </g>
  
  <!-- Sound Cancellation Shield Badge -->
  <circle cx="92" cy="88" r="16" fill="#1e293b" stroke="#10b981" stroke-width="2.5" />
  <path d="M88 88 L91 91 L97 85" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none" />
</svg>`;

fs.writeFileSync(path.join(iconsDir, 'icon.svg'), svgContent);
console.log('Generated: icons/icon.svg');

