const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');

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
  slipFileFilter,
  generateTotpSecret,
  generateTotpUri,
  verifyTotpCode,
  generateTemp2FAToken,
  verifyTemp2FAToken,
  check2FARateLimit,
  record2FAFailure,
  record2FASuccess
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

// Helper to check if request is served over HTTPS
function isSecureConnection(req) {
  return process.env.NODE_ENV === 'production' || req.secure || req.headers['x-forwarded-proto'] === 'https';
}

// Middleware for Admin Authentication (Strict HttpOnly Session Cookie & Bearer Token Check)
function requireAdmin(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // 1. Verify Cryptographic Session Token from HttpOnly Cookie (Primary & Secure)
  const cookieToken = req.cookies && req.cookies.snack_admin_session;
  if (cookieToken && verifyAdminSessionToken(cookieToken)) {
    return next();
  }

  // 2. Fallback to Authorization Header (Bearer token for CLI / API clients)
  const authHeader = req.headers.authorization;
  const headerToken = (authHeader && authHeader.startsWith('Bearer '))
    ? authHeader.slice(7).trim()
    : req.headers['x-admin-token'];

  if (headerToken && verifyAdminSessionToken(headerToken)) {
    return next();
  }

  return res.status(401).json({
    success: false,
    error: 'สิทธิ์การเข้าใช้งานไม่ถูกต้องหรือหมดอายุ กรุณาเข้าสู่ระบบใหม่'
  });
}

// ==========================================
// ADMIN EXCLUSIVE APIs
// ==========================================

// Admin session verification check (used by frontend on page load)
router.get(['/auth-check', '/api/admin/auth-check'], requireAdmin, (req, res) => {
  res.json({ success: true, authenticated: true });
});

// Admin logout: clears HttpOnly session cookie
router.post(['/logout', '/api/admin/logout'], (req, res) => {
  const isSecure = isSecureConnection(req);
  res.clearCookie('snack_admin_session', {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'strict',
    path: '/'
  });
  res.json({ success: true, message: 'ออกจากระบบเรียบร้อยแล้ว' });
});

// Admin login verification with Brute-Force Rate Limiting, Lockout & HttpOnly Cookie
router.post(['/login', '/api/admin/login'], async (req, res) => {
  try {
    const rateCheck = checkLoginRateLimit(req);
    if (!rateCheck.allowed) {
      return res.status(429).json({ success: false, error: rateCheck.error });
    }

    const { pin } = req.body || {};
    if (!pin || typeof pin !== 'string') {
      return res.status(400).json({ success: false, error: 'กรุณากรอกรหัสผ่าน PIN' });
    }

    if (db.verifyAdminPin(pin)) {
      recordLoginSuccess(req);
      const clientIp = getClientIp(req);
      const settings = db.getSettings();

      // Check if Two-Factor Authentication (2FA) is enabled
      if (settings.twoFactorEnabled && settings.twoFactorSecret) {
        const temp2faToken = generateTemp2FAToken(clientIp);
        return res.json({
          success: true,
          require2FA: true,
          message: 'กรุณากรอกรหัสยืนยัน 6 หลักจาก Google Authenticator',
          temp2faToken
        });
      }

      // Direct login when 2FA is not enabled
      const token = generateAdminSessionToken(clientIp);
      const isSecure = isSecureConnection(req);
      res.cookie('snack_admin_session', token, {
        httpOnly: true,
        secure: isSecure,
        sameSite: 'strict',
        path: '/',
        maxAge: 12 * 60 * 60 * 1000 // 12 hours
      });

      return res.json({
        success: true,
        message: 'เข้าสู่ระบบสำเร็จ'
      });
    }

    const failInfo = await recordLoginFailure(req);
    if (failInfo.isLocked) {
      return res.status(429).json({
        success: false,
        error: '🛑 มีการพยายามเข้าสู่ระบบผิดเกินกำหนด ระบบระงับการเข้าสู่ระบบ 15 นาที เพื่อความปลอดภัย'
      });
    }

    // Neutral error message prevents username/PIN enumeration
    return res.status(401).json({
      success: false,
      error: 'ข้อมูลการเข้าสู่ระบบไม่ถูกต้อง กรุณาตรวจสอบและลองใหม่อีกครั้ง'
    });
  } catch (err) {
    console.error('Admin login exception:', err);
    return res.status(500).json({ success: false, error: 'ระบบตรวจสอบรหัสผ่านขัดข้อง กรุณาลองใหม่อีกครั้ง' });
  }
});

// Step 2: 2FA Google Authenticator TOTP Verification
router.post(['/login/verify-2fa', '/api/admin/login/verify-2fa'], async (req, res) => {
  try {
    const rateCheck = check2FARateLimit(req);
    if (!rateCheck.allowed) {
      return res.status(429).json({ success: false, error: rateCheck.error });
    }

    const { temp2faToken, code } = req.body || {};
    const clientIp = getClientIp(req);

    if (!temp2faToken || !verifyTemp2FAToken(temp2faToken, clientIp)) {
      return res.status(401).json({
        success: false,
        error: 'โทเค็นยืนยัน 2FA หมดอายุหรือคำขอไม่ถูกต้อง กรุณากรอกรหัส PIN ใหม่อีกครั้ง'
      });
    }

    const cleanCode = String(code || '').replace(/\D/g, '').trim();
    if (!cleanCode || cleanCode.length !== 6) {
      return res.status(400).json({
        success: false,
        error: 'กรุณากรอกรหัสยืนยันเป็นตัวเลข 6 หลัก'
      });
    }

    const settings = db.getSettings();
    if (!settings.twoFactorEnabled || !settings.twoFactorSecret) {
      return res.status(400).json({
        success: false,
        error: 'ระบบไม่ได้เปิดใช้งาน 2FA กรุณาเข้าสู่ระบบด้วยรหัส PIN ตามปกติ'
      });
    }

    const isValid = verifyTotpCode(cleanCode, settings.twoFactorSecret);
    if (!isValid) {
      const failInfo = record2FAFailure(req);
      if (failInfo.isLocked) {
        return res.status(429).json({
          success: false,
          error: '🛑 ยืนยันรหัส 2FA ผิดเกินกำหนด ระบบระงับการเข้าสู่ระบบ 15 นาที เพื่อความปลอดภัย'
        });
      }
      return res.status(401).json({
        success: false,
        error: 'รหัส 2FA ไม่ถูกต้อง กรุณาดูรหัส 6 หลักล่าสุดจากแอป Google Authenticator'
      });
    }

    // 2FA Verified Successfully!
    record2FASuccess(req);
    const token = generateAdminSessionToken(clientIp);
    const isSecure = isSecureConnection(req);
    res.cookie('snack_admin_session', token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'strict',
      path: '/',
      maxAge: 12 * 60 * 60 * 1000 // 12 hours
    });

    return res.json({
      success: true,
      message: 'ยืนยันตัวตน 2FA สำเร็จ เข้าสู่ระบบเรียบร้อย'
    });
  } catch (err) {
    console.error('2FA verification exception:', err);
    return res.status(500).json({ success: false, error: 'ระบบตรวจสอบ 2FA ขัดข้อง กรุณาลองใหม่อีกครั้ง' });
  }
});

// Admin change PIN
router.post(['/change-pin', '/api/admin/change-pin'], requireAdmin, (req, res) => {
  try {
    const { currentPin, newPin } = req.body || {};
    if (!currentPin || !db.verifyAdminPin(currentPin)) {
      return res.status(400).json({ success: false, error: 'รหัส PIN เดิมไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง' });
    }
    const trimmedNewPin = String(newPin || '').trim();
    if (!trimmedNewPin || trimmedNewPin.length < 4 || trimmedNewPin.length > 20) {
      return res.status(400).json({ success: false, error: 'รหัส PIN ใหม่ต้องมีความยาวระหว่าง 4 ถึง 20 ตัวอักษรหรือตัวเลข' });
    }
    db.updateSettings({ adminPin: trimmedNewPin });

    // Issue refreshed session cookie
    const clientIp = getClientIp(req);
    const token = generateAdminSessionToken(clientIp);
    const isSecure = isSecureConnection(req);
    res.cookie('snack_admin_session', token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'strict',
      path: '/',
      maxAge: 12 * 60 * 60 * 1000
    });

    return res.json({ success: true, message: 'เปลี่ยนรหัส PIN เรียบร้อยแล้ว' });
  } catch (err) {
    console.error('Change PIN exception:', err);
    return res.status(500).json({ success: false, error: 'เกิดข้อผิดพลาดในการเปลี่ยนรหัส PIN' });
  }
});

// Admin get all snacks
router.get(['/snacks', '/api/admin/snacks'], requireAdmin, (req, res) => {
  try {
    const snacks = db.getSnacks(true);
    res.json({ success: true, data: snacks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin add new snack (with image file or image URL)
router.post(['/snacks', '/api/admin/snacks'], requireAdmin, uploadSnackImage.single('imageFile'), (req, res) => {
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
router.put(['/snacks/reorder', '/api/admin/snacks/reorder'], requireAdmin, (req, res) => {
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
router.put(['/snacks/:id', '/api/admin/snacks/:id'], requireAdmin, uploadSnackImage.single('imageFile'), (req, res) => {
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
router.delete(['/snacks/:id', '/api/admin/snacks/:id'], requireAdmin, (req, res) => {
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
router.post(['/upload-banner', '/api/admin/upload-banner'], requireAdmin, uploadSnackImage.single('bannerFile'), (req, res) => {
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
router.get(['/orders', '/api/admin/orders'], requireAdmin, (req, res) => {
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

router.patch(['/orders/:id/status', '/api/admin/orders/:id/status'], requireAdmin, (req, res) => {
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
router.post(['/reset-mock-orders', '/api/admin/reset-mock-orders'], requireAdmin, async (req, res) => {
  try {
    await db.resetOrders();
    res.json({ success: true, message: 'ล้างข้อมูลคำสั่งซื้อทั้งหมดเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin delete single order
router.delete(['/orders/:id', '/api/admin/orders/:id'], requireAdmin, async (req, res) => {
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
router.delete(['/orders', '/api/admin/orders'], requireAdmin, async (req, res) => {
  try {
    await db.resetOrders();
    res.json({ success: true, message: 'ล้างข้อมูลคำสั่งซื้อทั้งหมดเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin upload shop QR Code image
router.post(['/upload-qr', '/api/admin/upload-qr'], requireAdmin, uploadQrImage.single('qrImage'), (req, res) => {
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

// Admin test Email notification (ดึง credentials จาก database/settings เพื่อความปลอดภัย หลีกเลี่ยงการส่งรหัสผ่านผ่าน HTTP Request)
router.post(['/test-email', '/api/admin/test-email'], requireAdmin, async (req, res) => {
  try {
    const settings = db.getSettings();
    const appPassword = settings.emailAppPassword || process.env.EMAIL_APP_PASSWORD || req.body?.appPassword;
    const sender = req.body?.sender || settings.emailSender || process.env.EMAIL_SENDER;
    const receiver = req.body?.receiver || settings.emailReceiver || sender;

    if (!sender || !appPassword) {
      return res.status(400).json({
        success: false,
        error: 'ยังไม่ได้ตั้งค่า Email ผู้ส่ง หรือ รหัสผ่านแอป (App Password) ในระบบ กรุณาบันทึกการตั้งค่าก่อนทดสอบ'
      });
    }

    await emailNotifier.sendTestEmail(receiver, sender, appPassword);
    res.json({ success: true, message: 'ส่งอีเมลทดสอบเรียบร้อยแล้ว! กรุณาเช็กกล่องจดหมายของคุณ' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Admin test LINE notification
router.post(['/test-line', '/api/admin/test-line'], requireAdmin, async (req, res) => {
  try {
    const { token, targetId } = req.body;
    await lineNotifier.sendTestNotification(token, targetId);
    res.json({ success: true, message: 'ส่งข้อความทดสอบเข้า LINE เรียบร้อยแล้ว!' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Admin get settings
router.get(['/settings', '/api/admin/settings'], requireAdmin, (req, res) => {
  try {
    const settings = db.getSettings();
    const safeSettings = { ...settings };
    delete safeSettings.adminPin;
    delete safeSettings.adminPinHash;
    delete safeSettings.twoFactorSecret;
    delete safeSettings.twoFactorPendingSecret;
    safeSettings.twoFactorEnabled = !!settings.twoFactorEnabled;
    res.json({ success: true, data: safeSettings });
  } catch (err) {
    console.error('Get settings exception:', err);
    res.status(500).json({ success: false, error: 'เกิดข้อผิดพลาดในการดึงข้อมูลการตั้งค่า' });
  }
});

// Admin update settings
router.put(['/settings', '/api/admin/settings'], requireAdmin, (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.isOpen !== undefined) {
      updates.isOpen = (updates.isOpen === true || updates.isOpen === 'true');
    }
    // Prevent overriding 2FA secrets via generic settings endpoint
    delete updates.twoFactorSecret;
    delete updates.twoFactorPendingSecret;
    delete updates.twoFactorEnabled;

    const updated = db.updateSettings(updates);
    const safeSettings = { ...updated };
    delete safeSettings.adminPin;
    delete safeSettings.adminPinHash;
    delete safeSettings.twoFactorSecret;
    delete safeSettings.twoFactorPendingSecret;
    safeSettings.twoFactorEnabled = !!updated.twoFactorEnabled;
    res.json({ success: true, data: safeSettings });
  } catch (err) {
    console.error('Update settings exception:', err);
    res.status(500).json({ success: false, error: 'เกิดข้อผิดพลาดในการบันทึกการตั้งค่า' });
  }
});

// ==========================================
// 2FA GOOGLE AUTHENTICATOR MANAGEMENT APIs
// ==========================================

// Get 2FA Status
router.get(['/2fa/status', '/api/admin/2fa/status'], requireAdmin, (req, res) => {
  try {
    const settings = db.getSettings();
    res.json({
      success: true,
      twoFactorEnabled: !!settings.twoFactorEnabled
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Initiate 2FA Setup: Generates secret & QR code
router.get(['/2fa/setup', '/api/admin/2fa/setup'], requireAdmin, async (req, res) => {
  try {
    const shouldRegenerate = req.query.regenerate === 'true';
    const settings = db.getSettings();

    // Preserve existing pending secret or active secret so reopening modal or refreshing does NOT break already-scanned codes
    let secret = (!shouldRegenerate && (settings.twoFactorPendingSecret || settings.twoFactorSecret))
      ? (settings.twoFactorPendingSecret || settings.twoFactorSecret)
      : generateTotpSecret();

    const issuer = 'Snack by Maew Admin';
    const account = 'admin';
    const otpauthUri = generateTotpUri(secret, account, issuer);

    // Render QR Code as PNG Data URL
    const qrCodeDataUrl = await qrcode.toDataURL(otpauthUri, {
      width: 280,
      margin: 2,
      color: {
        dark: '#0f172a',
        light: '#ffffff'
      }
    });

    // Store pending secret until verified with first 6-digit code
    db.updateSettings({ twoFactorPendingSecret: secret });

    res.json({
      success: true,
      secret,
      manualKey: secret,
      issuer,
      account,
      otpauthUri,
      qrCodeDataUrl,
      isRegenerated: shouldRegenerate,
      message: 'สร้างคีย์ 2FA สำเร็จ กรุณาสแกน QR Code ด้วยแอป Google Authenticator'
    });
  } catch (err) {
    console.error('2FA setup exception:', err);
    res.status(500).json({ success: false, error: 'เกิดข้อผิดพลาดในการสร้างรหัส 2FA: ' + err.message });
  }
});

// Confirm 2FA Setup with 6-digit code from Google Authenticator
router.post(['/2fa/verify-setup', '/api/admin/2fa/verify-setup'], requireAdmin, (req, res) => {
  try {
    const { code } = req.body || {};
    const cleanCode = String(code || '').replace(/\D/g, '').trim();

    if (!cleanCode || cleanCode.length !== 6) {
      return res.status(400).json({
        success: false,
        error: 'กรุณากรอกรหัสยืนยัน 6 หลักจาก Google Authenticator'
      });
    }

    const settings = db.getSettings();
    const candidateSecret = settings.twoFactorPendingSecret || settings.twoFactorSecret;
    if (!candidateSecret) {
      return res.status(400).json({
        success: false,
        error: 'ไม่พบคำขอตั้งค่า 2FA กรุณากดเริ่มการตั้งค่าหรือสแกน QR Code ใหม่อีกครั้ง'
      });
    }

    const isValid = verifyTotpCode(cleanCode, candidateSecret);
    if (!isValid) {
      return res.status(400).json({
        success: false,
        error: 'รหัส 6 หลักไม่ถูกต้อง กรุณาดูรหัส 6 หลักล่าสุดจาก Google Authenticator หรือตรวจสอบเวลาในโทรศัพท์'
      });
    }

    // Activate 2FA permanently in database
    db.updateSettings({
      twoFactorEnabled: true,
      twoFactorSecret: candidateSecret,
      twoFactorPendingSecret: null
    });

    res.json({
      success: true,
      message: 'เปิดใช้งานการยืนยันตัวตน 2 ขั้นตอน (2FA) สำเร็จเรียบร้อยแล้ว! 🔒'
    });
  } catch (err) {
    console.error('2FA verify setup exception:', err);
    res.status(500).json({ success: false, error: 'เกิดข้อผิดพลาดในการเปิดใช้งาน 2FA: ' + err.message });
  }
});

// Disable 2FA: Requires Admin PIN verification
router.post(['/2fa/disable', '/api/admin/2fa/disable'], requireAdmin, (req, res) => {
  try {
    const { pin } = req.body || {};
    if (!pin || !db.verifyAdminPin(pin)) {
      return res.status(400).json({
        success: false,
        error: 'รหัส PIN แอดมินไม่ถูกต้อง ไม่สามารถปิดใช้งาน 2FA ได้'
      });
    }

    db.updateSettings({
      twoFactorEnabled: false,
      twoFactorSecret: null,
      twoFactorPendingSecret: null
    });

    res.json({
      success: true,
      message: 'ปิดการใช้งานการยืนยันตัวตน 2 ขั้นตอน (2FA) เรียบร้อยแล้ว'
    });
  } catch (err) {
    console.error('2FA disable exception:', err);
    res.status(500).json({ success: false, error: 'เกิดข้อผิดพลาดในการปิดใช้งาน 2FA: ' + err.message });
  }
});

// Admin test Gemini API key
router.post(['/test-gemini-key', '/api/admin/test-gemini-key'], requireAdmin, async (req, res) => {
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
router.post(['/save-gemini-keys', '/api/admin/save-gemini-keys'], requireAdmin, (req, res) => {
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
router.post(['/toggle-open', '/api/admin/toggle-open'], requireAdmin, (req, res) => {
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
router.get(['/database-status', '/api/admin/database-status'], requireAdmin, (req, res) => {
  try {
    const status = db.getDatabaseStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin get visitor analytics (daily counts, individual visitor visit history & codes)
router.get(['/analytics/visitors', '/api/admin/analytics/visitors'], requireAdmin, (req, res) => {
  try {
    const analytics = db.getVisitorAnalytics();
    res.json({ success: true, data: analytics });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin reset visitor analytics
router.delete(['/analytics/visitors', '/api/admin/analytics/visitors'], requireAdmin, (req, res) => {
  try {
    const success = db.resetVisitorAnalytics();
    res.json({ success: true, message: 'รีเซ็ตข้อมูลสถิติผู้เข้าชมเรียบร้อยแล้ว' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin get live security audit logs (failed logins, blocked probes, banned IPs)
router.get(['/security-logs', '/api/admin/security-logs'], requireAdmin, (req, res) => {
  try {
    const logs = getSecurityAuditLogs();
    res.json({ success: true, count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
