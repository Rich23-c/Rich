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
 * Helper to scan jsQR from a Jimp image bitmap
 */
function tryScanJimp(jimpImg) {
  try {
    const { width, height, data } = jimpImg.bitmap;
    const res = jsQR(new Uint8ClampedArray(data), width, height);
    if (res && res.data && res.data.trim()) {
      return res.data.trim();
    }
  } catch (e) {}
  return null;
}

/**
 * High-precision binarization filter (Black & White thresholding)
 */
function applyBinarize(jimpImg, threshold = 128) {
  const cloned = jimpImg.clone().greyscale();
  const d = cloned.bitmap.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] > threshold ? 255 : 0;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
  }
  return cloned;
}

/**
 * Scan QR code embedded inside a Thai bank transfer slip image with Ultra Accuracy.
 * Multi-pass architecture:
 * 1. Direct full image pass
 * 2. High-contrast & Grayscale
 * 3. Regional Quadrant Cropping (Targeting where Thai banks place Mini QR: bottom-right, bottom-left, bottom-half)
 * 4. Binarization thresholding (100, 128, 155) on candidate regions
 * 5. Scale up (1.5x / 2.0x) for small QR codes
 * 6. Color inversion (for dark mode slips)
 * 
 * @param {string} filePath - Absolute path to the image file
 * @returns {Promise<{ found: boolean, data: string|null, method?: string, info?: object }>}
 */
async function scanSlipQrCode(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { found: false, data: null, error: 'File not found' };
    }

    const image = await Jimp.read(filePath);
    const { width: w, height: h } = image.bitmap;

    // --- Pass 1: Direct full image ---
    let qrData = tryScanJimp(image);
    if (qrData) {
      return { found: true, data: qrData, method: 'direct', info: parseSlipQrInfo(qrData) };
    }

    // --- Pass 2: Full image with Contrast boost ---
    try {
      const enhanced = image.clone().greyscale().contrast(0.35);
      qrData = tryScanJimp(enhanced);
      if (qrData) {
        return { found: true, data: qrData, method: 'contrast', info: parseSlipQrInfo(qrData) };
      }
    } catch (e) {}

    // --- Pass 3: Regional Quadrant Cropping ---
    // Thai bank slips (KBank, SCB, Krungthai NEXT, Bangkok Bank, TTB, GSB, TrueMoney)
    // place their Mini QR in specific regions of the transfer receipt:
    const regions = [
      // 1. Bottom-Right Quadrant (KBank, SCB, Krungthai, TrueMoney)
      { name: 'bottom-right', x: Math.round(w * 0.35), y: Math.round(h * 0.42), w: Math.round(w * 0.65), h: Math.round(h * 0.58) },
      // 2. Bottom-Left Quadrant (Bangkok Bank BBL, GSB, TTB)
      { name: 'bottom-left', x: 0, y: Math.round(h * 0.42), w: Math.round(w * 0.65), h: Math.round(h * 0.58) },
      // 3. Bottom-Half Full Width
      { name: 'bottom-half', x: 0, y: Math.round(h * 0.40), w: w, h: Math.round(h * 0.60) },
      // 4. Center-Bottom
      { name: 'center-bottom', x: Math.round(w * 0.20), y: Math.round(h * 0.45), w: Math.round(w * 0.60), h: Math.round(h * 0.55) }
    ];

    for (const reg of regions) {
      try {
        const cropped = image.clone();
        cropped.crop({ x: reg.x, y: reg.y, w: reg.w, h: reg.h });

        // Try direct scan on cropped region
        qrData = tryScanJimp(cropped);
        if (qrData) {
          return { found: true, data: qrData, method: `crop-${reg.name}`, info: parseSlipQrInfo(qrData) };
        }

        // Try high-contrast on cropped region
        const contrastCropped = cropped.clone().greyscale().contrast(0.4);
        qrData = tryScanJimp(contrastCropped);
        if (qrData) {
          return { found: true, data: qrData, method: `crop-${reg.name}-contrast`, info: parseSlipQrInfo(qrData) };
        }

        // Try adaptive binarization thresholds (120, 150)
        for (const thresh of [128, 105, 155]) {
          const binarized = applyBinarize(cropped, thresh);
          qrData = tryScanJimp(binarized);
          if (qrData) {
            return { found: true, data: qrData, method: `crop-${reg.name}-binarize-${thresh}`, info: parseSlipQrInfo(qrData) };
          }
        }

        // If the cropped area is small (< 400px), try upscaling 1.75x
        if (reg.w < 500) {
          const scaled = cropped.clone();
          scaled.resize({ w: Math.round(reg.w * 1.75) });
          qrData = tryScanJimp(scaled);
          if (qrData) {
            return { found: true, data: qrData, method: `crop-${reg.name}-scaled`, info: parseSlipQrInfo(qrData) };
          }
        }
      } catch (e) {}
    }

    // --- Pass 4: Inverted pass (for dark mode bank receipts) ---
    try {
      const inverted = image.clone().greyscale().invert();
      qrData = tryScanJimp(inverted);
      if (qrData) {
        return { found: true, data: qrData, method: 'inverted', info: parseSlipQrInfo(qrData) };
      }
    } catch (e) {}

    // --- Pass 5: Scaled down pass (if photo is 4K resolution) ---
    if (w > 1400 || h > 1400) {
      try {
        const scaledDown = image.clone();
        scaledDown.resize({ w: 1000 });
        qrData = tryScanJimp(scaledDown);
        if (qrData) {
          return { found: true, data: qrData, method: 'scaled-down-1000', info: parseSlipQrInfo(qrData) };
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
 * Standard Bank Code mapping in Thailand (BOT Standards)
 */
const THAI_BANK_CODES = {
  '002': { name: 'ธนาคารกรุงเทพ', short: 'BBL', english: 'Bangkok Bank' },
  '004': { name: 'ธนาคารกสิกรไทย', short: 'KBANK', english: 'Kasikornbank' },
  '006': { name: 'ธนาคารกรุงไทย', short: 'KTB', english: 'Krungthai Bank' },
  '011': { name: 'ธนาคารทหารไทยธนชาต', short: 'TTB', english: 'TMBThanachart Bank' },
  '014': { name: 'ธนาคารไทยพาณิชย์', short: 'SCB', english: 'Siam Commercial Bank' },
  '022': { name: 'ธนาคารซีไอเอ็มบี ไทย', short: 'CIMBT', english: 'CIMB Thai Bank' },
  '024': { name: 'ธนาคารยูโอบี', short: 'UOB', english: 'United Overseas Bank' },
  '025': { name: 'ธนาคารกรุงศรีอยุธยา / TrueMoney', short: 'BAY', english: 'Bank of Ayudhya' },
  '030': { name: 'ธนาคารออมสิน', short: 'GSB', english: 'Government Savings Bank' },
  '034': { name: 'ธ.ก.ส.', short: 'BAAC', english: 'Bank for Agriculture and Agricultural Cooperatives' },
  '069': { name: 'ธนาคารเกียรตินาคินภัทร', short: 'KKP', english: 'Kiatnakin Phatra Bank' },
  '073': { name: 'ธนาคารแลนด์ แอนด์ เฮ้าส์', short: 'LH BANK', english: 'Land and Houses Bank' }
};

/**
 * Helper to parse EMVCo / TLV format strings
 */
function parseTlv(str) {
  const map = {};
  if (!str || typeof str !== 'string') return map;
  let i = 0;
  while (i < str.length - 4) {
    const tag = str.substring(i, i + 2);
    const len = parseInt(str.substring(i + 2, i + 4), 10);
    if (isNaN(len) || i + 4 + len > str.length) break;
    const val = str.substring(i + 4, i + 4 + len);
    map[tag] = val;
    i += 4 + len;
  }
  return map;
}

/**
 * Deeply parse Thai bank transfer slip verification QR code payload
 * Supports BOT BScanC Slip Standard & TrueMoney APF Payloads
 * 
 * @param {string} qrData - Raw QR string decoded from the slip
 * @returns {object|null} Structured slip metadata
 */
function parseSlipQrInfo(qrData) {
  if (!qrData || typeof qrData !== 'string') return null;

  const trimmed = qrData.trim();
  const info = {
    raw: trimmed,
    isRealBankSlipQr: false,
    format: 'UNKNOWN',
    bankCode: null,
    bankName: null,
    bankShort: null,
    transactionRef: null,
    transferDate: null,
    transferTime: null,
    country: null
  };

  // 1. Check Thai Bank Slip Standard (BScanC / BOT Tag 00 / Tag 51 TH)
  if (trimmed.startsWith('00') && (trimmed.includes('0006000001') || trimmed.includes('TH91') || trimmed.includes('5102TH'))) {
    info.isRealBankSlipQr = true;
    info.format = 'THAI_BOT_SLIP_STANDARD';

    const outer = parseTlv(trimmed);
    const inner00 = outer['00'] ? parseTlv(outer['00']) : {};

    // Tag 01: Sending Bank Code
    const bankCode = inner00['01'] || outer['01'];
    if (bankCode) {
      info.bankCode = bankCode;
      const bankMeta = THAI_BANK_CODES[bankCode];
      if (bankMeta) {
        info.bankName = bankMeta.name;
        info.bankShort = bankMeta.short;
      } else {
        info.bankName = `ธนาคารรหัส ${bankCode}`;
      }
    }

    // Tag 02: Transaction Reference
    const ref = inner00['02'] || outer['02'];
    if (ref) {
      info.transactionRef = ref;

      // Extract timestamp from APF or Standard patterns e.g. APF261008204739...
      const apfMatch = ref.match(/APF(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
      if (apfMatch) {
        info.transferDate = `20${apfMatch[1]}-${apfMatch[2]}-${apfMatch[3]}`;
        info.transferTime = `${apfMatch[4]}:${apfMatch[5]}:${apfMatch[6]}`;
      }
    }

    if (outer['51']) info.country = outer['51'];
  }

  // 2. Check for TrueMoney / APF standalone format
  if (trimmed.includes('APF')) {
    info.isRealBankSlipQr = true;
    info.format = 'TRUEMONEY_APF';
    info.bankName = info.bankName || 'TrueMoney Wallet';
    info.bankShort = info.bankShort || 'TrueMoney';

    const match = trimmed.match(/APF(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})([A-Z0-9]+)/);
    if (match) {
      info.transferDate = `20${match[1]}-${match[2]}-${match[3]}`;
      info.transferTime = `${match[4]}:${match[5]}:${match[6]}`;
      info.transactionRef = info.transactionRef || match[7];
    }
  }

  // 3. Fallback extraction of long alphanumeric reference
  if (!info.transactionRef) {
    const rawRefMatch = trimmed.match(/[A-Z0-9]{12,32}/);
    if (rawRefMatch) {
      info.transactionRef = rawRefMatch[0];
    }
  }

  return info;
}

module.exports = {
  getFileHash,
  scanSlipQrCode,
  parseSlipQrInfo
};
