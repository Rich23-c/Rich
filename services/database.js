const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SNACKS_FILE = path.join(DATA_DIR, 'snacks.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function readJson(file, defaultValue = []) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(defaultValue, null, 2), 'utf8');
      return defaultValue;
    }
    const data = fs.readFileSync(file, 'utf8');
    return JSON.parse(data || JSON.stringify(defaultValue));
  } catch (err) {
    console.error(`Error reading ${file}:`, err);
    return defaultValue;
  }
}

function writeJson(file, data) {
  try {
    const tempFile = `${file}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempFile, file);
    return true;
  } catch (err) {
    console.error(`Error writing ${file}:`, err);
    return false;
  }
}

// Snacks API
function getSnacks(includeUnavailable = false) {
  const snacks = readJson(SNACKS_FILE, []);
  if (includeUnavailable) return snacks;
  return snacks.filter(s => s.isAvailable !== false);
}

function getSnackById(id) {
  const snacks = readJson(SNACKS_FILE, []);
  return snacks.find(s => s.id === id);
}

function saveSnack(snackData) {
  const snacks = readJson(SNACKS_FILE, []);
  const newSnack = {
    id: 'snack-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
    name: snackData.name?.trim() || 'ขนมไม่มีชื่อ',
    price: Number(snackData.price) || 0,
    cost: Number(snackData.cost) >= 0 ? Number(snackData.cost) : 0,
    unit: snackData.unit?.trim() || 'ชิ้น',
    description: snackData.description?.trim() || '',
    image: snackData.image?.trim() || '',
    isAvailable: snackData.isAvailable !== false,
    createdAt: new Date().toISOString()
  };
  snacks.push(newSnack);
  writeJson(SNACKS_FILE, snacks);
  return newSnack;
}

function updateSnack(id, updates) {
  const snacks = readJson(SNACKS_FILE, []);
  const index = snacks.findIndex(s => s.id === id);
  if (index === -1) return null;

  snacks[index] = {
    ...snacks[index],
    ...updates,
    price: updates.price !== undefined ? Number(updates.price) : snacks[index].price,
    cost: updates.cost !== undefined ? (Number(updates.cost) >= 0 ? Number(updates.cost) : 0) : (snacks[index].cost || 0),
    updatedAt: new Date().toISOString()
  };
  writeJson(SNACKS_FILE, snacks);
  return snacks[index];
}

function deleteSnack(id) {
  const snacks = readJson(SNACKS_FILE, []);
  const filtered = snacks.filter(s => s.id !== id);
  if (filtered.length === snacks.length) return false;
  writeJson(SNACKS_FILE, filtered);
  return true;
}

function reorderSnacks(orderedIds) {
  if (!Array.isArray(orderedIds)) return false;
  const snacks = readJson(SNACKS_FILE, []);
  const snackMap = new Map();
  snacks.forEach(s => snackMap.set(s.id, s));

  const reordered = [];
  orderedIds.forEach(id => {
    if (snackMap.has(id)) {
      reordered.push(snackMap.get(id));
      snackMap.delete(id);
    }
  });

  // Keep any remaining snacks not present in orderedIds
  snackMap.forEach(s => reordered.push(s));

  writeJson(SNACKS_FILE, reordered);
  return reordered;
}

// Orders API
function getOrders() {
  const orders = readJson(ORDERS_FILE, []);
  // Return newest first
  return orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getOrderById(id) {
  const orders = readJson(ORDERS_FILE, []);
  return orders.find(o => o.id === id);
}

function createOrder(orderData) {
  const orders = readJson(ORDERS_FILE, []);
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const randStr = Math.random().toString(36).substring(2, 6).toUpperCase();
  const orderId = `MW-${dateStr}-${randStr}`;

  const newOrder = {
    id: orderId,
    customerName: orderData.customerName?.trim() || 'ไม่ระบุชื่อ',
    customerPhone: orderData.customerPhone?.trim() || '',
    customerEmail: orderData.customerEmail?.trim() || '',
    customerAddress: orderData.customerAddress?.trim() || '',
    customerNote: orderData.customerNote?.trim() || '',
    items: orderData.items || [],
    totalPrice: Number(orderData.totalPrice) || 0,
    totalCost: Number(orderData.totalCost) || 0,
    totalProfit: Number(orderData.totalProfit) || 0,
    profitMargin: Number(orderData.profitMargin) || 0,
    slipImage: orderData.slipImage || null,
    slipVerification: orderData.slipVerification || null,
    orderStatus: orderData.orderStatus || 'pending', // pending, verified, preparing, prepared, delivered, cancelled
    adminNotes: '',
    createdAt: now.toISOString()
  };

  orders.unshift(newOrder);
  writeJson(ORDERS_FILE, orders);
  return newOrder;
}

function updateOrderStatus(id, status, adminNotes = null) {
  const orders = readJson(ORDERS_FILE, []);
  const index = orders.findIndex(o => o.id === id);
  if (index === -1) return null;

  orders[index].orderStatus = status;
  if (adminNotes !== null) {
    orders[index].adminNotes = adminNotes;
  }
  orders[index].updatedAt = new Date().toISOString();

  writeJson(ORDERS_FILE, orders);
  return orders[index];
}

// Find orders by query, phone, name, or IDs
function findOrders({ query, phone, name, ids } = {}) {
  const allOrders = getOrders();
  if (ids && Array.isArray(ids) && ids.length > 0) {
    const idSet = new Set(ids);
    return allOrders.filter(o => idSet.has(o.id));
  }

  if (query) {
    const q = query.trim().toLowerCase();
    const cleanQPhone = q.replace(/[\s\-]/g, '');
    return allOrders.filter(o => {
      if (o.id && o.id.toLowerCase().includes(q)) return true;
      if (o.customerName && o.customerName.toLowerCase().includes(q)) return true;
      if (cleanQPhone.length >= 3) {
        const orderPhone = (o.customerPhone || '').replace(/[\s\-]/g, '');
        if (orderPhone.includes(cleanQPhone)) return true;
      }
      return false;
    });
  }

  if (phone) {
    const cleanPhone = phone.replace(/[\s\-]/g, '');
    return allOrders.filter(o => {
      const orderPhone = (o.customerPhone || '').replace(/[\s\-]/g, '');
      return orderPhone.length >= 3 && orderPhone.includes(cleanPhone);
    });
  }

  if (name) {
    const cleanName = name.trim().toLowerCase();
    return allOrders.filter(o => (o.customerName || '').toLowerCase().includes(cleanName));
  }

  return [];
}

// Reset Mock/Test Orders
function resetOrders() {
  writeJson(ORDERS_FILE, []);
  const slipsDir = path.join(__dirname, '..', 'uploads', 'slips');
  if (fs.existsSync(slipsDir)) {
    try {
      const files = fs.readdirSync(slipsDir);
      for (const f of files) {
        fs.unlinkSync(path.join(slipsDir, f));
      }
    } catch (e) {
      console.warn('Error clearing slips folder:', e.message);
    }
  }
  return true;
}

// Settings API
function getSettings() {
  return readJson(SETTINGS_FILE, {
    shopName: "ร้านขนมแม้ว 🐾 (Snack by Maew)",
    shopSubtitle: "ขนมโฮมเมด สดใหม่จากเตาทุกวัน หอม อร่อย วัตถุดิบพรีเมียม",
    promptpayId: "0891234567",
    promptpayName: "ร้านขนมแม้ว",
    bankName: "ธนาคารกสิกรไทย",
    bankAccountNumber: "089-1-23456-7",
    adminPin: "411197",
    isOpen: true,
    openStartDate: "2026-10-04",
    openEndDate: "2026-10-10",
    openScheduleText: "รอบนี้เปิดรับออเดอร์ วันที่ 4 ต.ค. - 10 ต.ค. 2569",
    closedMessage: "ขณะนี้ร้านแม้วปิดรับออเดอร์ชั่วคราว แล้วพบกันใหม่รอบหน้านะจ๊ะ 🐱",
    emailReceiver: "",
    emailSender: "",
    emailAppPassword: "",
    lineChannelAccessToken: "",
    lineTargetId: ""
  });
}

function updateSettings(updates) {
  const current = getSettings();
  const updated = { ...current, ...updates };
  writeJson(SETTINGS_FILE, updated);
  return updated;
}

function verifyAdminPin(pin) {
  const settings = getSettings();
  return String(settings.adminPin || '411197') === String(pin).trim();
}

module.exports = {
  getSnacks,
  getSnackById,
  saveSnack,
  updateSnack,
  deleteSnack,
  reorderSnacks,
  getOrders,
  getOrderById,
  findOrders,
  createOrder,
  updateOrderStatus,
  resetOrders,
  getSettings,
  updateSettings,
  verifyAdminPin
};
