const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const db = require('./services/database');
const emailNotifier = require('./services/emailNotifier');
const lineNotifier = require('./services/lineNotifier');
const {
  checkLoginRateLimit,
  recordLoginFailure,
  recordLoginSuccess,
  generateAdminSessionToken,
  verifyAdminSessionToken,
  getClientIp,
  getSecurityAuditLogs,
  slipFileFilter
} = require('./services/security');

const router = express.Router();

// Ensure upload directories exist
const uploadDir = path.join(__dirname, 'uploads');
const snacksUploadDir = path.join(uploadDir, 'snacks');
if (!fs.existsSync(snacksUploadDir)) {
  fs.mkdirSync(snacksUploadDir, { recursive: true });
}

// Multer Storage for Snacks (Safe image filter applied)
const snackStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, snacksUploadDir),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
    cb(null, `snack-${Date.now()}-${Math.round(Math.random() * 1e4)}${ext}`);
  }
});
const uploadSnackImage = multer({
  storage: snackStorage,
  fileFilter: slipFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});
const uploadQrImage = multer({
  storage: multer.memoryStorage(),
  fileFilter: slipFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Middleware for Admin Authentication (Supports Cryptographic HMAC Session Tokens & Direct PIN)
function requireAdmin(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  // 1. Verify Cryptographic HMAC Token
  const token = req.headers['x-admin-token'] || (req.headers.authorization && req.headers.authorization.replace('Bearer ', ''));
  if (token && verifyAdminSessionToken(token)) {
    return next();
  }

  // 2. Fallback to PIN Header or Body
  const pin = req.headers['x-admin-pin'] || (req.body && req.body.adminPin) || req.query.pin;
  if (pin && db.verifyAdminPin(pin)) {
    return next();
  }

  return res.status(401).json({ success: false, error: 'สิทธิ์การเข้าใช้งานไม่ถูกต้องหรือหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
}

// ==========================================
// ADMIN EXCLUSIVE APIs
// ==========================================

// Admin login verification with Brute-Force Rate Limiting, Lockout & Cryptographic Session Token
router.post('/api/admin/login', async (req, res) => {
  try {
    const rateCheck = checkLoginRateLimit(req);
    if (!rateCheck.allowed) {
      return res.status(429).json({ success: false, error: rateCheck.error });
    }

    const { pin } = req.body || {};
    if (db.verifyAdminPin(pin)) {
      recordLoginSuccess(req);
      const clientIp = getClientIp(req);
      const token = generateAdminSessionToken(clientIp);
      return res.json({
        success: true,
        message: 'เข้าสู่ระบบสำเร็จ',
        token,
        expiresIn: '8 hours'
      });
    }

    const failInfo = await recordLoginFailure(req);
    if (failInfo.isLocked) {
      return res.status(429).json({
        success: false,
        error: `🛑 คุณใส่รหัสผ่านผิดครบ 5 ครั้งแล้ว! ระบบระงับการล็อกอิน 15 นาที เพื่อป้องกันการแฮ็ก`
      });
    }

    return res.status(401).json({
      success: false,
      error: `รหัสผ่าน Admin ไม่ถูกต้อง (สามารถลองได้อีก ${failInfo.remainingAttempts} ครั้ง ก่อนระบบล็อก)`
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'ระบบตรวจสอบรหัสผ่านขัดข้อง' });
  }
});

// Admin change PIN
router.post('/api/admin/change-pin', requireAdmin, (req, res) => {
  try {
    const { currentPin, newPin } = req.body;
    const sessionPin = req.headers['x-admin-pin'] || req.query.pin;
    if (currentPin && !db.verifyAdminPin(currentPin) && !db.verifyAdminPin(sessionPin)) {
      return res.status(400).json({ success: false, error: 'รหัส PIN เดิมไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง' });
    }
    const trimmedNewPin = String(newPin || '').trim();
    if (!trimmedNewPin || trimmedNewPin.length < 4 || trimmedNewPin.length > 20) {
      return res.status(400).json({ success: false, error: 'รหัส PIN ใหม่ต้องมีความยาวระหว่าง 4 ถึง 20 ตัวอักษรหรือตัวเลข' });
    }
    db.updateSettings({ adminPin: trimmedNewPin });
    return res.json({ success: true, message: 'เปลี่ยนรหัส PIN เรียบร้อยแล้ว', newPin: trimmedNewPin });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Admin get all snacks
router.get('/api/admin/snacks', requireAdmin, (req, res) => {
  try {
    const snacks = db.getSnacks(true);
    res.json({ success: true, data: snacks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin add new snack (with image file or image URL)
router.post('/api/admin/snacks', requireAdmin, uploadSnackImage.single('imageFile'), (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, error: 'กรุณากรอกชื่อขนม' });
    }

    const price = Number(req.body.price);
    if (isNaN(price) || price <= 0) {
      return res.status(400).json({ success: false, error: 'กรุณากรอกราคาขนมที่ถูกต้อง (> 0 บาท)' });
    }

    let imageUrl = req.body.imageUrl || '';
    if (req.file) {
      imageUrl = `/uploads/snacks/${req.file.filename}`;
    }

    const snackData = {
      name,
      price,
      cost: req.body.cost !== undefined && req.body.cost !== '' ? Number(req.body.cost) : 0,
      unit: req.body.unit || 'ชิ้น',
      description: req.body.description || '',
      image: imageUrl,
      isAvailable: req.body.isAvailable !== 'false' && req.body.isAvailable !== false
    };

    const created = db.saveSnack(snackData);
    res.json({ success: true, data: created });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin reorder snacks (เรียงลำดับขนม)
router.put('/api/admin/snacks/reorder', requireAdmin, (req, res) => {
  try {
    const { orderedIds } = req.body;
    if (!orderedIds || !Array.isArray(orderedIds)) {
      return res.status(400).json({ success: false, error: 'กรุณาระบุ orderedIds เป็น Array' });
    }
    const updated = db.reorderSnacks(orderedIds);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin update snack
router.put('/api/admin/snacks/:id', requireAdmin, uploadSnackImage.single('imageFile'), (req, res) => {
  try {
    let imageUrl = req.body.imageUrl;
    if (req.file) {
      imageUrl = `/uploads/snacks/${req.file.filename}`;
    }

    const updates = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ success: false, error: 'ชื่อขนมต้องไม่ว่างเปล่า' });
      updates.name = name;
    }
    if (req.body.price !== undefined && req.body.price !== '') {
      const price = Number(req.body.price);
      if (isNaN(price) || price <= 0) return res.status(400).json({ success: false, error: 'ราคาขนมต้องมากกว่า 0 บาท' });
      updates.price = price;
    }
    if (req.body.cost !== undefined && req.body.cost !== '') {
      const cost = Number(req.body.cost);
      updates.cost = !isNaN(cost) && cost >= 0 ? cost : 0;
    }
    if (req.body.unit !== undefined) updates.unit = req.body.unit;
    if (req.body.description !== undefined) updates.description = req.body.description;
    if (req.body.isAvailable !== undefined) {
      updates.isAvailable = (req.body.isAvailable === 'true' || req.body.isAvailable === true);
    }

    if (imageUrl) {
      updates.image = imageUrl;
    }

    const updated = db.updateSnack(req.params.id, updates);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'ไม่พบรายการขนมนี้' });
    }
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin delete snack
router.delete('/api/admin/snacks/:id', requireAdmin, (req, res) => {
  try {
    const success = db.deleteSnack(req.params.id);
    if (!success) {
      return res.status(404).json({ success: false, error: 'ไม่พบขนมที่ต้องการลบ' });
    }
    res.json({ success: true, message: 'ลบขนมเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin upload sponsor banner image
router.post('/api/admin/upload-banner', requireAdmin, uploadSnackImage.single('bannerFile'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'กรุณาเลือกไฟล์รูปภาพแบนเนอร์' });
    }
    const imageUrl = `/uploads/snacks/${req.file.filename}`;
    res.json({ success: true, imageUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin get all orders
router.get('/api/admin/orders', requireAdmin, (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const orders = db.getOrders();
    res.json({ success: true, data: orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin update order status
const ALLOWED_ORDER_STATUSES = new Set(['pending', 'verified', 'preparing', 'prepared', 'delivered', 'cancelled']);

router.patch('/api/admin/orders/:id/status', requireAdmin, (req, res) => {
  try {
    const { status, adminNotes } = req.body;
    if (!status || !ALLOWED_ORDER_STATUSES.has(status)) {
      return res.status(400).json({ success: false, error: 'สถานะคำสั่งซื้อไม่ถูกต้อง' });
    }
    const updated = db.updateOrderStatus(req.params.id, status, adminNotes);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'ไม่พบคำสั่งซื้อนี้' });
    }
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin reset all orders (Clear / Reset orders)
router.post('/api/admin/reset-mock-orders', requireAdmin, async (req, res) => {
  try {
    await db.resetOrders();
    res.json({ success: true, message: 'ล้างข้อมูลคำสั่งซื้อทั้งหมดเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin delete single order
router.delete('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  try {
    const success = await db.deleteOrder(req.params.id);
    if (!success) {
      return res.status(404).json({ success: false, error: 'ไม่พบหมายเลขคำสั่งซื้อที่ต้องการลบ' });
    }
    res.json({ success: true, message: 'ลบรายการสั่งซื้อเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin delete all orders (alias)
router.delete('/api/admin/orders', requireAdmin, async (req, res) => {
  try {
    await db.resetOrders();
    res.json({ success: true, message: 'ล้างข้อมูลคำสั่งซื้อทั้งหมดเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin upload shop QR Code image
router.post('/api/admin/upload-qr', requireAdmin, uploadQrImage.single('qrImage'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'กรุณาเลือกไฟล์รูปภาพ QR Code' });
    }
    const publicImagesDir = path.join(__dirname, 'public', 'images');
    if (!fs.existsSync(publicImagesDir)) {
      fs.mkdirSync(publicImagesDir, { recursive: true });
    }
    const filename = `shop-qr-${Date.now()}.png`;
    const destPath = path.join(publicImagesDir, filename);
    fs.writeFileSync(destPath, req.file.buffer);

    // Overwrite default shop-qr.png as well
    try {
      fs.writeFileSync(path.join(publicImagesDir, 'shop-qr.png'), req.file.buffer);
    } catch (e) {}

    const qrUrl = `/images/${filename}`;
    const updated = db.updateSettings({ promptpayQrImage: qrUrl });

    res.json({ success: true, qrUrl, data: updated, message: 'อัปโหลดและบันทึกรูป QR Code สำเร็จแล้ว 🎉' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin test Email notification
router.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  try {
    const { receiver, sender, appPassword } = req.body;
    await emailNotifier.sendTestEmail(receiver, sender, appPassword);
    res.json({ success: true, message: 'ส่งอีเมลทดสอบเรียบร้อยแล้ว! กรุณาเช็กกล่องจดหมายของคุณ' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Admin test LINE notification
router.post('/api/admin/test-line', requireAdmin, async (req, res) => {
  try {
    const { token, targetId } = req.body;
    await lineNotifier.sendTestNotification(token, targetId);
    res.json({ success: true, message: 'ส่งข้อความทดสอบเข้า LINE เรียบร้อยแล้ว!' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Admin get settings
router.get('/api/admin/settings', requireAdmin, (req, res) => {
  try {
    const settings = db.getSettings();
    res.json({ success: true, data: settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin update settings
router.put('/api/admin/settings', requireAdmin, (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.isOpen !== undefined) {
      updates.isOpen = (updates.isOpen === true || updates.isOpen === 'true');
    }
    const updated = db.updateSettings(updates);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin test Gemini API key
router.post('/api/admin/test-gemini-key', requireAdmin, async (req, res) => {
  try {
    const key = (req.body.apiKey || '').trim() || (db.getSettings().geminiApiKeys || '').split(',')[0].trim();
    if (!key) {
      return res.status(400).json({ success: false, error: 'ไม่พบคีย์ Gemini API กรุณากรอกคีย์ก่อนทดสอบ' });
    }
    const testUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
    const testRes = await fetch(testUrl);
    const data = await testRes.json();
    if (!testRes.ok || data.error) {
      return res.status(400).json({ success: false, error: data.error?.message || 'คีย์ไม่ถูกต้อง หรือไม่มีสิทธิ์ใช้งาน' });
    }
    const count = data.models ? data.models.length : 0;
    res.json({ success: true, message: `เชื่อมต่อ Google Gemini สำเร็จ! (พบ ${count} โมเดล AI)`, count });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin save Gemini API keys directly
router.post('/api/admin/save-gemini-keys', requireAdmin, (req, res) => {
  try {
    const { geminiApiKeys } = req.body;
    const trimmed = (geminiApiKeys || '').trim();
    if (!trimmed) {
      return res.status(400).json({ success: false, error: 'กรุณากรอกคีย์ Gemini API' });
    }
    const updated = db.updateSettings({ geminiApiKeys: trimmed });
    res.json({ success: true, message: 'บันทึกคีย์ Gemini API เรียบร้อยแล้ว', geminiApiKeys: updated.geminiApiKeys });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin quick toggle open/close
router.post('/api/admin/toggle-open', requireAdmin, (req, res) => {
  try {
    const current = db.getSettings();
    const newStatus = req.body.isOpen !== undefined
      ? (req.body.isOpen === true || req.body.isOpen === 'true')
      : !current.isOpen;
    const updated = db.updateSettings({ isOpen: newStatus });
    res.json({ success: true, isOpen: updated.isOpen, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin get database status & sync info
router.get('/api/admin/database-status', requireAdmin, (req, res) => {
  try {
    const status = db.getDatabaseStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin get visitor analytics (daily counts, individual visitor visit history & codes)
router.get('/api/admin/analytics/visitors', requireAdmin, (req, res) => {
  try {
    const analytics = db.getVisitorAnalytics();
    res.json({ success: true, data: analytics });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin reset visitor analytics
router.delete('/api/admin/analytics/visitors', requireAdmin, (req, res) => {
  try {
    const success = db.resetVisitorAnalytics();
    res.json({ success: true, message: 'รีเซ็ตข้อมูลสถิติผู้เข้าชมเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin get live security audit logs (failed logins, blocked probes, banned IPs)
router.get('/api/admin/security-logs', requireAdmin, (req, res) => {
  try {
    const logs = getSecurityAuditLogs();
    res.json({ success: true, count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
