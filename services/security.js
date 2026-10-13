const crypto = require('crypto');

// ==========================================
// 🛡️ SECURITY FORTRESS MODULE (ENTERPRISE GRADE)
// ==========================================

// Memory Stores
const loginAttempts = new Map();       // ip -> { count: number, lockedUntil: number, lastAttempt: number }
const slipVerifyLimits = new Map();    // ip -> { count: number, resetAt: number }
const orderCreateLimits = new Map();   // ip -> { count: number, resetAt: number }
const bannedIps = new Map();           // ip -> unbanTimestamp (24-hour malicious bot blacklist)
const securityAuditLogs = [];          // Circular buffer: last 50 security events

// Cryptographic Session Secret (Generated fresh on boot if not set in environment)
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours valid session

// Configuration Constants
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;      // Lock for 15 minutes after 5 failed attempts
const LOGIN_ARTIFICIAL_DELAY_MS = 600;        // 600ms slow-down against high-speed bot cracking
const BAN_DURATION_MS = 24 * 60 * 60 * 1000;  // 24 hours auto-ban for active attack attempts

const SLIP_VERIFY_LIMIT = 20;   // 20 verifications per 5 minutes per IP
const ORDER_CREATE_LIMIT = 25;  // 25 orders per 5 minutes per IP
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
  for (const [ip, unbanTime] of bannedIps.entries()) {
    if (now > unbanTime) bannedIps.delete(ip);
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
  const isAuthRoute = req.path === '/api/admin/login' || req.path === '/admin';
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
// 5. CONSTANT-TIME TIMING-SAFE COMPARISON
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

// ==========================================
// 7. HONEYPOT ANTI-SPAM BOT CHECK
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

// ==========================================
// 8. XSS INPUT SANITIZATION
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
// 9. HTTP SECURITY HEADERS & CONTENT SECURITY POLICY (CSP)
// ==========================================
const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://*.supabase.co https://rich-2syu.onrender.com https://generativelanguage.googleapis.com",
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
  slipVerifyRateLimit,
  orderCreateRateLimit,
  isHoneypotTriggered,
  sanitizeText,
  sanitizeOrderInput,
  securityHeadersMiddleware,
  slipFileFilter,
  getSecurityAuditLogs,
  bannedIps
};
