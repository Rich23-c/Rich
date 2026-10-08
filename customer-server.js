require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const generatePayload = require('promptpay-qr');
const qrcode = require('qrcode');

const db = require('./services/database');
const { verifySlip } = require('./services/slipVerifier');

const app = express();
const PORT = process.env.PORT || process.env.CUSTOMER_PORT || 3000;

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

// Serve static assets for Customer Storefront
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

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
    const slipUrl = `/uploads/slips/${req.file.filename}`;

    res.json({
      success: true,
      slipUrl,
      verification: verificationResult
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

    // Calculate server-side total price to ensure accuracy
    const allSnacks = db.getSnacks(true);
    let calculatedTotal = 0;
    const verifiedItems = items.map(item => {
      const originalSnack = allSnacks.find(s => s.id === item.snackId) || {};
      const unitPrice = originalSnack.price !== undefined ? originalSnack.price : Number(item.price) || 0;
      const qty = Math.max(1, parseInt(item.quantity) || 1);
      const subtotal = unitPrice * qty;
      calculatedTotal += subtotal;
      return {
        snackId: item.snackId,
        name: originalSnack.name || item.name || 'ขนม',
        price: unitPrice,
        quantity: qty,
        unit: originalSnack.unit || item.unit || 'ชิ้น',
        subtotal
      };
    });

    let slipImage = '';
    let slipVerification = null;

    const expectedReceiver = settings.promptpayName || 'พัชญ์ชามญชุ์ กฤติณัฐธนชัย';

    if (req.file) {
      slipImage = `/uploads/slips/${req.file.filename}`;
      // Verify slip with AI for Price, Date, and Receiver
      slipVerification = await verifySlip(req.file.path, req.file.mimetype, calculatedTotal, expectedReceiver);
    } else if (body.existingSlipUrl) {
      slipImage = body.existingSlipUrl;
      try {
        slipVerification = typeof body.existingVerification === 'string'
          ? JSON.parse(body.existingVerification)
          : (body.existingVerification || null);
      } catch {
        slipVerification = null;
      }
    }

    if (!slipVerification) {
      return res.status(400).json({
        success: false,
        error: 'กรุณาแนบสลิปการโอนเงินเพื่อยืนยันคำสั่งซื้อ'
      });
    }

    // Re-verify duplicate slip check on server side to prevent re-use
    const { checkDuplicateSlip } = require('./services/slipDuplicateChecker');
    const dupCheck = checkDuplicateSlip({
      fileHash: slipVerification.fileHash,
      qrData: slipVerification.qrData,
      transactionRef: slipVerification.transactionRef
    });

    if (dupCheck.isDuplicate) {
      return res.status(400).json({
        success: false,
        error: dupCheck.message || 'สลิปนี้เคยถูกใช้งานแล้ว ไม่สามารถใช้ซ้ำได้',
        isDuplicate: true,
        verification: slipVerification
      });
    }

    // If slip price or date is not valid, do not save order
    if (!slipVerification.isReadyToSave) {
      return res.status(400).json({
        success: false,
        error: slipVerification.message || 'ข้อมูลในสลิปไม่ถูกต้อง',
        verification: slipVerification
      });
    }

    // All checks passed! Save order
    const orderData = {
      customerName: body.customerName,
      customerPhone: body.customerPhone || '',
      customerEmail: body.customerEmail || '',
      customerAddress: '', // Delivery address removed per user request
      customerNote: body.customerNote || '',
      items: verifiedItems,
      totalPrice: calculatedTotal,
      slipImage,
      slipVerification,
      fileHash: slipVerification.fileHash || null,
      qrData: slipVerification.qrData || null,
      transactionRef: slipVerification.transactionRef || null,
      orderStatus: 'verified' // Automatically verified!
    };

    const newOrder = db.createOrder(orderData);

    // Send Email notification to shop owner in background
    emailNotifier.sendOrderEmail(newOrder).catch(err => {
      console.warn('[Email Notification] Background error:', err.message);
    });

    res.json({
      success: true,
      message: 'ตรวจสอบสลิปและวันที่สำเร็จ! บันทึกคำสั่งซื้อเรียบร้อยแล้ว',
      order: newOrder,
      verification: slipVerification
    });
  } catch (err) {
    console.error('Error creating order:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Customer order history & search
app.get('/api/orders-history', (req, res) => {
  try {
    const { query, phone, name, ids } = req.query;
    let idList = [];
    if (ids) {
      idList = typeof ids === 'string' ? ids.split(',').map(s => s.trim()).filter(Boolean) : ids;
    }
    const orders = db.findOrders({ query, phone, name, ids: idList });
    res.json({ success: true, data: orders });
  } catch (err) {
    console.error('Error fetching order history:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Customer track single order
app.get('/api/orders/:id', (req, res) => {
  try {
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
});
