require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');

const adminRouter = require('./admin-router');
const {
  securityHeadersMiddleware,
  intrusionDetectionMiddleware,
  prototypePollutionGuard,
  cookieParserMiddleware,
  getCorsOptions,
  protectStaticFilesMiddleware,
  verifyAdminSessionMiddleware,
  requireAdminWebAuth,
  verifyAdminSessionToken
} = require('./services/security');
const { resolveSlipImage } = require('./services/slipImageService');
const db = require('./services/database');

const app = express();
const PORT = process.env.ADMIN_PORT || 3001;

// Security 1: Disable Express fingerprinting
app.disable('x-powered-by');

// Security 2: Intrusion Detection System
app.use(intrusionDetectionMiddleware);

// Security 3: Enforce strict HTTP security headers & CSP
app.use(securityHeadersMiddleware);

// Security 4: Cookie Parser (HttpOnly Admin Session Cookie)
app.use(cookieParserMiddleware);

// Security 5: Strict CORS Configuration
app.use(cors(getCorsOptions()));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Security 6: Prototype Pollution Guard
app.use(prototypePollutionGuard);

// Security: Block sensitive file extensions (.map, .env, .json, .bak) before static handler
app.use(protectStaticFilesMiddleware);

// Serve Admin Portal on root with strict authentication check
app.get('/', requireAdminWebAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'private', 'admin.html'));
});
app.get('/admin', (req, res) => res.redirect('/'));
app.get('/admin/login', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const cookieToken = req.cookies && req.cookies.snack_admin_session;
  if (cookieToken && verifyAdminSessionToken(cookieToken)) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'private', 'admin-login.html'));
});
app.get('/login', (req, res) => res.redirect('/admin/login'));
app.get('/index.html', (req, res) => res.redirect('/'));
app.get('/admin.html', (req, res) => res.redirect('/'));

// Serve static assets (CSS, JS, images) with denied dotfiles
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  dotfiles: 'deny',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

// Smart Self-Healing Slip Image Endpoint (Survives Cloud Container Restarts)
app.get('/uploads/slips/:filename', (req, res, next) => {
  const filename = path.basename(req.params.filename);
  const resolved = resolveSlipImage(filename, db.getOrders());
  if (resolved) {
    if (resolved.type === 'file') {
      return res.sendFile(resolved.filePath);
    } else if (resolved.type === 'buffer') {
      res.setHeader('Content-Type', resolved.contentType);
      return res.send(resolved.buffer);
    } else if (resolved.type === 'svg') {
      res.setHeader('Content-Type', resolved.contentType);
      return res.send(resolved.svg);
    }
  }
  next();
});

app.use('/uploads', (req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}, express.static(path.join(__dirname, 'uploads'), { dotfiles: 'deny' }));

// Mount Admin APIs with prefix and auth middleware
app.use('/api/admin', verifyAdminSessionMiddleware, adminRouter);
app.use(adminRouter);

// 404 Not Found Handler
app.use((req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  if (req.path.startsWith('/api/') || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.status(404).json({
      success: false,
      error: 'ไม่พบเส้นทาง API ที่เรียกใช้งาน (Endpoint Not Found)'
    });
  }
  return res.status(404).redirect('/');
});

// Centralized Global Error Handler
app.use((err, req, res, next) => {
  const errMessage = err ? (err.message || String(err)) : 'Unknown Error';
  console.error(`[Admin Server Error] ${req.method} ${req.originalUrl || req.url}:`, errMessage);

  if (res.headersSent) return next(err);

  if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE' || err.status === 413) {
    return res.status(413).json({
      success: false,
      error: 'ขนาดข้อมูลหรือไฟล์ที่ส่งมามีขนาดใหญ่เกินกำหนด (Payload / File Too Large)'
    });
  }

  if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.name === 'MulterError') {
    return res.status(400).json({
      success: false,
      error: 'รูปแบบหรือฟิลด์ไฟล์ที่แนบมาไม่ถูกต้อง'
    });
  }

  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      success: false,
      error: 'รูปแบบข้อมูล JSON ที่ส่งมาไม่ถูกต้อง (Malformed JSON Payload)'
    });
  }

  const statusCode = (typeof err.status === 'number' && err.status >= 400 && err.status < 600)
    ? err.status
    : ((typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600) ? err.statusCode : 500);

  const clientMessage = (statusCode >= 400 && statusCode < 500 && err.message)
    ? err.message
    : 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง';

  return res.status(statusCode).json({
    success: false,
    error: clientMessage
  });
});

// Start Admin Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🔐 [เว็บหลังบ้าน Admin] ระบบจัดการร้านขนมแม้ว พร้อมใช้งาน!`);
  console.log(`🌐 เข้าจัดการหลังบ้าน: http://localhost:${PORT}`);
  const networkInterfaces = os.networkInterfaces();
  Object.keys(networkInterfaces).forEach(netName => {
    networkInterfaces[netName].forEach(net => {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`📱 เข้าจากมือถือในบ้าน: http://${net.address}:${PORT}`);
      }
    });
  });
  console.log(`====================================================`);
});
