require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');

// If running on Cloud (Render, Railway, Heroku, etc.), run single all-in-one server
if (process.env.PORT && !process.env.CUSTOMER_PORT) {
  require('./customer-server');
  return;
}

console.log(`====================================================`);
console.log(`🐾 กำลังเริ่มต้นเปิดระบบร้านขนมแม้ว (แยก 2 เว็บอิสระ)...`);
console.log(`====================================================\n`);

// 1. Start Customer Web Server on Port 3000
const customerProcess = spawn('node', [path.join(__dirname, 'customer-server.js')], {
  stdio: 'inherit',
  env: { ...process.env, CUSTOMER_PORT: '3000' }
});

// 2. Start Admin Web Server on Port 3001
const adminProcess = spawn('node', [path.join(__dirname, 'admin-server.js')], {
  stdio: 'inherit',
  env: { ...process.env, ADMIN_PORT: '3001' }
});

// Handle termination cleanly
process.on('SIGINT', () => {
  customerProcess.kill();
  adminProcess.kill();
  process.exit();
});

process.on('SIGTERM', () => {
  customerProcess.kill();
  adminProcess.kill();
  process.exit();
});
