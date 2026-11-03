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
  protectStaticFilesMiddleware
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
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Security 6: Prototype Pollution Guard
app.use(prototypePollutionGuard);

// Security: Block sensitive file extensions (.map, .env, .json, .bak) before static handler
app.use(protectStaticFilesMiddleware);

// Serve Admin Portal on root with strict no-cache
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/admin', (req, res) => {
  res.redirect('/');
});
app.get('/index.html', (req, res) => {
  res.redirect('/');
});

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

// Mount Admin APIs
app.use(adminRouter);

// Centralized Production Error Handler (Prevents stack trace & internal path leaks)
app.use((err, req, res, next) => {
  console.error(`[Admin Server Error] ${req.method} ${req.originalUrl}:`, err.message || err);
  if (res.headersSent) return next(err);

  const status = err.status || err.statusCode || 500;
  const isClientError = status >= 400 && status < 500;

  res.status(status).json({
    success: false,
    error: isClientError ? (err.message || 'คำขอไม่ถูกต้อง') : 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง'
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
