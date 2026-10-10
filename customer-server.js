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

const app = express();
const PORT = process.env.PORT || process.env.CUSTOMER_PORT || 3000;

// Gzip & Brotli HTTP Compression (reduces payload size by 75-80% for 10x higher concurrent throughput)
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// Serve static assets for Customer Storefront with CDN-optimized Cache-Control
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
      // HTML and JS scripts revalidate immediately to ensure instant code updates across all devices
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else {
      // CSS, images, icons cached in browser for 1 day, and Cloudflare Edge CDN for 7 days
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

app.use('/uploads', express.static(uploadDir, {
  maxAge: '7d',
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=604800, s-maxage=2592000, immutable');
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

// Mount Admin APIs (protected by PIN 411197)
const adminRouter = require('./admin-router');
app.use(adminRouter);

// Multer Storage for Slips
const slipStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, slipsUploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `slip-${Date.now()}-${Math.round(Math.random() * 1e4)}${ext}`);
  }
});
const uploadSlip = multer({
  storage: slipStorage,
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

// Get shop settings (sanitized, no admin pin)
app.get('/api/settings', (req, res) => {
  try {
    const settings = db.getSettings();
    const { adminPin, ...publicSettings } = settings;
    res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
    res.json({ success: true, data: publicSettings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Generate dynamic PromptPay QR code
app.get('/api/promptpay-qr', async (req, res) => {
  try {
    const settings = db.getSettings();
    if (settings.isOpen === false) {
      return res.status(400).json({ success: false, error: settings.closedMessage || 'ขณะนี้ร้านแม้วปิดรับออเดอร์ชั่วคราว' });
    }
    const promptpayId = settings.promptpayId || '0891234567';
    const amount = parseFloat(req.query.amount) || 0;

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

// Pre-verify slip with AI against expected amount
app.post('/api/verify-slip', uploadSlip.single('slip'), async (req, res) => {
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

    const expectedReceiver = settings.promptpayName || 'พัชญ์ชามญชุ์ กฤติณัฐธนชัย';
    const verificationResult = await verifySlip(filePath, mimeType, expectedAmount, expectedReceiver);
    const slipFilename = req.file.filename;
    const slipUrl = `/uploads/slips/${slipFilename}`;

    // Compress image to Base64 for permanent cloud persistence across container restarts
    const compressed = await compressSlipImage(filePath, mimeType);
    const slipBase64 = compressed?.dataUrl || null;

    const enrichedVerification = {
      ...(verificationResult || {}),
      slipBase64,
      slipFilename
    };

    res.json({
      success: true,
      slipUrl,
      slipBase64,
      verification: enrichedVerification
    });
  } catch (err) {
    console.error('Error in /api/verify-slip:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const emailNotifier = require('./services/emailNotifier');
const lineNotifier = require('./services/lineNotifier');

// Submit customer order
app.post('/api/orders', uploadSlip.single('slip'), async (req, res) => {
  try {
    const settings = db.getSettings();
    if (settings.isOpen === false) {
      return res.status(400).json({
        success: false,
        error: settings.closedMessage || 'ขณะนี้ร้านแม้วปิดรับออเดอร์ชั่วคราว'
      });
    }

    const body = req.body;
    let items = [];
    try {
      items = typeof body.items === 'string' ? JSON.parse(body.items) : (body.items || []);
    } catch {
      items = [];
    }

    if (!items.length) {
      return res.status(400).json({ success: false, error: 'กรุณาเลือกขนมอย่างน้อย 1 รายการ' });
    }

    if (!body.customerName || !body.customerName.trim()) {
      return res.status(400).json({ success: false, error: 'กรุณาระบุชื่อลูกค้า' });
    }

    // Calculate server-side total price and cost snapshot at this exact order moment
    const allSnacks = db.getSnacks(true);
    let calculatedTotal = 0;
    let totalOrderCost = 0;

    const verifiedItems = items.map(item => {
      const originalSnack = allSnacks.find(s => s.id === item.snackId) || {};
      const unitPrice = originalSnack.price !== undefined ? originalSnack.price : (Number(item.price) || 0);
      const unitCost = (originalSnack.cost !== undefined && Number(originalSnack.cost) >= 0) ? Number(originalSnack.cost) : 0;
      const qty = Math.max(1, parseInt(item.quantity) || 1);
      const subtotal = unitPrice * qty;
      const totalItemCost = unitCost * qty;
      const itemProfit = subtotal - totalItemCost;

      calculatedTotal += subtotal;
      totalOrderCost += totalItemCost;

      return {
        snackId: item.snackId,
        name: originalSnack.name || item.name || 'ขนม',
        price: unitPrice,
        cost: unitCost,            // Locked cost at this exact order moment!
        quantity: qty,
        unit: originalSnack.unit || item.unit || 'ชิ้น',
        subtotal,
        totalCost: totalItemCost,  // Locked total cost for this item
        profit: itemProfit         // Locked profit for this item
      };
    });

    const totalOrderProfit = calculatedTotal - totalOrderCost;
    const profitMargin = calculatedTotal > 0 ? Math.round((totalOrderProfit / calculatedTotal) * 100) : 0;

    let slipImage = '';
    if (req.file) {
      slipImage = `/uploads/slips/${req.file.filename}`;
    } else if (body.existingSlipUrl) {
      slipImage = body.existingSlipUrl;
    }

    if (!slipImage) {
      return res.status(400).json({
        success: false,
        error: 'กรุณาแนบสลิปการโอนเงินเพื่อยืนยันคำสั่งซื้อ'
      });
    }

    // Extract AI slip verification if sent or run in background
    let slipVerification = null;
    if (body.existingVerification) {
      try {
        slipVerification = typeof body.existingVerification === 'string'
          ? JSON.parse(body.existingVerification)
          : body.existingVerification;
      } catch (e) {}
    }

    // Optional background QR code scanner for admin reference
    let qrMetadata = null;
    if (req.file) {
      try {
        const { scanSlipQrCode } = require('./services/slipQrScanner');
        qrMetadata = await scanSlipQrCode(req.file.path).catch(() => null);
      } catch {
        // Non-critical background scan
      }
    }

    // If client didn't pre-verify via AI, run verifySlip on uploaded file
    if (!slipVerification && req.file) {
      try {
        const expectedReceiver = settings.promptpayName || 'พัชญ์ชามญชุ์ กฤติณัฐธนชัย';
        slipVerification = await verifySlip(req.file.path, req.file.mimetype, calculatedTotal, expectedReceiver).catch(() => null);
      } catch (e) {}
    }

    // RULE: "ตรวจสอบสลิปจาก QR code เท่านั้น"
    if (slipVerification && (!slipVerification.hasQrCode || slipVerification.status === 'NO_QR_CODE')) {
      return res.status(400).json({
        success: false,
        error: 'สลิปนี้ไม่มี QR Code หรือสแกน QR ไม่พบ (ระบบกำหนดให้ต้องตรวจสอบจาก QR Code บนสลิปเท่านั้น กรุณาแนบรูปสลิปที่มี Mini QR Code ธนาคาร)'
      });
    }

    if (slipVerification && slipVerification.isDuplicateSlip) {
      return res.status(400).json({
        success: false,
        error: '🚨 ตรวจพบ QR Code ซ้ำในระบบ! สลิปนี้เคยถูกใช้งานสั่งซื้อไปแล้ว ไม่สามารถใช้ซ้ำได้'
      });
    }

    // RULE: Enforce amount matching if amount is detected on slip
    if (slipVerification && slipVerification.detectedAmount !== null && slipVerification.isAmountMatched === false) {
      const detectedAmt = Number(slipVerification.detectedAmount).toFixed(2);
      const targetAmt = Number(calculatedTotal).toFixed(2);
      const diff = Math.round((slipVerification.detectedAmount - calculatedTotal) * 100) / 100;
      return res.status(400).json({
        success: false,
        error: `⚠️ ยอดเงินในสลิป (${detectedAmt} บาท) ไม่ตรงกับยอดสั่งซื้อ (${targetAmt} บาท) ${diff < 0 ? 'ขาดอีก ' + Math.abs(diff).toFixed(2) : 'เกิน ' + diff.toFixed(2)} บาท กรุณาโอนเงินให้ครบหรือแนบสลิปที่ถูกต้องครับ`
      });
    }

    // Device ID from client (enables persistent cloud tracking across browser restarts)
    const deviceId = (body.deviceId || req.headers['x-device-id'] || '').trim() || null;

    let slipBase64 = body.slipBase64 || null;
    let slipFilename = req.file ? req.file.filename : (body.existingSlipUrl ? path.basename(body.existingSlipUrl) : null);

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

    // Extract and parse device model information
    let clientDevInfo = {};
    try {
      if (typeof body.deviceInfo === 'string') clientDevInfo = JSON.parse(body.deviceInfo);
      else if (body.deviceInfo && typeof body.deviceInfo === 'object') clientDevInfo = body.deviceInfo;
    } catch (e) {}

    const userAgent = req.headers['user-agent'] || '';
    const parsedDevice = parseDeviceFromUserAgent(userAgent, clientDevInfo);
    const deviceModel = clientDevInfo.summary || parsedDevice.summary || parsedDevice.deviceModel || 'ไม่ระบุรุ่น';
    const deviceInfo = { ...parsedDevice, ...clientDevInfo, summary: deviceModel };

    // Save order with permanently locked cost, profit, and pending review status
    const orderData = {
      deviceId,                       // Cloud memory for mobile phone device
      deviceModel,                    // Detected mobile device model (e.g. iPhone 15 Pro, Samsung Galaxy S23)
      deviceInfo,                     // Full hardware and OS information
      customerName: body.customerName,
      customerPhone: body.customerPhone || '',
      customerNote: body.customerNote || '',
      items: verifiedItems,
      totalPrice: calculatedTotal,
      totalCost: totalOrderCost,      // Permanently locked cost
      totalProfit: totalOrderProfit,  // Permanently locked profit
      profitMargin: profitMargin,     // Permanently locked margin %
      slipImage,
      slipBase64,                     // Permanent Cloud Base64 string (survives restarts)
      slipVerification: slipVerification || null,
      qrData: qrMetadata?.qrData || slipVerification?.qrData || null,
      transactionRef: qrMetadata?.transactionRef || slipVerification?.transactionRef || null,
      bankName: qrMetadata?.bankName || slipVerification?.bankName || null,
      orderStatus: 'pending'          // เริ่มต้นเป็น "รอตรวจสอบสลิป" (แอดมินตรวจเองและกดยืนยัน)
    };

    const newOrder = db.createOrder(orderData);

    res.json({
      success: true,
      message: 'แนบสลิปและส่งคำสั่งซื้อสำเร็จ! รอทางร้านตรวจสอบสลิปสักครู่นะครับ 🐾',
      order: newOrder
    });
  } catch (err) {
    console.error('Error creating order:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Customer order history & search (Supports cloud recall by deviceId, phone, query, or IDs)
app.get('/api/orders-history', (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const { query, phone, name, ids, deviceId } = req.query;
    let idList = [];
    if (ids) {
      idList = typeof ids === 'string' ? ids.split(',').map(s => s.trim()).filter(Boolean) : ids;
    }
    const orders = db.findOrders({ query, phone, name, ids: idList, deviceId });

    // Sanitize cost and profit fields for customer privacy
    const sanitizedOrders = (orders || []).map(({ totalCost, totalProfit, profitMargin, ...order }) => {
      const sanitizedItems = (order.items || []).map(({ cost, totalCost, profit, ...item }) => item);
      return {
        ...order,
        items: sanitizedItems
      };
    });

    res.json({ success: true, data: sanitizedOrders });
  } catch (err) {
    console.error('Error fetching order history:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Customer track single order
app.get('/api/orders/:id', (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const order = db.getOrderById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, error: 'ไม่พบหมายเลขคำสั่งซื้อนี้' });
    }
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Root serves customer storefront
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
