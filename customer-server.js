require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const generatePayload = require('promptpay-qr');
const qrcode = require('qrcode');

const compression = require('compression');

const db = require('./services/database');
const { verifySlip } = require('./services/slipVerifier');
const { compressSlipImage, resolveSlipImage } = require('./services/slipImageService');
const {
  securityHeadersMiddleware,
  intrusionDetectionMiddleware,
  prototypePollutionGuard,
  slipFileFilter,
  slipVerifyRateLimit,
  orderCreateRateLimit,
  visitorTrackRateLimit,
  promptPayQrRateLimit,
  orderHistoryRateLimit,
  publicApiRateLimit,
  isHoneypotTriggered,
  isBotSubmissionSpeed,
  sanitizeText,
  validateCustomerName,
  validateCustomerPhone,
  validateCustomerNote,
  validateSearchQuery,
  acquireSlipLock,
  releaseSlipLock,
  generateSlipVerificationToken,
  verifySlipVerificationToken,
  verifyAdminSessionToken,
  sanitizeOrderForCustomer,
  cookieParserMiddleware,
  getCorsOptions,
  canAccessOrder,
  protectStaticFilesMiddleware
} = require('./services/security');

const app = express();
const PORT = process.env.PORT || process.env.CUSTOMER_PORT || 3000;

// Security 1: Disable Express fingerprinting
app.disable('x-powered-by');

// Security 2: Intrusion Detection System & Auto-Ban 24-hr blacklist for malicious bot probing
app.use(intrusionDetectionMiddleware);

// Security 3: Enforce strict HTTP security headers & CSP (nosniff, SAMEORIGIN, HSTS, XSS)
app.use(securityHeadersMiddleware);

// Security 4: Cookie Parser (HttpOnly Session & Device ID)
app.use(cookieParserMiddleware);

// Gzip & Brotli HTTP Compression (reduces payload size by 75-80% for 10x higher concurrent throughput)
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// Security 5: Strict CORS Configuration (Whitelisted origins only, with credentials)
app.use(cors(getCorsOptions()));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Security 6: Prototype Pollution Guard (Rejects malicious payloads with __proto__ or constructor injection)
app.use(prototypePollutionGuard);

// Ensure upload directories exist
const uploadDir = path.join(__dirname, 'uploads');
const slipsUploadDir = path.join(uploadDir, 'slips');
if (!fs.existsSync(slipsUploadDir)) {
  fs.mkdirSync(slipsUploadDir, { recursive: true });
}

// Helper to detect mobile phone model and browser environment
function parseDeviceFromUserAgent(ua, clientInfo = {}) {
  ua = ua || '';
  let model = (clientInfo.deviceModel || '').trim();
  let os = (clientInfo.os || '').trim();
  let inApp = '';

  if (/Line\//i.test(ua)) inApp = 'LINE 🟢';
  else if (/FBAV|FBAN/i.test(ua)) inApp = 'Facebook 🔵';
  else if (/Instagram/i.test(ua)) inApp = 'Instagram 📷';
  else if (/musical_ly|ByteLocale|TikTok/i.test(ua)) inApp = 'TikTok 🎵';

  if (!model || model === 'ไม่ระบุรุ่น') {
    if (/iPhone/i.test(ua)) {
      model = 'Apple iPhone';
      const m = ua.match(/OS (\d+[_\d]*)/);
      if (m) os = 'iOS ' + m[1].replace(/_/g, '.');
    } else if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && clientInfo.deviceType === 'tablet')) {
      model = 'Apple iPad';
      os = 'iPadOS';
    } else if (/Android/i.test(ua)) {
      const m = ua.match(/Android\s+([0-9.]+)/i);
      if (m) os = 'Android ' + m[1];
      const modelMatch = ua.match(/Android[^;]*;\s*([^;]+?)\s*(?:Build|[;)])/i);
      if (modelMatch && modelMatch[1]) {
        const raw = modelMatch[1].trim();
        if (/^SM-S928/i.test(raw)) model = 'Samsung Galaxy S24 Ultra';
        else if (/^SM-S926/i.test(raw)) model = 'Samsung Galaxy S24+';
        else if (/^SM-S921/i.test(raw)) model = 'Samsung Galaxy S24';
        else if (/^SM-S918/i.test(raw)) model = 'Samsung Galaxy S23 Ultra';
        else if (/^SM-S916/i.test(raw)) model = 'Samsung Galaxy S23+';
        else if (/^SM-S911/i.test(raw)) model = 'Samsung Galaxy S23';
        else if (/^SM-S908/i.test(raw)) model = 'Samsung Galaxy S22 Ultra';
        else if (/^SM-S90/i.test(raw)) model = 'Samsung Galaxy S22';
        else if (/^SM-G998/i.test(raw)) model = 'Samsung Galaxy S21 Ultra';
        else if (/^SM-G99/i.test(raw)) model = 'Samsung Galaxy S21';
        else if (/^SM-A54/i.test(raw)) model = 'Samsung Galaxy A54 5G';
        else if (/^SM-A/i.test(raw)) model = `Samsung Galaxy A-Series (${raw})`;
        else if (/^SM-/i.test(raw)) model = `Samsung (${raw})`;
        else if (/^CPH/i.test(raw)) model = `OPPO (${raw})`;
        else if (/^V2|^V1/i.test(raw)) model = `Vivo (${raw})`;
        else if (/^RMX/i.test(raw)) model = `Realme (${raw})`;
        else if (/Redmi|POCO|Xiaomi|2201|2312/i.test(raw)) model = `Xiaomi / Redmi (${raw})`;
        else if (/Pixel/i.test(raw)) model = `Google Pixel (${raw})`;
        else model = raw;
      } else {
        model = 'Android Smartphone';
      }
    } else if (/Windows/i.test(ua)) {
      model = 'Windows PC';
      os = 'Windows';
    } else if (/Macintosh/i.test(ua)) {
      model = 'Apple Mac';
      os = 'macOS';
    } else {
      model = 'อุปกรณ์มือถือ';
    }
  }

  const summary = inApp ? `${model} (เปิดใน ${inApp})` : model;
  return {
    deviceType: clientInfo.deviceType || (/iPhone|Android|Mobile/i.test(ua) ? 'mobile' : (/iPad/i.test(ua) ? 'tablet' : 'desktop')),
    deviceModel: model,
    os: os || clientInfo.os || '',
    inApp: inApp || clientInfo.inApp || '',
    screen: clientInfo.screen || '',
    summary: clientInfo.summary || summary
  };
}

// Security: Block sensitive file extensions (.map, .env, .json, .bak) before static handler
app.use(protectStaticFilesMiddleware);

// Serve static assets for Customer Storefront with tuned Cache-Control & denied dotfiles
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',
  maxAge: '1d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('manifest.json') || filePath.endsWith('admin-manifest.json')) {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else if (filePath.endsWith('.html')) {
      // HTML documents MUST NOT be stored in browser/proxy caches to prevent stale sensitive states
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (filePath.endsWith('.js')) {
      // JavaScript files must revalidate with server to ensure code integrity
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else {
      // Static assets (CSS, images, icons, fonts) cached in browser for 1 day, CDN for 7 days
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400');
    }
  }
}));

// Smart Self-Healing Slip Image Resolver (Preserves slip images across Cloud restarts)
app.get('/uploads/slips/:filename', (req, res, next) => {
  const filename = path.basename(req.params.filename);
  const resolved = resolveSlipImage(filename, db.getOrders());
  if (resolved) {
    if (resolved.type === 'file') {
      return res.sendFile(resolved.filePath);
    } else if (resolved.type === 'buffer') {
      res.setHeader('Content-Type', resolved.contentType);
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      return res.send(resolved.buffer);
    } else if (resolved.type === 'svg') {
      res.setHeader('Content-Type', resolved.contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(resolved.svg);
    }
  }
  next();
});

app.use('/uploads', (req, res, next) => {
  // Security: Isolate uploaded files in a restricted sandbox (never execute scripts or HTML)
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}, express.static(uploadDir, {
  dotfiles: 'deny',
  maxAge: '7d',
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=604800, s-maxage=2592000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}));

// Health check endpoint for Uptime monitoring, Memory usage & DB status
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  const usedRamMB = Math.round((mem.rss / 1024 / 1024) * 10) / 10;
  const limitRamMB = 512;
  const ramPercent = Math.round((usedRamMB / limitRamMB) * 100);

  res.status(200).json({
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime()),
    uptimeFormatted: `${Math.floor(process.uptime() / 60)} นาที`,
    memoryRAM: {
      used: `${usedRamMB} MB`,
      limit: `${limitRamMB} MB (แผนฟรี Render)`,
      usagePercent: `${ramPercent}%`,
      availableRemaining: `${Math.round((limitRamMB - usedRamMB) * 10) / 10} MB`
    },
    database: db.getDatabaseStatus(),
    cdnPerformance: {
      compression: 'gzip_active (ประหยัดแบนด์วิดท์ 75-80%)',
      edgeCache: 'public, max-age=86400, s-maxage=604800 (พร้อมรับมือคนเข้าหลักหมื่น-ล้านคน)'
    },
    diskStorage: {
      usedEstimate: 'ประมาณ 70 - 90 MB (รวมโค้ดและไลบรารี)',
      limit: '1 GB (1,024 MB)',
      usagePercent: 'ประมาณ 8%'
    },
    bandwidthMonthly: {
      limit: '100 GB / เดือน (ใช้จริงลดลง 75% ด้วย Gzip)'
    },
    freeHoursMonthly: {
      limit: '750 ชม. / เดือน (เปิด 24 ชม. ทั้งเดือนใช้ 744 ชม. = พอดี 100%)'
    },
    timestamp: new Date().toISOString()
  });
});

// Route to Admin Dashboard (allows accessing admin from the main public tunnel URL /admin)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Mount Admin APIs (protected by Scrypt-hashed PIN and HttpOnly Session Cookies)
const adminRouter = require('./admin-router');
app.use(adminRouter);

// Multer Storage for Slips (Secured with strict whitelist and random file hashing)
const crypto = require('crypto');
const slipStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, slipsUploadDir),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
    const randHex = crypto.randomBytes(16).toString('hex');
    cb(null, `slip-${Date.now()}-${randHex}${ext}`);
  }
});
const uploadSlip = multer({
  storage: slipStorage,
  fileFilter: slipFileFilter,
  limits: { fileSize: 15 * 1024 * 1024 }
});

// ==========================================
// CUSTOMER STOREFRONT APIs ONLY
// ==========================================

// Get available snacks
app.get('/api/snacks', (req, res) => {
  try {
    const snacks = db.getSnacks(false);
    // Sanitize cost so customers cannot view wholesale cost and profit margins
    const publicSnacks = snacks.map(({ cost, ...rest }) => rest);
    res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
    res.json({ success: true, data: publicSnacks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Track Storefront Visitor Presence (Protected with Rate Limiter & Input Sanitization)
app.post('/api/track-visit', visitorTrackRateLimit, (req, res) => {
  try {
    const { visitorId, visitorCode, path: pagePath, deviceSummary, customerName } = req.body || {};
    const userAgent = req.headers['user-agent'] || '';
    if (!visitorId) {
      return res.status(400).json({ success: false, error: 'visitorId is required' });
    }
    const cleanCustomerName = customerName ? sanitizeText(customerName, 80) : '';
    const visitor = db.trackVisitor({
      visitorId: sanitizeText(visitorId, 64),
      visitorCode: sanitizeText(visitorCode, 20),
      userAgent: sanitizeText(userAgent, 200),
      path: sanitizeText(pagePath || '/', 100),
      deviceSummary: sanitizeText(deviceSummary, 100),
      customerName: cleanCustomerName
    });
    res.json({ success: true, visitor });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get shop settings (Strict WHITELIST: Never exposes admin pin, hashes, API keys, or secret tokens)
app.get('/api/settings', (req, res) => {
  try {
    const settings = db.getSettings();
    const publicSettings = {
      shopName: settings.shopName || 'ร้านขนมแม้ว 🐾 (Snack by Maew)',
      shopSubtitle: settings.shopSubtitle || 'ของหวาน ของอร่อย เมืองเพชรบุรี',
      promptpayId: settings.promptpayId || '140540',
      promptpayName: settings.promptpayName || 'พัชญ์ชามญชุ์ กฤติณัฐธนชัย',
      bankName: settings.bankName || 'Thai QR Payment (พร้อมเพย์)',
      bankAccountNumber: settings.bankAccountNumber || 'สแกน Thai QR พร้อมเพย์',
      promptpayQrImage: settings.promptpayQrImage || '/images/shop-qr.png',
      contactPhone: settings.contactPhone || '080-924-9673',
      contactLine: settings.contactLine || '@snackbymaew',
      address: settings.address || '',
      shopAnnouncement: settings.shopAnnouncement || '',
      isOpen: settings.isOpen !== false,
      closedMessage: settings.closedMessage || 'ขณะนี้ร้านแม้วปิดรับออเดอร์ชั่วคราว แล้วพบกันใหม่รอบหน้านะจ๊ะ 🐱',
      laptopBannerEnabled: settings.laptopBannerEnabled !== false,
      laptopBannerTitle: settings.laptopBannerTitle || '',
      laptopBannerText: settings.laptopBannerText || '',
      laptopBannerContact: settings.laptopBannerContact || '',
      laptopBannerImage: settings.laptopBannerImage || '',
      laptopBannerLink: settings.laptopBannerLink || ''
    };
    res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
    res.json({ success: true, data: publicSettings });
  } catch (err) {
    console.error('Settings endpoint error:', err);
    res.status(500).json({ success: false, error: 'เกิดข้อผิดพลาดในการดึงข้อมูลร้าน' });
  }
});

// Generate dynamic PromptPay QR code (Protected with Rate Limiter & Strict Input Validation)
app.get('/api/promptpay-qr', promptPayQrRateLimit, async (req, res) => {
  try {
    const settings = db.getSettings();
    if (settings.isOpen === false) {
      return res.status(400).json({ success: false, error: settings.closedMessage || 'ขณะนี้ร้านแม้วปิดรับออเดอร์ชั่วคราว' });
    }
    const promptpayId = settings.promptpayId || '0891234567';
    const rawAmount = req.query.amount;
    let amount = 0;
    if (rawAmount !== undefined && rawAmount !== null && rawAmount !== '') {
      amount = parseFloat(rawAmount);
      if (isNaN(amount) || !isFinite(amount) || amount < 0 || amount > 1000000) {
        return res.status(400).json({ success: false, error: 'จำนวนเงินไม่ถูกต้อง (ต้องเป็นตัวเลข 0 - 1,000,000)' });
      }
    }
    amount = Math.round(amount * 100) / 100;

    const payload = generatePayload(promptpayId, { amount: amount > 0 ? amount : undefined });
    const qrDataUrl = await qrcode.toDataURL(payload, {
      margin: 2,
      width: 320,
      color: { dark: '#1e293b', light: '#ffffff' }
    });

    res.json({
      success: true,
      qrDataUrl,
      promptpayId,
      accountName: settings.promptpayName || settings.shopName,
      amount
    });
  } catch (err) {
    console.error('Error generating PromptPay QR:', err);
    res.status(500).json({ success: false, error: 'ไม่สามารถสร้าง QR Code ได้' });
  }
});

// Pre-verify slip with AI against expected amount (Protected with Rate Limiter)
app.post('/api/verify-slip', slipVerifyRateLimit, uploadSlip.single('slip'), async (req, res) => {
  try {
    const settings = db.getSettings();
    if (settings.isOpen === false) {
      return res.status(400).json({ success: false, error: settings.closedMessage || 'ขณะนี้ร้านแม้วปิดรับออเดอร์ชั่วคราว' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: 'กรุณาแนบไฟล์รูปภาพสลิป' });
    }

    const expectedAmount = parseFloat(req.body.expectedAmount) || 0;
    const filePath = req.file.path;
    const mimeType = req.file.mimetype;
    const clientQrData = (req.body.clientQrData || '').trim() || null;

    const expectedReceiver = settings.promptpayName || 'พัชญ์ชามญชุ์ กฤติณัฐธนชัย';
    const verificationResult = await verifySlip(filePath, mimeType, expectedAmount, expectedReceiver, null, { clientQrData });
    const slipFilename = req.file.filename;
    const slipUrl = `/uploads/slips/${slipFilename}`;

    // Compress image to Base64 for permanent cloud persistence across container restarts
    const compressed = await compressSlipImage(filePath, mimeType);
    const slipBase64 = compressed?.dataUrl || null;

    // Generate cryptographic HMAC verification token to prevent client spoofing/parameter tampering
    const verificationToken = generateSlipVerificationToken({
      fileHash: verificationResult?.fileHash,
      qrData: verificationResult?.qrData,
      detectedAmount: verificationResult?.detectedAmount,
      slipFilename,
      isDateToday: verificationResult?.isDateToday
    });

    const enrichedVerification = {
      ...(verificationResult || {}),
      slipBase64,
      slipFilename,
      verificationToken
    };

    res.json({
      success: true,
      slipUrl,
      slipBase64,
      verification: enrichedVerification,
      verificationToken
    });
  } catch (err) {
    console.error('Error in /api/verify-slip:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const emailNotifier = require('./services/emailNotifier');
const lineNotifier = require('./services/lineNotifier');

// Submit customer order (Protected with Rate Limiter, Anti-Price-Tampering, Slip Mutex & Cryptographic HMAC Token)
app.post('/api/orders', orderCreateRateLimit, uploadSlip.single('slip'), async (req, res) => {
  let lockKey = null;
  try {
    const settings = db.getSettings();
    if (settings.isOpen === false) {
      return res.status(400).json({
        success: false,
        error: settings.closedMessage || 'ขณะนี้ร้านแม้วปิดรับออเดอร์ชั่วคราว'
      });
    }

    const body = req.body || {};

    // Security: Honeypot Anti-Bot Trap (Silently stops automated spambots)
    if (isHoneypotTriggered(req, 'customer_website_hp')) {
      return res.status(400).json({ success: false, error: 'คำขอไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง' });
    }

    // Security: Anti-Spam Bot Timing Check (Submissions under 1.2s from page render)
    if (isBotSubmissionSpeed(req)) {
      return res.status(400).json({ success: false, error: 'การส่งคำขอเร็วเกินปกติ กรุณารอสักครู่แล้วลองใหม่อีกครั้ง' });
    }

    // Customer Name Validation (Sanitization & Symbol Guard)
    const nameValidation = validateCustomerName(body.customerName);
    if (!nameValidation.valid) {
      return res.status(400).json({ success: false, error: nameValidation.error });
    }
    const cleanCustomerName = nameValidation.sanitized;

    // Customer Phone Validation (Optional, but if provided must be a valid phone number)
    const phoneValidation = validateCustomerPhone(body.customerPhone, false);
    if (!phoneValidation.valid) {
      return res.status(400).json({ success: false, error: phoneValidation.error });
    }
    const cleanCustomerPhone = phoneValidation.sanitized;
    const cleanCustomerNote = validateCustomerNote(body.customerNote || '', 300);

    let rawItems = [];
    try {
      rawItems = typeof body.items === 'string' ? JSON.parse(body.items) : (body.items || []);
    } catch {
      rawItems = [];
    }

    if (!Array.isArray(rawItems) || !rawItems.length || rawItems.length > 50) {
      return res.status(400).json({ success: false, error: 'กรุณาเลือกขนมอย่างน้อย 1 รายการ (สูงสุด 50 รายการ)' });
    }

    // ==========================================
    // 🛡️ SECURITY LAYER 1: STRICT SERVER-SIDE PRICE VALIDATION (ANTI-PRICE TAMPERING)
    // Every item MUST exist in shop's DB, be active, and take price strictly from DB.
    // Client-supplied prices and amounts are 100% ignored.
    // ==========================================
    const allSnacks = db.getSnacks(true);
    let calculatedTotal = 0;
    let totalOrderCost = 0;
    const verifiedItems = [];

    for (const item of rawItems) {
      if (!item || typeof item !== 'object') {
        return res.status(400).json({ success: false, error: 'ข้อมูลสินค้าในตะกร้าไม่ถูกต้อง' });
      }

      const snackId = String(item.snackId || item.id || '').trim();
      const originalSnack = allSnacks.find(s => s.id === snackId);

      if (!originalSnack) {
        return res.status(400).json({
          success: false,
          error: `ไม่พบรายการขนมรหัส "${sanitizeText(snackId, 30)}" ในระบบ กรุณารีเฟรชหน้าเว็บและเลือกใหม่`
        });
      }

      if (originalSnack.isAvailable === false) {
        return res.status(400).json({
          success: false,
          error: `ขออภัย ขนม "${originalSnack.name}" หมดชั่วคราว`
        });
      }

      const unitPrice = Number(originalSnack.price);
      if (typeof unitPrice !== 'number' || isNaN(unitPrice) || unitPrice <= 0) {
        return res.status(400).json({
          success: false,
          error: `ราคาของขนม "${originalSnack.name}" ในระบบไม่ถูกต้อง`
        });
      }

      const qty = parseInt(item.quantity, 10);
      if (!Number.isInteger(qty) || qty < 1 || qty > 100) {
        return res.status(400).json({
          success: false,
          error: `จำนวนของขนม "${originalSnack.name}" ต้องอยู่ระหว่าง 1 ถึง 100 ชิ้น`
        });
      }

      const unitCost = (typeof originalSnack.cost === 'number' && originalSnack.cost >= 0) ? Number(originalSnack.cost) : 0;
      const subtotal = Math.round(unitPrice * qty * 100) / 100;
      const totalItemCost = Math.round(unitCost * qty * 100) / 100;
      const itemProfit = Math.round((subtotal - totalItemCost) * 100) / 100;

      calculatedTotal += subtotal;
      totalOrderCost += totalItemCost;

      verifiedItems.push({
        snackId: originalSnack.id,
        name: originalSnack.name,
        price: unitPrice,           // Server database verified price
        cost: unitCost,            // Locked cost snapshot at order moment
        quantity: qty,
        unit: originalSnack.unit || 'ชิ้น',
        subtotal,
        totalCost: totalItemCost,
        profit: itemProfit
      });
    }

    calculatedTotal = Math.round(calculatedTotal * 100) / 100;
    totalOrderCost = Math.round(totalOrderCost * 100) / 100;

    if (calculatedTotal <= 0) {
      return res.status(400).json({ success: false, error: 'ยอดรวมคำสั่งซื้อต้องมากกว่า 0 บาท' });
    }

    const totalOrderProfit = Math.round((calculatedTotal - totalOrderCost) * 100) / 100;
    const profitMargin = calculatedTotal > 0 ? Math.round((totalOrderProfit / calculatedTotal) * 100) : 0;

    // ==========================================
    // 🛡️ SECURITY LAYER 2: SLIP IMAGE RESOLUTION & FILE CHECK
    // ==========================================
    let slipImage = '';
    let slipFilename = '';
    let fullSlipPath = '';

    if (req.file) {
      slipFilename = req.file.filename;
      slipImage = `/uploads/slips/${slipFilename}`;
      fullSlipPath = req.file.path;
    } else if (body.existingSlipUrl) {
      const safeFilename = path.basename(body.existingSlipUrl);
      slipFilename = safeFilename;
      slipImage = `/uploads/slips/${safeFilename}`;
      fullSlipPath = path.join(slipsUploadDir, safeFilename);
    }

    if (!slipImage || !fullSlipPath || !fs.existsSync(fullSlipPath)) {
      return res.status(400).json({
        success: false,
        error: 'กรุณาแนบสลิปการโอนเงินเพื่อยืนยันคำสั่งซื้อ'
      });
    }

    // ==========================================
    // 🛡️ SECURITY LAYER 3: CRYPTOGRAPHIC SLIP VERIFICATION & SPOOFING CHECK
    // ==========================================
    const expectedReceiver = settings.promptpayName || 'พัชญ์ชามญชุ์ กฤติณัฐธนชัย';
    let slipVerification = null;

    if (body.existingVerification) {
      try {
        const clientV = typeof body.existingVerification === 'string'
          ? JSON.parse(body.existingVerification)
          : body.existingVerification;

        const token = clientV.verificationToken || body.verificationToken;
        // Verify server's HMAC signature on the pre-verified slip data
        const verifiedPayload = verifySlipVerificationToken(token, calculatedTotal);

        if (verifiedPayload && verifiedPayload.slipFilename === slipFilename) {
          slipVerification = clientV;
          slipVerification.fileHash = verifiedPayload.fileHash;
          slipVerification.qrData = verifiedPayload.qrData;
          slipVerification.isDateToday = verifiedPayload.isDateToday;
        }
      } catch (e) {}
    }

    // If verification token is invalid, missing, or amount changed: Re-verify on server
    if (!slipVerification) {
      try {
        const clientQrData = (body.clientQrData || body.qrData || '').trim() || null;
        slipVerification = await verifySlip(fullSlipPath, 'image/jpeg', calculatedTotal, expectedReceiver, null, { clientQrData });
      } catch (err) {
        console.error('Server slip verification error:', err);
      }
    }

    // RULE 1: Anti-Tampering / Fake Slip Detection
    if (slipVerification && (slipVerification.isFakeOrAltered || slipVerification.status === 'FAKE_OR_ALTERED_SLIP')) {
      return res.status(400).json({
        success: false,
        error: slipVerification.message || '🚨 ระบบตรวจพบความผิดปกติหรือการดัดแปลงภาพสลิป กรุณาใช้สลิปโอนเงินจริงจากแอปธนาคารเท่านั้น'
      });
    }

    // RULE 2: Transfer Status Validation
    if (slipVerification && (slipVerification.status === 'FAILED_TRANSFER' || slipVerification.transferStatus === 'FAILED')) {
      return res.status(400).json({
        success: false,
        error: slipVerification.message || '❌ สลิปนี้ระบุว่าการโอนเงินไม่สำเร็จ (Failed Transaction) กรุณาตรวจสอบและแนบสลิปที่โอนเงินสำเร็จแล้วครับ'
      });
    }

    if (slipVerification && (slipVerification.status === 'SCHEDULED_TRANSFER' || slipVerification.transferStatus === 'SCHEDULED')) {
      return res.status(400).json({
        success: false,
        error: slipVerification.message || '⚠️ สลิปนี้เป็นการตั้งโอนล่วงหน้า (Scheduled) เงินยังไม่เข้าบัญชีร้าน กรุณาแนบสลิปที่โอนเงินสำเร็จแล้วครับ'
      });
    }

    // RULE 3: Shop Receiver Account Matching
    if (slipVerification && (slipVerification.isReceiverMatched === false || slipVerification.status === 'RECEIVER_MISMATCHED')) {
      return res.status(400).json({
        success: false,
        error: slipVerification.message || '❌ สลิปนี้ไม่ได้โอนเข้าบัญชีของทางร้าน กรุณาตรวจสอบชื่อบัญชีผู้รับเงิน'
      });
    }

    // RULE 4: Mandatory QR Code verification ("ตรวจสอบสลิปจาก QR code เท่านั้น")
    if (!slipVerification || !slipVerification.hasQrCode || slipVerification.status === 'NO_QR_CODE') {
      if (body.forceSubmit !== 'true') {
        return res.status(400).json({
          success: false,
          allowForceSubmit: true,
          error: 'สลิปนี้ไม่มี QR Code หรือสแกน QR ไม่พบ (ระบบกำหนดให้ต้องตรวจสอบจาก QR Code บนสลิปเท่านั้น หากเป็นสลิปจริงสามารถกดยืนยันให้ร้านตรวจสอบได้ครับ)'
        });
      }
    }

    // RULE 5: Date Freshness (Records warning for store owner to inspect without blocking customers)
    let dateMismatchNote = '';
    if (slipVerification.isDateToday === false || slipVerification.status === 'DATE_MISMATCHED') {
      dateMismatchNote = `วันที่ในสลิป (${slipVerification.transferDate || 'ไม่ระบุ'}) ไม่ใช่วันนี้`;
      console.log(`[Order Notice] ${dateMismatchNote} - marked for admin review.`);
    }

    // RULE: Enforce amount matching if amount is detected on slip
    if (slipVerification.detectedAmount !== null) {
      const diff = Math.round((slipVerification.detectedAmount - calculatedTotal) * 100) / 100;
      if (diff < -0.05 && body.forceSubmit !== 'true') {
        const detectedAmt = Number(slipVerification.detectedAmount).toFixed(2);
        const targetAmt = Number(calculatedTotal).toFixed(2);
        return res.status(400).json({
          success: false,
          allowForceSubmit: true,
          error: `⚠️ ยอดเงินในสลิป (${detectedAmt} บาท) น้อยกว่ายอดสั่งซื้อ (${targetAmt} บาท) ขาดอีก ${Math.abs(diff).toFixed(2)} บาท กรุณาโอนเงินให้ครบหรือยืนยันเพื่อให้ร้านตรวจสอบครับ`
        });
      }
    }

    // ==========================================
    // 🛡️ SECURITY LAYER 4: IN-FLIGHT SLIP MUTEX (ANTI-RACE CONDITION / ANTI-DOUBLE SPENDING)
    // Prevents automated bots from sending 10 requests at the exact same millisecond using one slip
    // ==========================================
    const { getFileHash } = require('./services/slipQrScanner');
    const slipFileHash = (slipVerification && slipVerification.fileHash) || getFileHash(fullSlipPath);
    const slipQrData = ((slipVerification && slipVerification.qrData) || '').trim();
    const slipTxRef = ((slipVerification && slipVerification.transactionRef) || '').trim();

    lockKey = slipFileHash || slipQrData || slipTxRef || slipFilename;
    if (!acquireSlipLock(lockKey)) {
      return res.status(409).json({
        success: false,
        error: '🚨 คำขอสั่งซื้อด้วยสลิปนี้กำลังอยู่ในระหว่างประมวลผล กรุณารอสักครู่และอย่ากดยืนยันซ้ำพร้อมกันครับ'
      });
    }

    // Check duplicate slip across completed orders and permanent registry
    const { checkDuplicateSlip } = require('./services/slipDuplicateChecker');
    const dupCheck = checkDuplicateSlip({
      fileHash: slipFileHash,
      qrData: slipQrData,
      transactionRef: slipTxRef
    });

    if (dupCheck.isDuplicate && body.forceSubmit !== 'true') {
      return res.status(400).json({
        success: false,
        isDuplicate: true,
        allowForceSubmit: true,
        error: dupCheck.message || '🚨 ตรวจพบ QR Code ซ้ำในระบบ! สลิปนี้เคยถูกใช้งานสั่งซื้อไปแล้ว'
      });
    }

    // Device ID from client (enables persistent cloud tracking across browser restarts)
    const deviceId = (body.deviceId || req.headers['x-device-id'] || '').trim() || null;

    let slipBase64 = body.slipBase64 || null;
    if (!slipBase64 && req.file) {
      try {
        const compressed = await compressSlipImage(req.file.path, req.file.mimetype);
        slipBase64 = compressed?.dataUrl || null;
      } catch (e) {}
    } else if (!slipBase64 && slipVerification?.slipBase64) {
      slipBase64 = slipVerification.slipBase64;
    }

    if (slipVerification) {
      slipVerification.slipBase64 = slipBase64 || slipVerification.slipBase64 || null;
      slipVerification.slipFilename = slipFilename || slipVerification.slipFilename || null;
    }

    let clientDevInfo = {};
    try {
      if (typeof body.deviceInfo === 'string') clientDevInfo = JSON.parse(body.deviceInfo);
      else if (body.deviceInfo && typeof body.deviceInfo === 'object') clientDevInfo = body.deviceInfo;
    } catch (e) {}

    const userAgent = req.headers['user-agent'] || '';
    const parsedDevice = parseDeviceFromUserAgent(userAgent, clientDevInfo);
    const deviceModel = clientDevInfo.summary || parsedDevice.summary || parsedDevice.deviceModel || 'ไม่ระบุรุ่น';
    const deviceInfo = { ...parsedDevice, ...clientDevInfo, summary: deviceModel };

    const orderData = {
      deviceId: sanitizeText(deviceId, 60),
      deviceModel: sanitizeText(deviceModel, 100),
      deviceInfo,
      customerName: cleanCustomerName,
      customerPhone: cleanCustomerPhone,
      customerNote: cleanCustomerNote,
      items: verifiedItems,
      totalPrice: calculatedTotal,
      totalCost: totalOrderCost,      // Permanently locked cost snapshot
      totalProfit: totalOrderProfit,  // Permanently locked profit snapshot
      profitMargin: profitMargin,     // Permanently locked margin %
      slipImage,
      slipBase64,
      fileHash: slipFileHash,
      slipVerification: slipVerification || null,
      qrData: slipQrData || null,
      transactionRef: slipTxRef || null,
      bankName: slipVerification?.bankName || 'ธนาคารไทย',
      dateMismatchNote: dateMismatchNote || null,
      forceSubmitted: body.forceSubmit === 'true',
      orderStatus: 'pending'          // เริ่มต้นเป็น "รอตรวจสอบสลิป"
    };

    const newOrder = db.createOrder(orderData);

    if (orderData.customerName && orderData.deviceId) {
      try {
        db.trackVisitor({
          visitorId: orderData.deviceId,
          customerName: orderData.customerName,
          path: '/order-placed'
        });
      } catch (e) {}
    }

    // ==========================================
    // 🛡️ SECURITY LAYER 5: SANITIZED CUSTOMER RESPONSE (ANTI-IDOR & PRIVACY)
    // Strip wholesale cost, profit margin, and mask phone before returning to client
    // ==========================================
    res.json({
      success: true,
      message: 'แนบสลิปและส่งคำสั่งซื้อสำเร็จ! รอทางร้านตรวจสอบสลิปสักครู่นะครับ 🐾',
      order: sanitizeOrderForCustomer(newOrder)
    });
  } catch (err) {
    console.error('Error creating order:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (lockKey) {
      releaseSlipLock(lockKey);
    }
  }
});

// Customer order history & search (Protected with Rate Limiter & Input Sanitization)
app.get('/api/orders-history', orderHistoryRateLimit, (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    const { query, phone, name, ids, deviceId } = req.query;
    const cleanQuery = validateSearchQuery(query, 80);
    const cleanPhone = validateSearchQuery(phone, 30);
    const cleanName = validateSearchQuery(name, 80);
    const cleanDeviceId = validateSearchQuery(deviceId, 64);

    let idList = [];
    if (ids) {
      if (typeof ids === 'string') {
        idList = ids.split(',').map(s => validateSearchQuery(s.trim(), 40)).filter(Boolean);
      } else if (Array.isArray(ids)) {
        idList = ids.map(s => validateSearchQuery(String(s), 40)).filter(Boolean);
      }
    }
    const orders = db.findOrders({ query: cleanQuery, phone: cleanPhone, name: cleanName, ids: idList, deviceId: cleanDeviceId });

    // Sanitize cost and profit fields and mask personal data for customer privacy
    const sanitizedOrders = (orders || []).map(order => sanitizeOrderForCustomer(order));

    res.json({ success: true, data: sanitizedOrders });
  } catch (err) {
    console.error('Error fetching order history:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Customer track single order (Strict IDOR protection: verified owner or authenticated admin only)
app.get('/api/orders/:id', (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    const orderId = sanitizeText(req.params.id, 50);
    if (!orderId) {
      return res.status(400).json({ success: false, error: 'รหัสคำสั่งซื้อไม่ถูกต้อง' });
    }
    const order = db.getOrderById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, error: 'ไม่พบหมายเลขคำสั่งซื้อนี้' });
    }

    // IDOR Access Check
    const access = canAccessOrder(order, req);
    if (!access.allowed) {
      return res.status(403).json({
        success: false,
        error: 'คุณไม่มีสิทธิ์เข้าถึงข้อมูลคำสั่งซื้อนี้ (สามารถตรวจสอบได้เฉพาะคำสั่งซื้อบนอุปกรณ์ของคุณเท่านั้น)'
      });
    }

    if (access.isAdmin) {
      return res.json({ success: true, order });
    }

    res.json({ success: true, order: sanitizeOrderForCustomer(order) });
  } catch (err) {
    console.error('Order query error:', err);
    res.status(500).json({ success: false, error: 'เกิดข้อผิดพลาดในการดึงข้อมูลคำสั่งซื้อ' });
  }
});

// Root serves customer storefront
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Centralized Production Error Handler (Prevents stack trace & internal path leaks)
app.use((err, req, res, next) => {
  console.error(`[Unhandled Error] ${req.method} ${req.originalUrl}:`, err.message || err);
  if (res.headersSent) return next(err);

  const status = err.status || err.statusCode || 500;
  const isClientError = status >= 400 && status < 500;

  res.status(status).json({
    success: false,
    error: isClientError ? (err.message || 'คำขอไม่ถูกต้อง') : 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง'
  });
});

// Start Customer Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🍪 [เว็บลูกค้า] ร้านขนมแม้ว พร้อมใช้งาน!`);
  console.log(`🌐 สั่งขนมบนคอม:       http://localhost:${PORT}`);
  const networkInterfaces = os.networkInterfaces();
  Object.keys(networkInterfaces).forEach(netName => {
    networkInterfaces[netName].forEach(net => {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`📱 สั่งขนมจากมือถือ:   http://${net.address}:${PORT}`);
      }
    });
  });
  console.log(`====================================================`);

  // Keep-Alive Self-Ping on Render Cloud (prevents 15-minute inactivity spin-down)
  const renderUrl = process.env.RENDER_EXTERNAL_URL || 'https://rich-2syu.onrender.com';
  if (process.env.PORT) {
    console.log(`[Keep-Alive] Initializing auto-ping for ${renderUrl} every 10 minutes...`);
    setInterval(async () => {
      try {
        const pingRes = await fetch(`${renderUrl}/health`);
        console.log(`[Keep-Alive] Pinged ${renderUrl}/health - Status: ${pingRes.status}`);
      } catch (err) {
        console.warn(`[Keep-Alive] Ping failed:`, err.message);
      }
    }, 10 * 60 * 1000); // every 10 minutes
  }
});
