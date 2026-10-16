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
 * Add solid white Quiet Zone border around an image (Essential for jsQR finder pattern detection!)
 */
function addQuietZone(jimpImg, pad = 24) {
  try {
    const w = jimpImg.bitmap.width;
    const h = jimpImg.bitmap.height;
    const bordered = new Jimp({ width: w + pad * 2, height: h + pad * 2, color: 0xFFFFFFFF });
    bordered.composite(jimpImg, pad, pad);
    return bordered;
  } catch (e) {
    return jimpImg;
  }
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
 * Calculate dynamic optimal threshold using Otsu's Algorithm
 */
function getOtsuThreshold(jimpImg) {
  try {
    const d = jimpImg.bitmap.data;
    const hist = new Int32Array(256);
    let total = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = ((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000) | 0;
      hist[lum]++;
      total++;
    }
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0;
    let wB = 0;
    let varMax = 0;
    let threshold = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const varBetween = wB * wF * (mB - mF) * (mB - mF);
      if (varBetween > varMax) {
        varMax = varBetween;
        threshold = t;
      }
    }
    return threshold;
  } catch (e) {
    return 128;
  }
}

/**
 * Bradley-Roth Adaptive Thresholding using Integral Image
 * Handles uneven shadows, flash glare, and colored gradient slip backgrounds
 */
function applyAdaptiveThreshold(jimpImg) {
  try {
    const w = jimpImg.bitmap.width;
    const h = jimpImg.bitmap.height;
    const cloned = jimpImg.clone().greyscale();
    const d = cloned.bitmap.data;

    const S = Math.max(8, Math.round(w / 16));
    const s2 = Math.round(S / 2);
    const T = 0.15; // 15% delta

    // 1. Calculate integral image
    const integral = new Float64Array(w * h);
    for (let i = 0; i < w; i++) {
      let sum = 0;
      for (let j = 0; j < h; j++) {
        const idx = (j * w + i) * 4;
        sum += d[idx];
        if (i === 0) {
          integral[j * w + i] = sum;
        } else {
          integral[j * w + i] = integral[j * w + i - 1] + sum;
        }
      }
    }

    // 2. Adaptive threshold based on local window mean
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < h; j++) {
        const x1 = Math.max(i - s2, 0);
        const x2 = Math.min(i + s2, w - 1);
        const y1 = Math.max(j - s2, 0);
        const y2 = Math.min(j + s2, h - 1);

        const count = (x2 - x1 + 1) * (y2 - y1 + 1);
        const sum = integral[y2 * w + x2]
          - (y1 > 0 ? integral[(y1 - 1) * w + x2] : 0)
          - (x1 > 0 ? integral[y2 * w + (x1 - 1)] : 0)
          + (x1 > 0 && y1 > 0 ? integral[(y1 - 1) * w + (x1 - 1)] : 0);

        const pixelIdx = (j * w + i) * 4;
        const val = (d[pixelIdx] * count < sum * (1.0 - T)) ? 0 : 255;
        d[pixelIdx] = val;
        d[pixelIdx + 1] = val;
        d[pixelIdx + 2] = val;
      }
    }
    return cloned;
  } catch (e) {
    return jimpImg;
  }
}

/**
 * Sharpening convolution kernel for blurry Mini QR codes
 */
const SHARPEN_KERNEL = [
  [0, -1, 0],
  [-1, 5, -1],
  [0, -1, 0]
];

/**
 * Helper to scan an image and its regional quadrant crops with Ultra Accuracy
 */
function scanImageWithQuadrants(image, prefix = '') {
  // 1. Direct scan
  let qr = tryScanJimp(image);
  if (qr) return { found: true, data: qr, method: `${prefix}direct` };

  // 1b. Direct scan with White Quiet Zone padding
  const imageWithQz = addQuietZone(image, 30);
  qr = tryScanJimp(imageWithQz);
  if (qr) return { found: true, data: qr, method: `${prefix}direct-quietzone` };

  // 2. High-contrast & greyscale
  try {
    const contrast = image.clone().greyscale().contrast(0.4);
    qr = tryScanJimp(contrast);
    if (qr) return { found: true, data: qr, method: `${prefix}contrast` };

    qr = tryScanJimp(addQuietZone(contrast, 30));
    if (qr) return { found: true, data: qr, method: `${prefix}contrast-quietzone` };
  } catch (e) {}

  // 2b. Otsu Dynamic Threshold on Full Image
  try {
    const otsuT = getOtsuThreshold(image);
    const otsuImg = applyBinarize(image, otsuT);
    qr = tryScanJimp(addQuietZone(otsuImg, 30));
    if (qr) return { found: true, data: qr, method: `${prefix}otsu-${otsuT}` };
  } catch (e) {}

  const { width: w, height: h } = image.bitmap;

  // 3. Regional Quadrant Cropping
  // Thai bank slips (KBank, SCB, Krungthai NEXT, Bangkok Bank, TTB, GSB, TrueMoney)
  // place their Mini QR in specific regions:
  const regions = [
    // Bottom-Right Quadrant (KBank, SCB, Krungthai, TrueMoney)
    { name: 'bottom-right', x: Math.round(w * 0.35), y: Math.round(h * 0.38), w: Math.round(w * 0.65), h: Math.round(h * 0.62) },
    // Bottom-Left Quadrant (Bangkok Bank BBL, GSB, TTB)
    { name: 'bottom-left', x: 0, y: Math.round(h * 0.38), w: Math.round(w * 0.65), h: Math.round(h * 0.62) },
    // Bottom-Half Full Width
    { name: 'bottom-half', x: 0, y: Math.round(h * 0.35), w: w, h: Math.round(h * 0.65) },
    // Center-Bottom (Krungsri, BAAC, TISCO)
    { name: 'center-bottom', x: Math.round(w * 0.15), y: Math.round(h * 0.40), w: Math.round(w * 0.70), h: Math.round(h * 0.60) },
    // Middle-Right
    { name: 'middle-right', x: Math.round(w * 0.35), y: Math.round(h * 0.25), w: Math.round(w * 0.65), h: Math.round(h * 0.55) },
    // Center Full (Square slips)
    { name: 'center-full', x: Math.round(w * 0.10), y: Math.round(h * 0.15), w: Math.round(w * 0.80), h: Math.round(h * 0.75) }
  ];

  for (const reg of regions) {
    try {
      const cropped = image.clone();
      cropped.crop({ x: reg.x, y: reg.y, w: reg.w, h: reg.h });

      // Direct crop scan
      qr = tryScanJimp(cropped);
      if (qr) return { found: true, data: qr, method: `${prefix}crop-${reg.name}` };

      // Crop with Quiet Zone (Critical boost for edge-adjacent QR codes)
      const croppedQz = addQuietZone(cropped, 24);
      qr = tryScanJimp(croppedQz);
      if (qr) return { found: true, data: qr, method: `${prefix}crop-${reg.name}-qz` };

      // High-contrast crop scan
      const contrastCropped = cropped.clone().greyscale().contrast(0.45);
      qr = tryScanJimp(addQuietZone(contrastCropped, 24));
      if (qr) return { found: true, data: qr, method: `${prefix}crop-${reg.name}-contrast` };

      // Otsu optimal binarization
      const otsuThresh = getOtsuThreshold(cropped);
      for (const thresh of [otsuThresh, otsuThresh - 20, otsuThresh + 20, 128]) {
        const binarized = applyBinarize(cropped, thresh);
        qr = tryScanJimp(addQuietZone(binarized, 24));
        if (qr) return { found: true, data: qr, method: `${prefix}crop-${reg.name}-otsu-${thresh}` };
      }

      // Bradley-Roth Adaptive Thresholding (removes lighting gradient & shadows)
      try {
        const adaptive = applyAdaptiveThreshold(cropped);
        qr = tryScanJimp(addQuietZone(adaptive, 24));
        if (qr) return { found: true, data: qr, method: `${prefix}crop-${reg.name}-adaptive` };
      } catch (e) {}

      // Sharpening pass for blurry/compressed images
      try {
        const sharpened = cropped.clone().greyscale().convolute(SHARPEN_KERNEL);
        qr = tryScanJimp(addQuietZone(sharpened, 24));
        if (qr) return { found: true, data: qr, method: `${prefix}crop-${reg.name}-sharpen` };
      } catch (e) {}

      // Upscaling for small Mini QR codes (< 600px)
      if (reg.w < 600) {
        const scaled15 = cropped.clone();
        scaled15.resize({ w: Math.round(reg.w * 1.5) });
        qr = tryScanJimp(addQuietZone(scaled15, 28));
        if (qr) return { found: true, data: qr, method: `${prefix}crop-${reg.name}-scaled1.5` };

        const scaled20 = cropped.clone();
        scaled20.resize({ w: Math.round(reg.w * 2.0) });
        qr = tryScanJimp(addQuietZone(scaled20, 32));
        if (qr) return { found: true, data: qr, method: `${prefix}crop-${reg.name}-scaled2.0` };
      }
    } catch (e) {}
  }

  return null;
}

/**
 * Scan QR code embedded inside a Thai bank transfer slip image with Ultra Accuracy.
 * Multi-pass architecture:
 * 1. Direct and Regional Quadrant scanning (0° default)
 * 2. Multi-angle rotation for mobile camera photos (90°, 270°, 180°)
 * 3. Inversion pass (for dark mode slips)
 * 4. Multi-resolution pass (downscale huge 4K photos / upscale tiny thumbnails)
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

    // --- Tier 1: Normal 0° Orientation Passes ---
    const res0 = scanImageWithQuadrants(image, '');
    if (res0) {
      return { found: true, data: res0.data, method: res0.method, info: parseSlipQrInfo(res0.data) };
    }

    // --- Tier 2: Inverted pass (for dark mode bank receipts) ---
    try {
      const inverted = image.clone().greyscale().invert();
      const qrData = tryScanJimp(inverted);
      if (qrData) {
        return { found: true, data: qrData, method: 'inverted', info: parseSlipQrInfo(qrData) };
      }
    } catch (e) {}

    // --- Tier 3: Phone Camera Orientation Passes (90°, 270°, 180°) ---
    // Solves horizontal/sideways/upside-down photos taken on mobile devices
    const angles = [90, 270, 180];
    for (const angle of angles) {
      try {
        const rotated = image.clone().rotate(angle);
        const rotRes = scanImageWithQuadrants(rotated, `rot${angle}-`);
        if (rotRes) {
          return { found: true, data: rotRes.data, method: rotRes.method, info: parseSlipQrInfo(rotRes.data) };
        }
      } catch (e) {}
    }

    // --- Tier 4: Scaled pass for high-res photos (4K/12MP cameras) ---
    if (w > 1200 || h > 1200) {
      try {
        const scaledDown = image.clone();
        scaledDown.resize({ w: 1000 });
        const scaleRes = scanImageWithQuadrants(scaledDown, 'scaled1000-');
        if (scaleRes) {
          return { found: true, data: scaleRes.data, method: scaleRes.method, info: parseSlipQrInfo(scaleRes.data) };
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
  '067': { name: 'ธนาคารทิสโก้', short: 'TISCO', english: 'TISCO Bank' },
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

    // Tag 54: Amount if embedded in QR code
    if (outer['54']) {
      const amt = parseFloat(outer['54']);
      if (!isNaN(amt)) {
        info.amount = amt;
      }
    }
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
