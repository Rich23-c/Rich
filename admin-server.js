require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');

const adminRouter = require('./admin-router');

const app = express();
const PORT = process.env.ADMIN_PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve Admin Portal on root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/admin', (req, res) => {
  res.redirect('/');
});
app.get('/index.html', (req, res) => {
  res.redirect('/');
});

// Serve static assets (CSS, JS, images) without defaulting to index.html
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
const { resolveSlipImage } = require('./services/slipImageService');
const db = require('./services/database');

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

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Mount Admin APIs
app.use(adminRouter);

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
  console.log(`🔑 รหัส PIN แอดมิน: 411197`);
  console.log(`====================================================`);
});
