const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const db = require('./services/database');
const emailNotifier = require('./services/emailNotifier');
const lineNotifier = require('./services/lineNotifier');

const router = express.Router();

// Ensure upload directories exist
const uploadDir = path.join(__dirname, 'uploads');
const snacksUploadDir = path.join(uploadDir, 'snacks');
if (!fs.existsSync(snacksUploadDir)) {
  fs.mkdirSync(snacksUploadDir, { recursive: true });
}

// Multer Storage for Snacks
const snackStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, snacksUploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `snack-${Date.now()}-${Math.round(Math.random() * 1e4)}${ext}`);
  }
});
const uploadSnackImage = multer({
  storage: snackStorage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Middleware for Admin PIN Verification (strictly no caching on admin data)
function requireAdmin(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const pin = req.headers['x-admin-pin'] || req.query.pin;
  if (!pin || !db.verifyAdminPin(pin)) {
    return res.status(401).json({ success: false, error: 'รหัสผ่าน Admin ไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่' });
  }
  next();
}

// ==========================================
// ADMIN EXCLUSIVE APIs
// ==========================================

// Admin login verification
router.post('/api/admin/login', (req, res) => {
  const { pin } = req.body;
  if (db.verifyAdminPin(pin)) {
    return res.json({ success: true, message: 'เข้าสู่ระบบสำเร็จ' });
  }
  return res.status(401).json({ success: false, error: 'รหัสผ่าน Admin ไม่ถูกต้อง' });
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
    let imageUrl = req.body.imageUrl || '';
    if (req.file) {
      imageUrl = `/uploads/snacks/${req.file.filename}`;
    }

    const snackData = {
      name: req.body.name,
      price: req.body.price,
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
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.price !== undefined && req.body.price !== '') updates.price = Number(req.body.price);
    if (req.body.cost !== undefined && req.body.cost !== '') updates.cost = Number(req.body.cost);
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
router.patch('/api/admin/orders/:id/status', requireAdmin, (req, res) => {
  try {
    const { status, adminNotes } = req.body;
    const updated = db.updateOrderStatus(req.params.id, status, adminNotes);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'ไม่พบคำสั่งซื้อนี้' });
    }
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin reset mock orders
router.post('/api/admin/reset-mock-orders', requireAdmin, (req, res) => {
  try {
    db.resetOrders();
    res.json({ success: true, message: 'ล้างข้อมูลคำสั่งซื้อทดลองเรียบร้อยแล้ว' });
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

module.exports = router;
