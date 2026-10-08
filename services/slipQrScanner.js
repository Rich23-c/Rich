const { Jimp } = require('jimp');
const jsQR = require('jsqr');
const crypto = require('crypto');
const fs = require('fs');

/**
 * Calculate SHA-256 hash of a file to detect exact re-uploads
 */
function getFileHash(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const buffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
  } catch (err) {
    console.error('Error calculating file hash:', err.message);
    return null;
  }
}

/**
 * Scan QR code embedded inside a Thai bank transfer slip image.
 * Uses jsQR with multi-pass decoding (direct -> grayscale/contrast -> resize).
 * @param {string} filePath - Absolute path to the image file
 * @returns {Promise<{ found: boolean, data: string|null, method?: string }>}
 */
async function scanSlipQrCode(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { found: false, data: null, error: 'File not found' };
    }

    // 1. Direct pass
    const image = await Jimp.read(filePath);
    const { width, height, data } = image.bitmap;
    let qr = jsQR(new Uint8ClampedArray(data), width, height);
    if (qr && qr.data && qr.data.trim()) {
      return {
        found: true,
        data: qr.data.trim(),
        method: 'direct'
      };
    }

    // 2. Preprocessed pass: Greyscale + Contrast boost
    try {
      const cloned = image.clone();
      cloned.greyscale().contrast(0.25);
      qr = jsQR(new Uint8ClampedArray(cloned.bitmap.data), cloned.bitmap.width, cloned.bitmap.height);
      if (qr && qr.data && qr.data.trim()) {
        return {
          found: true,
          data: qr.data.trim(),
          method: 'contrast'
        };
      }
    } catch (e) {}

    // 3. Scaled down pass (for very high resolution camera images)
    if (width > 1200 || height > 1200) {
      try {
        const scaled = image.clone();
        scaled.resize({ w: Math.round(width * 0.5) });
        qr = jsQR(new Uint8ClampedArray(scaled.bitmap.data), scaled.bitmap.width, scaled.bitmap.height);
        if (qr && qr.data && qr.data.trim()) {
          return {
            found: true,
            data: qr.data.trim(),
            method: 'scaled'
          };
        }
      } catch (e) {}
    }

    return { found: false, data: null };
  } catch (err) {
    console.error('Error scanning QR code in slip:', err.message);
    return { found: false, data: null, error: err.message };
  }
}

/**
 * Extract summary information from a Thai slip verification QR code payload
 * (Standard BOT / PromptPay Slip payload or TrueMoney payload)
 */
function parseSlipQrInfo(qrData) {
  if (!qrData || typeof qrData !== 'string') return null;

  const info = {
    raw: qrData,
    type: 'STANDARD',
    extractedRef: null,
    extractedTimestamp: null
  };

  // Check for TrueMoney / APF format e.g. 0046000600000101030250225APF261008112757OE0NJLJQQ35102...
  if (qrData.includes('APF')) {
    info.type = 'TRUEMONEY_APF';
    const match = qrData.match(/APF(\d{12})([A-Z0-9]+)/);
    if (match) {
      info.extractedTimestamp = match[1]; // YYMMDDhhmmss
      info.extractedRef = match[2];
    }
  }

  // Check for Thai PromptPay / Bank standard payload
  if (qrData.startsWith('000201') || qrData.includes('00460006')) {
    info.type = 'THAI_QR_SLIP';
  }

  return info;
}

module.exports = {
  getFileHash,
  scanSlipQrCode,
  parseSlipQrInfo
};
