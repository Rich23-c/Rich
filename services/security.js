const crypto = require('crypto');

// ==========================================
// 🛡️ SECURITY MODULE: HARDENED DEFENSE
// ==========================================

// Rate Limiting Memory Stores
const loginAttempts = new Map(); // ip -> { count: number, lockedUntil: number, lastAttempt: number }
const slipVerifyLimits = new Map(); // ip -> { count: number, resetAt: number }
const orderCreateLimits = new Map(); // ip -> { count: number, resetAt: number }

// Configuration Constants
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // Lock for 15 minutes after 5 failed attempts
const LOGIN_ARTIFICIAL_DELAY_MS = 600;   // 600ms slow-down against high-speed bot cracking

const SLIP_VERIFY_LIMIT = 20; // 20 verifications per 5 minutes per IP
const ORDER_CREATE_LIMIT = 25; // 25 orders per 5 minutes per IP
const RATE_WINDOW_MS = 5 * 60 * 1000;

// Periodic Cleanup to prevent memory leak (runs every 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of loginAttempts.entries()) {
    if (now > (data.lockedUntil || (data.lastAttempt + LOGIN_LOCKOUT_MS))) {
      loginAttempts.delete(ip);
    }
  }
  for (const [ip, data] of slipVerifyLimits.entries()) {
    if (now > data.resetAt) slipVerifyLimits.delete(ip);
  }
  for (const [ip, data] of orderCreateLimits.entries()) {
    if (now > data.resetAt) orderCreateLimits.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// Get real client IP address (supporting Reverse Proxies like Render / Cloudflare)
function getClientIp(req) {
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    const ips = xForwardedFor.split(',');
    return ips[0].trim();
  }
  const cfConnectingIp = req.headers['cf-connecting-ip'];
  if (cfConnectingIp) return String(cfConnectingIp).trim();
  return req.socket ? req.socket.remoteAddress : '127.0.0.1';
}

// ==========================================
// 1. ADMIN LOGIN BRUTE-FORCE PROTECTION
// ==========================================
function checkLoginRateLimit(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (!record) {
    return { allowed: true, remainingAttempts: MAX_LOGIN_ATTEMPTS };
  }

  // Check if IP is currently locked out
  if (record.lockedUntil && now < record.lockedUntil) {
    const remainingMs = record.lockedUntil - now;
    const remainingMinutes = Math.ceil(remainingMs / 60000);
    return {
      allowed: false,
      isLocked: true,
      remainingMinutes,
      error: `🛑 คุณใส่รหัสผ่านผิดเกินกำหนด ระบบระงับการเข้าสู่ระบบเพื่อความปลอดภัย กรุณารอ ${remainingMinutes} นาที`
    };
  }

  // If lockout expired, reset
  if (record.lockedUntil && now >= record.lockedUntil) {
    loginAttempts.delete(ip);
    return { allowed: true, remainingAttempts: MAX_LOGIN_ATTEMPTS };
  }

  const remaining = Math.max(0, MAX_LOGIN_ATTEMPTS - record.count);
  return { allowed: true, remainingAttempts: remaining };
}

async function recordLoginFailure(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, lockedUntil: null, lastAttempt: now };

  record.count += 1;
  record.lastAttempt = now;

  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    record.lockedUntil = now + LOGIN_LOCKOUT_MS;
    console.warn(`[Security Alert] IP ${ip} exceeded maximum login attempts (${record.count}). Locked for 15 minutes.`);
  }

  loginAttempts.set(ip, record);

  // Apply artificial slow-down to mitigate automated brute-force attacks
  await new Promise(resolve => setTimeout(resolve, LOGIN_ARTIFICIAL_DELAY_MS));

  return {
    isLocked: !!record.lockedUntil,
    remainingAttempts: Math.max(0, MAX_LOGIN_ATTEMPTS - record.count),
    lockoutMinutes: 15
  };
}

function recordLoginSuccess(req) {
  const ip = getClientIp(req);
  loginAttempts.delete(ip);
}

// ==========================================
// 2. CONSTANT-TIME TIMING-SAFE COMPARISON
// ==========================================
function safeComparePin(candidate, secret) {
  if (typeof candidate !== 'string' || typeof secret !== 'string') return false;
  const candStr = candidate.trim();
  const secStr = secret.trim();
  if (!candStr || !secStr) return false;

  const candBuf = Buffer.from(candStr, 'utf8');
  const secBuf = Buffer.from(secStr, 'utf8');

  if (candBuf.length !== secBuf.length) {
    // Perform dummy constant-time compare to mitigate length timing leak
    crypto.timingSafeEqual(secBuf, secBuf);
    return false;
  }

  return crypto.timingSafeEqual(candBuf, secBuf);
}

// ==========================================
// 3. RATE LIMITING FOR PUBLIC APIs
// ==========================================
function createRateLimiter(store, limit, windowMs, message) {
  return (req, res, next) => {
    const ip = getClientIp(req);
    const now = Date.now();
    let record = store.get(ip);

    if (!record || now > record.resetAt) {
      record = { count: 1, resetAt: now + windowMs };
      store.set(ip, record);
      return next();
    }

    if (record.count >= limit) {
      const waitSec = Math.ceil((record.resetAt - now) / 1000);
      return res.status(429).json({
        success: false,
        error: message || `คุณส่งคำขอถี่เกินไป กรุณารอ ${waitSec} วินาทีแล้วลองใหม่อีกครั้ง`
      });
    }

    record.count += 1;
    next();
  };
}

const slipVerifyRateLimit = createRateLimiter(
  slipVerifyLimits,
  SLIP_VERIFY_LIMIT,
  RATE_WINDOW_MS,
  'คำขอตรวจสอบสลิปถี่เกินกำหนด เพื่อความปลอดภัยของระบบ กรุณารอ 2-3 นาทีแล้วลองใหม่อีกครั้งครับ'
);

const orderCreateRateLimit = createRateLimiter(
  orderCreateLimits,
  ORDER_CREATE_LIMIT,
  RATE_WINDOW_MS,
  'คำขอสร้างออเดอร์ถี่เกินกำหนด กรุณารอสักครู่แล้วลองใหม่อีกครั้งครับ'
);

// ==========================================
// 4. XSS INPUT SANITIZATION
// ==========================================
function sanitizeText(input, maxLength = 500) {
  if (!input) return '';
  return String(input)
    .replace(/\0/g, '') // remove null bytes
    .replace(/<[^>]*>/g, '') // strip HTML tags
    .replace(/[<>'"]/g, '') // remove script brackets & quotes
    .trim()
    .slice(0, maxLength);
}

function sanitizeOrderInput(orderData) {
  if (!orderData || typeof orderData !== 'object') return orderData;
  return {
    ...orderData,
    customerName: sanitizeText(orderData.customerName, 80),
    customerPhone: sanitizeText(orderData.customerPhone, 30),
    deliveryAddress: sanitizeText(orderData.deliveryAddress, 500),
    customerNotes: sanitizeText(orderData.customerNotes, 300)
  };
}

// ==========================================
// 5. HTTP SECURITY HEADERS MIDDLEWARE
// ==========================================
function securityHeadersMiddleware(req, res, next) {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Prevent clickjacking by denying iframing on foreign domains
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Enable XSS auditor
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Control referrer information leakage
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Restrict unused browser features
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Enforce HTTPS HSTS when behind SSL proxy
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

// ==========================================
// 6. SAFE FILE UPLOAD FILTER
// ==========================================
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function slipFileFilter(req, file, cb) {
  const ext = (require('path').extname(file.originalname) || '').toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();

  if (!ALLOWED_MIME_TYPES.has(mime) || !ALLOWED_EXTENSIONS.has(ext)) {
    return cb(new Error('ไฟล์ที่อัปโหลดต้องเป็นรูปภาพ (JPG, PNG หรือ WebP) เท่านั้น'));
  }
  cb(null, true);
}

module.exports = {
  getClientIp,
  checkLoginRateLimit,
  recordLoginFailure,
  recordLoginSuccess,
  safeComparePin,
  slipVerifyRateLimit,
  orderCreateRateLimit,
  sanitizeText,
  sanitizeOrderInput,
  securityHeadersMiddleware,
  slipFileFilter
};
