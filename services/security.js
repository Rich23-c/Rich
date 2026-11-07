const crypto = require('crypto');
const path = require('path');
const { generateSecret, generateURI, verifySync } = require('otplib');

// ==========================================
// 🛡️ SECURITY FORTRESS MODULE (ENTERPRISE GRADE)
// ==========================================

// Memory Stores
const loginAttempts = new Map();       // ip -> { count: number, lockedUntil: number, lastAttempt: number }
const twoFaAttempts = new Map();       // ip -> { count: number, lockedUntil: number, lastAttempt: number }
const slipVerifyLimits = new Map();    // ip -> { count: number, resetAt: number }
const orderCreateLimits = new Map();   // ip -> { count: number, resetAt: number }
const visitorTrackLimits = new Map();  // ip -> { count: number, resetAt: number }
const promptPayQrLimits = new Map();   // ip -> { count: number, resetAt: number }
const orderHistoryLimits = new Map();  // ip -> { count: number, resetAt: number }
const publicApiLimits = new Map();     // ip -> { count: number, resetAt: number }
const bannedIps = new Map();           // ip -> unbanTimestamp (24-hour malicious bot blacklist)
const securityAuditLogs = [];          // Circular buffer: last 50 security events

// Cryptographic Session Secret (Loaded from environment, with runtime fallback & console warning)
let SESSION_SECRET = process.env.ADMIN_SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('\x1b[33m%s\x1b[0m', '====================================================');
  console.warn('\x1b[33m%s\x1b[0m', '⚠️  [SECURITY WARNING] ไม่พบค่า ADMIN_SESSION_SECRET ใน .env');
  console.warn('\x1b[33m%s\x1b[0m', '🔄 กำลังใช้คีย์ Session Secret สุ่มชั่วคราว (crypto.randomBytes)');
  console.warn('\x1b[33m%s\x1b[0m', '📌 ข้อควรระวัง: เมื่อรีสตาร์ตเซิร์ฟเวอร์ เซสชันแอดมินที่ล็อกอินอยู่จะหลุดทั้งหมด');
  console.warn('\x1b[33m%s\x1b[0m', '👉 โปรดตั้งค่า ADMIN_SESSION_SECRET=<ความยาว 32+ ตัวอักษร> ใน .env ก่อนขึ้น Production!');
  console.warn('\x1b[33m%s\x1b[0m', '====================================================');
}
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours valid session

// Configuration Constants
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;      // Lock for 15 minutes after 5 failed attempts
const MAX_2FA_ATTEMPTS = 5;                   // Lock for 15 minutes after 5 failed 2FA attempts
const TWO_FA_LOCKOUT_MS = 15 * 60 * 1000;
const LOGIN_ARTIFICIAL_DELAY_MS = 600;        // 600ms slow-down against high-speed bot cracking
const BAN_DURATION_MS = 24 * 60 * 60 * 1000;  // 24 hours auto-ban for active attack attempts

const SLIP_VERIFY_LIMIT = 20;   // 20 verifications per 5 minutes per IP
const ORDER_CREATE_LIMIT = 25;  // 25 orders per 5 minutes per IP
const VISITOR_TRACK_LIMIT = 80; // 80 visits per 5 minutes per IP
const PROMPTPAY_QR_LIMIT = 40;  // 40 QR renders per 5 minutes per IP
const ORDER_HISTORY_LIMIT = 50; // 50 searches per 5 minutes per IP
const PUBLIC_API_LIMIT = 120;   // 120 requests per 1 minute per IP
const RATE_WINDOW_MS = 5 * 60 * 1000;

// Known Scanner & Exploit Signatures (Hacker Bots Target Patterns)
const MALICIOUS_PATTERNS = [
  /\/\.env/i,
  /\/\.git/i,
  /\/\.svn/i,
  /\/\.aws/i,
  /\/\.htaccess/i,
  /\/wp-admin/i,
  /\/wp-login/i,
  /\/xmlrpc\.php/i,
  /\/phpmyadmin/i,
  /\/pma/i,
  /\/adminer/i,
  /\/shell\.php/i,
  /\/eval-stdin/i,
  /\/\.ds_store/i,
  /\/actuator/i,
  /\/swagger/i,
  /\.\.\/|\.\.\\/i,  // Path traversal
  /%2e%2e%2f|%2e%2e\/|\.\.%2f/i // Encoded path traversal
];

// Helper: Record Security Audit Event (Keeps latest 50 events)
function recordSecurityEvent(type, details = {}) {
  const event = {
    id: crypto.randomBytes(6).toString('hex'),
    type,
    timestamp: new Date().toISOString(),
    ...details
  };
  securityAuditLogs.unshift(event);
  if (securityAuditLogs.length > 50) securityAuditLogs.pop();
  return event;
}

function getSecurityAuditLogs() {
  return [...securityAuditLogs];
}

// Periodic Cleanup to prevent memory leak (runs every 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of loginAttempts.entries()) {
    if (now > (data.lockedUntil || (data.lastAttempt + LOGIN_LOCKOUT_MS))) {
      loginAttempts.delete(ip);
    }
  }
  for (const [ip, data] of twoFaAttempts.entries()) {
    if (now > (data.lockedUntil || (data.lastAttempt + TWO_FA_LOCKOUT_MS))) {
      twoFaAttempts.delete(ip);
    }
  }
  for (const [ip, unbanTime] of bannedIps.entries()) {
    if (now > unbanTime) bannedIps.delete(ip);
  }
  for (const [ip, data] of slipVerifyLimits.entries()) {
    if (now > data.resetAt) slipVerifyLimits.delete(ip);
  }
  for (const [ip, data] of orderCreateLimits.entries()) {
    if (now > data.resetAt) orderCreateLimits.delete(ip);
  }
  for (const [ip, data] of visitorTrackLimits.entries()) {
    if (now > data.resetAt) visitorTrackLimits.delete(ip);
  }
  for (const [ip, data] of promptPayQrLimits.entries()) {
    if (now > data.resetAt) promptPayQrLimits.delete(ip);
  }
  for (const [ip, data] of orderHistoryLimits.entries()) {
    if (now > data.resetAt) orderHistoryLimits.delete(ip);
  }
  for (const [ip, data] of publicApiLimits.entries()) {
    if (now > data.resetAt) publicApiLimits.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// Get real client IP address (supporting Reverse Proxies like Render / Cloudflare)
function getClientIp(req) {
  if (!req) return '127.0.0.1';
  const headers = req.headers || {};
  const cfConnectingIp = headers['cf-connecting-ip'];
  if (cfConnectingIp) return String(cfConnectingIp).trim();
  const xForwardedFor = headers['x-forwarded-for'];
  if (xForwardedFor) {
    const ips = xForwardedFor.split(',');
    return ips[0].trim();
  }
  return req.socket ? req.socket.remoteAddress : '127.0.0.1';
}

// ==========================================
// 1. INTRUSION DETECTION & AUTO-BAN BLACKLIST
// ==========================================
function intrusionDetectionMiddleware(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();

  // 1. Check if IP is currently in 24-hour Auto-Ban blacklist
  // (Exempt admin login so legitimate owner can always unban themselves with the PIN)
  const isAuthRoute = req.path === '/api/admin/login' || req.path === '/api/admin/login/verify-2fa' || req.path === '/admin';
  const unbanAt = bannedIps.get(ip);
  if (unbanAt && now < unbanAt && !isAuthRoute) {
    const remainingHrs = Math.ceil((unbanAt - now) / 3600000);
    return res.status(403).json({
      success: false,
      error: `Access Denied: Your IP has been blacklisted for malicious probing (${remainingHrs}h remaining).`
    });
  }

  // 2. Check request path and query for known exploit/scanner signatures
  const fullUrl = req.originalUrl || req.url || '';
  const isMalicious = MALICIOUS_PATTERNS.some(regex => regex.test(fullUrl));

  if (isMalicious) {
    const banUntil = now + BAN_DURATION_MS;
    bannedIps.set(ip, banUntil);
    recordSecurityEvent('MALICIOUS_PROBE_BLOCKED', {
      ip,
      path: fullUrl,
      action: '24-hour Auto-Ban activated',
      userAgent: (req.headers['user-agent'] || '').slice(0, 100)
    });
    console.warn(`[🚨 Intrusion Detected] Blocked and banned IP ${ip} for accessing: ${fullUrl}`);
    return res.status(403).json({
      success: false,
      error: 'Security Warning: Malicious request signature detected. IP blacklisted for 24 hours.'
    });
  }

  next();
}

// ==========================================
// 2. PROTOTYPE POLLUTION GUARD
// ==========================================
function hasPrototypePollution(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return false;
  for (const key of Object.keys(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return true;
    }
    if (typeof obj[key] === 'object' && hasPrototypePollution(obj[key], depth + 1)) {
      return true;
    }
  }
  return false;
}

function prototypePollutionGuard(req, res, next) {
  if (req.body && hasPrototypePollution(req.body)) {
    recordSecurityEvent('PROTOTYPE_POLLUTION_BLOCKED', { ip: getClientIp(req), path: req.path });
    return res.status(400).json({ success: false, error: 'Malformed request payload rejected for security.' });
  }
  next();
}

// ==========================================
// 3. CRYPTOGRAPHIC HMAC ADMIN SESSION TOKEN
// ==========================================
function generateAdminSessionToken(clientIp) {
  const payload = {
    iat: Date.now(),
    nonce: crypto.randomBytes(8).toString('hex'),
    ip: clientIp || 'any'
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${hmac}`;
}

function verifyAdminSessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [payloadB64, signature] = parts;
  const expectedHmac = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');

  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expectedHmac, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return false;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    // Enforce 8-hour maximum token lifetime
    if (Date.now() - payload.iat > SESSION_MAX_AGE_MS) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ==========================================
// 4. ADMIN LOGIN BRUTE-FORCE PROTECTION
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

  recordSecurityEvent('FAILED_ADMIN_LOGIN', {
    ip,
    attemptNumber: record.count,
    userAgent: (req.headers['user-agent'] || '').slice(0, 100)
  });

  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    record.lockedUntil = now + LOGIN_LOCKOUT_MS;
    recordSecurityEvent('ADMIN_LOCKOUT_TRIGGERED', { ip, lockedForMinutes: 15 });
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
  bannedIps.delete(ip); // Instantly unban admin IP upon legitimate authentication
  recordSecurityEvent('SUCCESSFUL_ADMIN_LOGIN', {
    ip,
    userAgent: (req.headers['user-agent'] || '').slice(0, 100)
  });
}

// ==========================================
// 4.1 TWO-FACTOR AUTHENTICATION (2FA TOTP & RATE LIMITING)
// ==========================================

/**
 * Generate a new random Base32 TOTP secret key for Google Authenticator
 */
function generateTotpSecret() {
  return generateSecret();
}

/**
 * Build standard otpauth:// URI for QR code generation
 */
function generateTotpUri(secret, accountName = 'admin', issuer = 'Snack by Maew Admin') {
  return generateURI({
    secret,
    label: accountName,
    issuer
  });
}

/**
 * Verify a 6-digit TOTP code against secret with +/- 90s clock drift tolerance
 */
function verifyTotpCode(code, secret) {
  if (!code || !secret) return false;
  const token = String(code).replace(/\D/g, '').trim();
  if (token.length !== 6) return false;
  try {
    const res = verifySync({
      token,
      secret: String(secret).trim(),
      epochTolerance: 90
    });
    return !!(res && res.valid === true);
  } catch (err) {
    console.error('TOTP verification error:', err);
    return false;
  }
}

/**
 * Generate a signed temporary 2FA exchange token after Step 1 PIN verification
 * Valid for 5 minutes only. Cryptographically tied to client IP and SESSION_SECRET.
 */
function generateTemp2FAToken(clientIp = '127.0.0.1') {
  const payload = JSON.stringify({
    ip: clientIp,
    purpose: '2fa_login',
    exp: Date.now() + 5 * 60 * 1000 // 5 minutes validity
  });
  const b64 = Buffer.from(payload, 'utf8').toString('base64url');
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  return `${b64}.${hmac}`;
}

/**
 * Verify signed temporary 2FA exchange token
 */
function verifyTemp2FAToken(token, clientIp = null) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [b64, signature] = parts;
  const expectedHmac = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  if (signature.length !== expectedHmac.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedHmac))) {
    return false;
  }
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (!payload || payload.purpose !== '2fa_login') return false;
    if (Date.now() > payload.exp) return false;
    if (clientIp && payload.ip && payload.ip !== clientIp) return false;
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Rate limiting check for Step 2 (2FA code verification)
 */
function check2FARateLimit(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  const record = twoFaAttempts.get(ip);
  if (record && record.lockedUntil && now < record.lockedUntil) {
    const remainingMinutes = Math.ceil((record.lockedUntil - now) / 60000);
    return {
      allowed: false,
      error: `🛑 มีการยืนยันรหัส 2FA ผิดเกินกำหนด ระบบระงับการลองชั่วคราวอีก ${remainingMinutes} นาที เพื่อความปลอดภัย`
    };
  }
  return { allowed: true };
}

/**
 * Record a failed 2FA verification attempt
 */
function record2FAFailure(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  const record = twoFaAttempts.get(ip) || { count: 0, lockedUntil: null, lastAttempt: now };
  record.count += 1;
  record.lastAttempt = now;

  recordSecurityEvent('FAILED_2FA_ATTEMPT', {
    ip,
    attemptNumber: record.count
  });

  if (record.count >= MAX_2FA_ATTEMPTS) {
    record.lockedUntil = now + TWO_FA_LOCKOUT_MS;
    recordSecurityEvent('2FA_LOCKOUT_TRIGGERED', { ip, lockedForMinutes: 15 });
    console.warn(`[Security Alert] IP ${ip} exceeded maximum 2FA attempts (${record.count}). Locked for 15 minutes.`);
  }

  twoFaAttempts.set(ip, record);
  return {
    isLocked: !!record.lockedUntil,
    remainingAttempts: Math.max(0, MAX_2FA_ATTEMPTS - record.count)
  };
}

/**
 * Reset 2FA verification attempts on success
 */
function record2FASuccess(req) {
  const ip = getClientIp(req);
  twoFaAttempts.delete(ip);
  recordSecurityEvent('SUCCESSFUL_2FA_VERIFICATION', { ip });
}

// ==========================================
// 5. CONSTANT-TIME TIMING-SAFE COMPARISON & PASSWORD HASHING (SCRYPT + SALT)
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

/**
 * Hash PIN using Scrypt with a random 16-byte salt (OWASP recommended standard)
 * Output format: scrypt$<salt_hex>$<derived_key_hex>
 */
function hashPin(pin) {
  if (!pin || typeof pin !== 'string') return '';
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(pin.trim(), salt, 64);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

/**
 * Verify candidate PIN against stored Scrypt salted hash or legacy plaintext string
 */
function verifyPinHash(candidatePin, storedHashOrPlain) {
  if (!candidatePin || !storedHashOrPlain) return false;
  const cand = String(candidatePin).trim();
  const stored = String(storedHashOrPlain).trim();

  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const [, salt, expectedHex] = parts;
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    const derivedBuf = crypto.scryptSync(cand, salt, expectedBuf.length);
    if (expectedBuf.length !== derivedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, derivedBuf);
  }

  // Backward compatibility fallback: constant-time comparison
  return safeComparePin(cand, stored);
}

// ==========================================
// 6. RATE LIMITING FOR PUBLIC APIs
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
      recordSecurityEvent('RATE_LIMIT_EXCEEDED', { ip, path: req.path, count: record.count });
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

const visitorTrackRateLimit = createRateLimiter(
  visitorTrackLimits,
  VISITOR_TRACK_LIMIT,
  RATE_WINDOW_MS,
  'คำขอส่งข้อมูลสถิติผู้เข้าชมถี่เกินไป กรุณารอสักครู่ครับ'
);

const promptPayQrRateLimit = createRateLimiter(
  promptPayQrLimits,
  PROMPTPAY_QR_LIMIT,
  RATE_WINDOW_MS,
  'คำขอสร้างพร้อมเพย์ QR Code ถี่เกินไป กรุณารอสักครู่ครับ'
);

const orderHistoryRateLimit = createRateLimiter(
  orderHistoryLimits,
  ORDER_HISTORY_LIMIT,
  RATE_WINDOW_MS,
  'คำขอค้นหาประวัติคำสั่งซื้อถี่เกินไป กรุณารอสักครู่ครับ'
);

const publicApiRateLimit = createRateLimiter(
  publicApiLimits,
  PUBLIC_API_LIMIT,
  60 * 1000,
  'คุณส่งคำขอมายังระบบถี่เกินกำหนด กรุณารอสักครู่แล้วลองใหม่อีกครั้งครับ'
);

// ==========================================
// 7. HONEYPOT & BOT ABUSE PREVENTION
// ==========================================
function isHoneypotTriggered(req, fieldName = 'customer_website_hp') {
  if (!req.body || typeof req.body !== 'object') return false;
  const hpVal = req.body[fieldName];
  if (hpVal && String(hpVal).trim().length > 0) {
    recordSecurityEvent('BOT_HONEYPOT_TRAPPED', {
      ip: getClientIp(req),
      fieldName,
      trapValue: String(hpVal).slice(0, 50)
    });
    return true;
  }
  return false;
}

// Bot Detection: Form submitted too quickly after page load (< 1.2s)
function isBotSubmissionSpeed(req, minElapsedMs = 1200) {
  if (!req.body || typeof req.body !== 'object') return false;
  const loadTime = Number(req.body.formLoadTime);
  if (loadTime && !isNaN(loadTime)) {
    const elapsed = Date.now() - loadTime;
    if (elapsed > 0 && elapsed < minElapsedMs) {
      recordSecurityEvent('BOT_RAPID_SUBMISSION', {
        ip: getClientIp(req),
        elapsedMs: elapsed
      });
      return true;
    }
  }
  return false;
}

// ==========================================
// 8. INPUT SANITIZATION & STRICT VALIDATION
// ==========================================
function sanitizeText(input, maxLength = 500) {
  if (!input) return '';
  return String(input)
    .replace(/\0/g, '') // remove null bytes
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // strip invisible control characters
    .replace(/<[^>]*>/g, '') // strip HTML tags
    .replace(/[<>'"]/g, '') // remove script brackets & quotes
    .trim()
    .slice(0, maxLength);
}

function validateCustomerName(name) {
  if (name === null || name === undefined || typeof name !== 'string') {
    return { valid: false, error: 'กรุณากรอกชื่อลูกค้า' };
  }
  const clean = sanitizeText(name, 80);
  if (!clean || clean.length < 1) {
    return { valid: false, error: 'กรุณากรอกชื่อลูกค้า' };
  }
  if (clean.length > 80) {
    return { valid: false, error: 'ชื่อลูกค้าต้องมีความยาวไม่เกิน 80 ตัวอักษร' };
  }
  // Must contain at least one meaningful character (letters, Thai consonants/vowels, numbers)
  if (!/[a-zA-Z0-9\u0E00-\u0E7F]/.test(clean)) {
    return { valid: false, error: 'ชื่อลูกค้าต้องมีตัวอักษรหรือตัวเลขที่ถูกต้อง' };
  }
  return { valid: true, sanitized: clean };
}

function validateCustomerPhone(phone, required = false) {
  if (!phone || typeof phone !== 'string') {
    if (required) return { valid: false, error: 'กรุณากรอกเบอร์โทรศัพท์ติดต่อ' };
    return { valid: true, sanitized: '' };
  }
  const raw = String(phone).trim();
  if (!raw) {
    if (required) return { valid: false, error: 'กรุณากรอกเบอร์โทรศัพท์ติดต่อ' };
    return { valid: true, sanitized: '' };
  }
  const cleanDigits = raw.replace(/[\s\-\(\)\.]/g, '');
  if (!/^\+?[0-9]{8,15}$/.test(cleanDigits)) {
    return { valid: false, error: 'รูปแบบเบอร์โทรศัพท์ไม่ถูกต้อง (กรุณากรอกตัวเลข 8-15 หลัก)' };
  }
  return { valid: true, sanitized: sanitizeText(raw, 30) };
}

function validateCustomerNote(note, maxLength = 300) {
  if (!note || typeof note !== 'string') return '';
  return sanitizeText(note, maxLength);
}

function validateSearchQuery(query, maxLength = 100) {
  if (!query || typeof query !== 'string') return '';
  return sanitizeText(query, maxLength);
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
// 9. HTTP SECURITY HEADERS & CONTENT SECURITY POLICY (CSP)
// ==========================================
const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' blob: https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://*.supabase.co https://rich-2syu.onrender.com https://generativelanguage.googleapis.com",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

function securityHeadersMiddleware(req, res, next) {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Prevent clickjacking by denying iframing on foreign domains
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Enable XSS auditor
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Control referrer information leakage
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Content Security Policy
  res.setHeader('Content-Security-Policy', CSP_HEADER);
  // Cross-Origin Resource Policy
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  // Restrict unused browser features
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Enforce HTTPS HSTS when behind SSL proxy
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

// ==========================================
// 10. SAFE FILE UPLOAD FILTER
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

// ==========================================
// 11. IN-FLIGHT SLIP MUTEX (ANTI-RACE CONDITION / ANTI-DOUBLE SPENDING)
// Prevents concurrent requests with identical slip/QR from being submitted simultaneously
// ==========================================
const inFlightSlips = new Map(); // slipKey -> timestamp

function acquireSlipLock(key, ttlMs = 30000) {
  if (!key) return true;
  const cleanKey = String(key).trim().toLowerCase();
  if (!cleanKey) return true;

  const now = Date.now();
  const existing = inFlightSlips.get(cleanKey);
  if (existing && now - existing < ttlMs) {
    recordSecurityEvent('RACE_CONDITION_LOCK_HIT', { lockKey: cleanKey.slice(0, 32) });
    return false; // Already locked by another concurrent in-flight request
  }

  inFlightSlips.set(cleanKey, now);
  return true;
}

function releaseSlipLock(key) {
  if (!key) return;
  const cleanKey = String(key).trim().toLowerCase();
  inFlightSlips.delete(cleanKey);
}

// Periodic cleanup of expired locks (every 1 minute)
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of inFlightSlips.entries()) {
    if (now - timestamp > 60000) inFlightSlips.delete(key);
  }
}, 60000).unref();

// ==========================================
// 12. CRYPTOGRAPHIC SLIP VERIFICATION TOKEN
// Digitally signs AI/QR slip verification results to prevent client parameter tampering/forgery
// ==========================================
function generateSlipVerificationToken({ fileHash, qrData, detectedAmount, slipFilename, isDateToday }) {
  const payload = {
    fileHash: fileHash || '',
    qrData: qrData || '',
    detectedAmount: (detectedAmount !== null && detectedAmount !== undefined) ? Number(detectedAmount) : null,
    slipFilename: slipFilename || '',
    isDateToday: isDateToday !== false,
    iat: Date.now()
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${hmac}`;
}

function verifySlipVerificationToken(token, expectedAmount = null) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadB64, signature] = parts;
  const expectedHmac = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');

  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expectedHmac, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    // Token valid for 15 minutes max
    if (Date.now() - payload.iat > 15 * 60 * 1000) {
      return null;
    }
    // Amount matching check (tolerance 0.05 THB; paying more or equal is valid)
    if (expectedAmount !== null && payload.detectedAmount !== null && payload.detectedAmount !== undefined) {
      if (Number(payload.detectedAmount) < Number(expectedAmount) - 0.05) {
        return null;
      }
    }
    return payload;
  } catch {
    return null;
  }
}

// ==========================================
// 13. IDOR & CUSTOMER PRIVACY PROTECTION
// Masks sensitive personal data and strips internal profit/wholesale costs for public requests
// ==========================================
function maskPhoneNumber(phone) {
  if (!phone) return '';
  const str = String(phone).trim();
  const digits = str.replace(/\D/g, '');
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-***-${digits.slice(-4)}`;
  } else if (digits.length === 9) {
    return `${digits.slice(0, 2)}-***-${digits.slice(-4)}`;
  } else if (str.length >= 6) {
    return `${str.slice(0, 2)}****${str.slice(-2)}`;
  }
  return str;
}

function sanitizeOrderForCustomer(order) {
  if (!order || typeof order !== 'object') return null;
  const { totalCost, totalProfit, profitMargin, ...safeOrder } = order;
  if (Array.isArray(safeOrder.items)) {
    safeOrder.items = safeOrder.items.map(({ cost, totalCost, profit, ...it }) => it);
  }
  if (safeOrder.customerPhone) {
    safeOrder.customerPhone = maskPhoneNumber(safeOrder.customerPhone);
  }
  return safeOrder;
}

// ==========================================
// 14. COOKIE PARSER MIDDLEWARE (ZERO DEPENDENCIES)
// ==========================================
function cookieParserMiddleware(req, res, next) {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const pairs = cookieHeader.split(';');
    for (const pair of pairs) {
      const idx = pair.indexOf('=');
      if (idx !== -1) {
        const key = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        try {
          req.cookies[key] = decodeURIComponent(val);
        } catch {
          req.cookies[key] = val;
        }
      }
    }
  }
  next();
}

// ==========================================
// 15. STRICT CORS CONFIGURATION (NO WILDCARD WITH CREDENTIALS)
// ==========================================
function getCorsOptions() {
  const customOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  const renderExternal = process.env.RENDER_EXTERNAL_URL ? process.env.RENDER_EXTERNAL_URL.trim() : null;

  return {
    origin: function (origin, callback) {
      // Allow requests with no origin (e.g. mobile native app, server-to-server, curl, same-origin)
      if (!origin) return callback(null, true);

      // Local development origins
      if (/^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }

      // Render deployment domains
      if (/^https:\/\/([a-zA-Z0-9-]+\.)*onrender\.com$/.test(origin)) {
        return callback(null, true);
      }

      if (renderExternal && origin === renderExternal) {
        return callback(null, true);
      }

      if (customOrigins.includes(origin)) {
        return callback(null, true);
      }

      const err = new Error('คำขอถูกระงับโดยนโยบายความปลอดภัย CORS (Origin ไม่อยู่ในรายการที่อนุญาต)');
      err.status = 403;
      return callback(err);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token', 'X-Device-Id', 'X-Order-Ids', 'Cache-Control', 'Pragma']
  };
}

// ==========================================
// 16. IDOR (INSECURE DIRECT OBJECT REFERENCE) ACCESS CHECK
// Ensures regular customer can only view or interact with their own device orders
// ==========================================
function canAccessOrder(order, req) {
  if (!order) return { allowed: false, isAdmin: false };

  // 1. Admin session check (via HttpOnly cookie or Authorization header)
  const tokenFromCookie = req.cookies && req.cookies.snack_admin_session;
  const authHeader = req.headers.authorization;
  const tokenFromHeader = (authHeader && authHeader.startsWith('Bearer '))
    ? authHeader.slice(7).trim()
    : req.headers['x-admin-token'];

  if ((tokenFromCookie && verifyAdminSessionToken(tokenFromCookie)) ||
      (tokenFromHeader && verifyAdminSessionToken(tokenFromHeader))) {
    return { allowed: true, isAdmin: true };
  }

  // 2. Customer device matching (Strict device ID check)
  const clientDeviceId = (req.headers['x-device-id'] || (req.cookies && req.cookies.snack_maew_device_id) || req.query.deviceId || '').trim();
  if (order.deviceId && clientDeviceId && order.deviceId === clientDeviceId) {
    return { allowed: true, isAdmin: false };
  }

  // 3. Customer order list matching (Order IDs verified on this device)
  const rawIds = req.headers['x-order-ids'] || req.query.clientOrderIds || '';
  const clientOrderIds = rawIds.split(',').map(s => s.trim()).filter(Boolean);
  if (clientOrderIds.includes(order.id)) {
    return { allowed: true, isAdmin: false };
  }

  return { allowed: false, isAdmin: false };
}

// ==========================================
// 17. STATIC ASSET PROTECTION & SOURCE MAP SHIELD
// Blocks requests for .map source maps, configuration files, and backup files
// ==========================================
function protectStaticFilesMiddleware(req, res, next) {
  const rawPath = (req.path || '').toLowerCase();

  // 1. Block Source Maps (.map) - Prevent leakage of original client source codes / maps
  if (/\.map$/i.test(rawPath)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.status(404).json({ success: false, error: 'File not found' });
  }

  // 2. Block sensitive file extensions (except allowed public manifests)
  if (/\.(json|yml|yaml|toml|sql|db|sqlite|log|bak|backup|old|swp|md|env|git|sh|bat|cmd|ps1|ts|tsx|vue|php)$/i.test(rawPath)) {
    const filename = path.basename(rawPath);
    if (filename !== 'manifest.json' && filename !== 'admin-manifest.json') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      return res.status(404).json({ success: false, error: 'File not found' });
    }
  }

  // 3. Block dotfiles / hidden paths (e.g. /.env, /.git, /.ds_store)
  if (/(^|\/)\.[^\/]/i.test(rawPath)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.status(404).json({ success: false, error: 'File not found' });
  }

  // 4. Block direct requests for admin.html or private files via static hosting
  if (rawPath === '/admin.html' || rawPath.startsWith('/private/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.status(404).json({ success: false, error: 'File not found' });
  }

  // 5. Block path traversal attempts
  if (/\.\.|\%2e\%2e/i.test(rawPath)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }

  next();
}

// ==========================================
// 18. ADMIN ACCESS CONTROL MIDDLEWARES
// ==========================================

// Middleware for Admin API endpoints under /api/admin
function verifyAdminSessionMiddleware(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // Allow public login and 2FA authentication endpoints to proceed without prior session
  if (
    req.path === '/login' ||
    req.path === '/api/admin/login' ||
    req.path === '/login/verify-2fa' ||
    req.path === '/api/admin/login/verify-2fa'
  ) {
    return next();
  }

  // 1. Verify Session Token from HttpOnly Cookie
  const cookieToken = req.cookies && req.cookies.snack_admin_session;
  if (cookieToken && verifyAdminSessionToken(cookieToken)) {
    return next();
  }

  // 2. Fallback to Authorization Header (Bearer token)
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

// Middleware for Admin Web Pages (/admin)
function requireAdminWebAuth(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const cookieToken = req.cookies && req.cookies.snack_admin_session;
  if (cookieToken && verifyAdminSessionToken(cookieToken)) {
    return next();
  }
  return res.redirect('/admin/login');
}

module.exports = {
  getClientIp,
  intrusionDetectionMiddleware,
  prototypePollutionGuard,
  generateAdminSessionToken,
  verifyAdminSessionToken,
  checkLoginRateLimit,
  recordLoginFailure,
  recordLoginSuccess,
  safeComparePin,
  hashPin,
  verifyPinHash,
  cookieParserMiddleware,
  getCorsOptions,
  canAccessOrder,
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
  sanitizeOrderInput,
  securityHeadersMiddleware,
  protectStaticFilesMiddleware,
  verifyAdminSessionMiddleware,
  requireAdminWebAuth,
  slipFileFilter,
  getSecurityAuditLogs,
  bannedIps,
  acquireSlipLock,
  releaseSlipLock,
  generateSlipVerificationToken,
  verifySlipVerificationToken,
  maskPhoneNumber,
  sanitizeOrderForCustomer,
  generateTotpSecret,
  generateTotpUri,
  verifyTotpCode,
  generateTemp2FAToken,
  verifyTemp2FAToken,
  check2FARateLimit,
  record2FAFailure,
  record2FASuccess
};

