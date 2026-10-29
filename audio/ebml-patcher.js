/**
 * EBML WebM Duration Patcher
 * 
 * Chrome's MediaRecorder creates WebM blobs with missing or indefinite duration
 * (e.g., duration shown as Infinity or 0:00, scrubbing broken).
 * This module writes the exact duration into the WebM Segment Info header,
 * producing 100% seekable WebM files with proper duration metadata.
 */

export async function fixWebmDuration(blob, durationMs) {
  try {
    const buffer = await blob.arrayBuffer();
    const patchedBuffer = injectDurationIntoWebM(buffer, durationMs);
    return new Blob([patchedBuffer], { type: blob.type || 'video/webm' });
  } catch (err) {
    console.warn('Could not patch WebM duration header:', err);
    return blob; // Fallback to original blob if patching fails
  }
}

function injectDurationIntoWebM(buffer, durationMs) {
  const bytes = new Uint8Array(buffer);
  const len = bytes.length;

  // Find EBML Header (0x1A, 0x45, 0xDF, 0xA3)
  let pos = 0;
  let ebmlFound = false;
  for (let i = 0; i < Math.min(len - 4, 1024); i++) {
    if (bytes[i] === 0x1A && bytes[i + 1] === 0x45 && bytes[i + 2] === 0xDF && bytes[i + 3] === 0xA3) {
      ebmlFound = true;
      pos = i;
      break;
    }
  }

  if (!ebmlFound) return buffer;

  // Find Segment Element (0x18, 0x53, 0x80, 0x67)
  let segmentPos = -1;
  for (let i = pos; i < Math.min(len - 4, 8192); i++) {
    if (bytes[i] === 0x18 && bytes[i + 1] === 0x53 && bytes[i + 2] === 0x80 && bytes[i + 3] === 0x67) {
      segmentPos = i;
      break;
    }
  }

  if (segmentPos === -1) return buffer;

  // Find Segment Info Element (0x15, 0x49, 0xA9, 0x66)
  let infoPos = -1;
  for (let i = segmentPos; i < Math.min(len - 4, segmentPos + 16384); i++) {
    if (bytes[i] === 0x15 && bytes[i + 1] === 0x49 && bytes[i + 2] === 0xA9 && bytes[i + 3] === 0x66) {
      infoPos = i;
      break;
    }
  }

  if (infoPos === -1) return buffer;

  // Find Duration element ID (0x44, 0x89) inside Info
  let durationPos = -1;
  for (let i = infoPos; i < Math.min(len - 4, infoPos + 1024); i++) {
    if (bytes[i] === 0x44 && bytes[i + 1] === 0x89) {
      durationPos = i;
      break;
    }
  }

  // Find TimecodeScale (0x2A, 0xD7, 0xB1), default is 1,000,000 ns (1ms)
  let timecodeScale = 1000000;
  for (let i = infoPos; i < Math.min(len - 6, infoPos + 1024); i++) {
    if (bytes[i] === 0x2A && bytes[i + 1] === 0xD7 && bytes[i + 2] === 0xB1) {
      const sizeLen = getVintLength(bytes[i + 3]);
      const dataStart = i + 3 + sizeLen;
      let val = 0;
      for (let j = 0; j < 4; j++) {
        val = (val << 8) | bytes[dataStart + j];
      }
      if (val > 0) timecodeScale = val;
      break;
    }
  }

  // Calculate float value in Segment timecode units
  const durationVal = durationMs / (timecodeScale / 1000000);

  if (durationPos !== -1) {
    // Duration tag already exists in header! Update its value
    const sizeByte = bytes[durationPos + 2];
    const dataSize = sizeByte & 0x0f; // usually 4 or 8 bytes float
    const dataPos = durationPos + 3;

    const floatBuf = new ArrayBuffer(8);
    const view = new DataView(floatBuf);

    if (dataSize === 4) {
      view.setFloat32(0, durationVal, false);
      for (let k = 0; k < 4; k++) {
        bytes[dataPos + k] = new Uint8Array(floatBuf)[k];
      }
    } else {
      // 8 bytes float (standard)
      view.setFloat64(0, durationVal, false);
      for (let k = 0; k < 8; k++) {
        bytes[dataPos + k] = new Uint8Array(floatBuf)[k];
      }
    }
    return buffer;
  }

  // If Duration element is missing, we insert it into the Info element
  const floatBytes = new Uint8Array(8);
  new DataView(floatBytes.buffer).setFloat64(0, durationVal, false);

  // EBML Duration tag: 0x44 0x89 (2 bytes id), 0x88 (size 8 vint), 8 bytes float
  const durationTag = new Uint8Array([0x44, 0x89, 0x88, ...floatBytes]);

  // Insert right after Info header (Info ID + VINT size)
  const infoHeaderEnd = infoPos + 4 + getVintLength(bytes[infoPos + 4]);
  const newBuffer = new Uint8Array(len + durationTag.length);
  newBuffer.set(bytes.subarray(0, infoHeaderEnd), 0);
  newBuffer.set(durationTag, infoHeaderEnd);
  newBuffer.set(bytes.subarray(infoHeaderEnd), infoHeaderEnd + durationTag.length);

  return newBuffer.buffer;
}

function getVintLength(firstByte) {
  let mask = 0x80;
  let len = 1;
  while ((firstByte & mask) === 0 && len <= 8) {
    mask >>= 1;
    len++;
  }
  return len;
}

