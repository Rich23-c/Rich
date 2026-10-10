const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SNACKS_FILE = path.join(DATA_DIR, 'snacks.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const USED_SLIPS_FILE = path.join(DATA_DIR, 'used_slips.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-Memory High-Speed Cache (Reads execute in < 0.1ms without disk I/O bottleneck)
let memoryCache = {
  snacks: null,
  orders: null,
  settings: null,
  usedSlips: null, // Permanent slip memory registry (never wiped on order reset)
  isSupabaseActive: false,
  lastSyncTime: null,
  syncError: null
};

// ==========================================
// LOCAL JSON FILE SYSTEM (Fallback & Offline Storage)
// ==========================================
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

// Initialize memory cache from local disk on boot
function initLocalCache() {
  if (!memoryCache.snacks) {
    memoryCache.snacks = readJson(SNACKS_FILE, []);
  }
  if (!memoryCache.orders) {
    memoryCache.orders = readJson(ORDERS_FILE, []);
  }
  if (!memoryCache.settings) {
    memoryCache.settings = readJson(SETTINGS_FILE, getDefaultSettings());
  }
  if (!memoryCache.usedSlips) {
    memoryCache.usedSlips = readJson(USED_SLIPS_FILE, []);
    // Auto-migrate any historical slips from orders into usedSlips registry
    const existingOrders = memoryCache.orders || [];
    let migrated = false;
    existingOrders.forEach(order => {
      const v = order.slipVerification || {};
      const qrData = (order.qrData || v.qrData || v.rawQrData || '').trim();
      const transactionRef = (order.transactionRef || v.transactionRef || '').trim();
      const fileHash = (order.fileHash || v.fileHash || '').trim();
      if (qrData || transactionRef || fileHash) {
        const alreadyInRegistry = memoryCache.usedSlips.some(s =>
          (qrData && s.qrData === qrData) ||
          (transactionRef && s.transactionRef === transactionRef) ||
          (fileHash && s.fileHash === fileHash)
        );
        if (!alreadyInRegistry) {
          memoryCache.usedSlips.push({
            qrData,
            transactionRef,
            fileHash,
            orderId: order.id,
            usedAt: order.createdAt || new Date().toISOString()
          });
          migrated = true;
        }
      }
    });
    if (migrated) {
      writeJson(USED_SLIPS_FILE, memoryCache.usedSlips);
    }
  }
}

function getDefaultSettings() {
  return {
    shopName: "ร้านขนมแม้ว 🐾 (Snack by Maew)",
    shopSubtitle: "ของหวาน ของอร่อย เมืองเพชรบุรี",
    promptpayId: "140540",
    promptpayName: "พัชญ์ชามญชุ์ กฤติณัฐธนชัย",
    bankName: "Thai QR Payment (พร้อมเพย์)",
    bankAccountNumber: "สแกน Thai QR พร้อมเพย์",
    promptpayQrImage: "/images/shop-qr.png",
    adminPin: "411197",
    isOpen: true,
    closedMessage: "ขณะนี้ร้านแม้วปิดรับออเดอร์ชั่วคราว แล้วพบกันใหม่รอบหน้านะจ๊ะ 🐱"
  };
}

initLocalCache();

let rawSupabaseUrl = process.env.SUPABASE_URL;
let supabaseUrl = rawSupabaseUrl ? rawSupabaseUrl.trim().replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '') : null;
const supabaseKey = (process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

let supabase = null;

if (supabaseUrl && supabaseKey) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false }
    });
    console.log('⚡ [Cloud Database] Initializing Supabase Cloud Adapter with URL:', supabaseUrl);
    initSupabaseSync();
  } catch (e) {
    console.warn('⚠️ [Cloud Database] Failed to initialize Supabase client:', e.message);
  }
} else {
  console.log('📁 [Database] Running in Local High-Speed JSON Mode (No SUPABASE_URL configured).');
}

async function initSupabaseSync() {
  if (!supabase) return;
  try {
    // 1. Sync Settings
    const { data: settingsData, error: settingsErr } = await supabase
      .from('settings')
      .select('*')
      .eq('id', 'current')
      .single();

    if (!settingsErr && settingsData && settingsData.data) {
      memoryCache.settings = { ...memoryCache.settings, ...settingsData.data };
      writeJson(SETTINGS_FILE, memoryCache.settings);
    } else if (settingsErr && settingsErr.code === 'PGRST116') {
      // Row doesn't exist yet -> seed local settings to cloud
      await supabase.from('settings').upsert({ id: 'current', data: memoryCache.settings });
    }

    // 2. Sync Snacks
    const { data: snacksData, error: snacksErr } = await supabase
      .from('snacks')
      .select('*')
      .order('sortOrder', { ascending: true });

    if (!snacksErr && snacksData && snacksData.length > 0) {
      memoryCache.snacks = snacksData.map(s => ({
        id: s.id,
        name: s.name,
        price: Number(s.price),
        cost: Number(s.cost || 0),
        unit: s.unit || 'ชิ้น',
        description: s.description || '',
        image: s.image || '',
        isAvailable: s.isAvailable !== false,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt
      }));
      writeJson(SNACKS_FILE, memoryCache.snacks);
    } else if (!snacksErr && (!snacksData || snacksData.length === 0) && memoryCache.snacks.length > 0) {
      // Seed local snacks to Supabase cloud
      const seeds = memoryCache.snacks.map((s, idx) => ({
        id: s.id,
        name: s.name,
        price: s.price,
        cost: s.cost || 0,
        unit: s.unit || 'ชิ้น',
        description: s.description || '',
        image: s.image || '',
        isAvailable: s.isAvailable !== false,
        sortOrder: idx,
        createdAt: s.createdAt || new Date().toISOString()
      }));
      await supabase.from('snacks').upsert(seeds);
    }

    // 3. Sync Orders
    const { data: ordersData, error: ordersErr } = await supabase
      .from('orders')
      .select('*')
      .order('createdAt', { ascending: false });

    if (!ordersErr && ordersData && ordersData.length > 0) {
      memoryCache.orders = ordersData.map(o => ({
        ...o,
        deviceModel: o.deviceModel || (o.slipVerification && o.slipVerification.deviceModel) || 'ไม่ระบุรุ่น',
        deviceInfo: o.deviceInfo || (o.slipVerification && o.slipVerification.deviceInfo) || null
      }));
      writeJson(ORDERS_FILE, memoryCache.orders);
    } else if (!ordersErr && (!ordersData || ordersData.length === 0) && memoryCache.orders.length > 0) {
      // Seed local orders to Supabase cloud
      const sanitizedSeeds = memoryCache.orders.map(({ slipBase64, deviceInfo, deviceModel, ...rest }) => rest);
      await supabase.from('orders').upsert(sanitizedSeeds);
    }

    // 4. Sync Permanent Used Slips Memory Registry (Retained forever across order resets)
    try {
      const { data: usedSlipsRow, error: usedSlipsErr } = await supabase
        .from('settings')
        .select('*')
        .eq('id', 'used_slips_registry')
        .single();

      if (!usedSlipsErr && usedSlipsRow && Array.isArray(usedSlipsRow.data)) {
        const mergedMap = new Map();
        (usedSlipsRow.data || []).forEach(s => {
          const key = s.qrData || s.transactionRef || s.fileHash;
          if (key) mergedMap.set(key, s);
        });
        (memoryCache.usedSlips || []).forEach(s => {
          const key = s.qrData || s.transactionRef || s.fileHash;
          if (key && !mergedMap.has(key)) mergedMap.set(key, s);
        });
        memoryCache.usedSlips = Array.from(mergedMap.values());
        writeJson(USED_SLIPS_FILE, memoryCache.usedSlips);
      } else {
        await supabase.from('settings').upsert({ id: 'used_slips_registry', data: memoryCache.usedSlips || [] });
      }
    } catch (e) {}

    memoryCache.isSupabaseActive = true;
    memoryCache.lastSyncTime = new Date().toISOString();
    memoryCache.syncError = null;
    console.log('✅ [Cloud Database] Supabase sync successful! High concurrency mode enabled.');

    // Start background sync every 30 seconds to stay synchronized across instances
    setInterval(backgroundSyncFromSupabase, 30000);
  } catch (err) {
    memoryCache.syncError = err.message;
    console.warn('⚠️ [Cloud Database] Supabase initial sync notice (falling back to local cache):', err.message);
  }
}

async function backgroundSyncFromSupabase() {
  if (!supabase || !memoryCache.isSupabaseActive) return;
  try {
    const { data: ordersData } = await supabase
      .from('orders')
      .select('*')
      .order('createdAt', { ascending: false });

    if (ordersData && ordersData.length >= 0) {
      memoryCache.orders = ordersData.map(o => ({
        ...o,
        deviceModel: o.deviceModel || (o.slipVerification && o.slipVerification.deviceModel) || 'ไม่ระบุรุ่น',
        deviceInfo: o.deviceInfo || (o.slipVerification && o.slipVerification.deviceInfo) || null
      }));
      writeJson(ORDERS_FILE, memoryCache.orders);
    }

    const { data: snacksData } = await supabase
      .from('snacks')
      .select('*')
      .order('sortOrder', { ascending: true });

    if (snacksData && snacksData.length > 0) {
      memoryCache.snacks = snacksData.map(s => ({
        id: s.id,
        name: s.name,
        price: Number(s.price),
        cost: Number(s.cost || 0),
        unit: s.unit || 'ชิ้น',
        description: s.description || '',
        image: s.image || '',
        isAvailable: s.isAvailable !== false,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt
      }));
      writeJson(SNACKS_FILE, memoryCache.snacks);
    }

    memoryCache.lastSyncTime = new Date().toISOString();
  } catch (e) {
    // Background polling error is non-fatal
  }
}

// Safe Supabase query executor that safely handles Postgrest Thenables (which do not have a native .catch method)
function safeSupabaseExec(promiseOrBuilder, errorPrefix = 'Supabase operation') {
  if (!promiseOrBuilder) return;
  Promise.resolve(promiseOrBuilder)
    .then(({ data, error } = {}) => {
      if (error) {
        console.error(`[Supabase Error] ${errorPrefix}:`, error.message || error);
      }
    })
    .catch(err => {
      console.error(`[Supabase Exception] ${errorPrefix}:`, err.message || err);
    });
}

// ==========================================
// SNACKS API
// ==========================================
function getSnacks(includeUnavailable = false) {
  initLocalCache();
  const snacks = memoryCache.snacks || [];
  if (includeUnavailable) return snacks;
  return snacks.filter(s => s.isAvailable !== false);
}

function getSnackById(id) {
  initLocalCache();
  const snacks = memoryCache.snacks || [];
  return snacks.find(s => s.id === id);
}

function saveSnack(snackData) {
  initLocalCache();
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

  memoryCache.snacks.push(newSnack);
  writeJson(SNACKS_FILE, memoryCache.snacks);

  if (supabase) {
    safeSupabaseExec(
      supabase.from('snacks').insert([{
        ...newSnack,
        sortOrder: memoryCache.snacks.length - 1
      }]),
      'Insert snack'
    );
  }

  return newSnack;
}

function updateSnack(id, updates) {
  initLocalCache();
  const index = memoryCache.snacks.findIndex(s => s.id === id);
  if (index === -1) return null;

  memoryCache.snacks[index] = {
    ...memoryCache.snacks[index],
    ...updates,
    price: updates.price !== undefined ? Number(updates.price) : memoryCache.snacks[index].price,
    cost: updates.cost !== undefined ? (Number(updates.cost) >= 0 ? Number(updates.cost) : 0) : (memoryCache.snacks[index].cost || 0),
    updatedAt: new Date().toISOString()
  };

  writeJson(SNACKS_FILE, memoryCache.snacks);

  if (supabase) {
    safeSupabaseExec(
      supabase.from('snacks')
        .update(memoryCache.snacks[index])
        .eq('id', id),
      'Update snack'
    );
  }

  return memoryCache.snacks[index];
}

function deleteSnack(id) {
  initLocalCache();
  const filtered = memoryCache.snacks.filter(s => s.id !== id);
  if (filtered.length === memoryCache.snacks.length) return false;

  memoryCache.snacks = filtered;
  writeJson(SNACKS_FILE, memoryCache.snacks);

  if (supabase) {
    safeSupabaseExec(
      supabase.from('snacks')
        .delete()
        .eq('id', id),
      'Delete snack'
    );
  }

  return true;
}

function reorderSnacks(orderedIds) {
  if (!Array.isArray(orderedIds)) return false;
  initLocalCache();

  const snackMap = new Map();
  memoryCache.snacks.forEach(s => snackMap.set(s.id, s));

  const reordered = [];
  orderedIds.forEach(id => {
    if (snackMap.has(id)) {
      reordered.push(snackMap.get(id));
      snackMap.delete(id);
    }
  });

  // Keep any remaining snacks not present in orderedIds
  snackMap.forEach(s => reordered.push(s));

  memoryCache.snacks = reordered;
  writeJson(SNACKS_FILE, reordered);

  if (supabase) {
    // Update sortOrder for all items
    const updates = reordered.map((s, idx) => ({
      id: s.id,
      sortOrder: idx
    }));
    safeSupabaseExec(
      Promise.all(updates.map(u => supabase.from('snacks').update({ sortOrder: u.sortOrder }).eq('id', u.id))),
      'Reorder snacks'
    );
  }

  return reordered;
}

// ==========================================
// ORDERS API
// ==========================================
function getOrders() {
  initLocalCache();
  const orders = memoryCache.orders || [];
  return [...orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getOrderById(id) {
  initLocalCache();
  const orders = memoryCache.orders || [];
  return orders.find(o => o.id === id);
}

function createOrder(orderData) {
  initLocalCache();
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const randStr = Math.random().toString(36).substring(2, 6).toUpperCase();
  const orderId = `MW-${dateStr}-${randStr}`;

  const devModel = orderData.deviceModel || (orderData.deviceInfo && orderData.deviceInfo.summary) || 'ไม่ระบุรุ่น';
  const devInfo = orderData.deviceInfo || null;

  const newOrder = {
    id: orderId,
    deviceId: orderData.deviceId?.trim() || null, // Mobile device unique identifier
    deviceModel: devModel,                       // Detected phone model (e.g. iPhone 15 Pro, Samsung Galaxy S23)
    deviceInfo: devInfo,
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
    slipBase64: orderData.slipBase64 || (orderData.slipVerification && orderData.slipVerification.slipBase64) || null,
    slipVerification: orderData.slipVerification || null,
    qrData: orderData.qrData || null,
    transactionRef: orderData.transactionRef || null,
    bankName: orderData.bankName || null,
    orderStatus: orderData.orderStatus || 'pending', // pending, verified, preparing, prepared, delivered, cancelled
    adminNotes: '',
    createdAt: now.toISOString()
  };

  // Embed deviceModel into slipVerification for persistent storage in Supabase JSONB
  if (newOrder.slipVerification && typeof newOrder.slipVerification === 'object') {
    newOrder.slipVerification.deviceModel = devModel;
    newOrder.slipVerification.deviceInfo = devInfo;
  }

  memoryCache.orders.unshift(newOrder);
  writeJson(ORDERS_FILE, memoryCache.orders);

  // Register slip into permanent memory registry
  const slipV = orderData.slipVerification || {};
  registerUsedSlip({
    qrData: orderData.qrData || slipV.qrData || slipV.rawQrData,
    transactionRef: orderData.transactionRef || slipV.transactionRef,
    fileHash: orderData.fileHash || slipV.fileHash,
    orderId
  });

  if (supabase) {
    const { slipBase64, deviceInfo, deviceModel, ...supabasePayload } = newOrder;
    safeSupabaseExec(
      supabase.from('orders').insert([supabasePayload]),
      'Insert order'
    );
  }

  return newOrder;
}

function updateOrderStatus(id, status, adminNotes = null) {
  initLocalCache();
  const index = memoryCache.orders.findIndex(o => o.id === id);
  if (index === -1) return null;

  memoryCache.orders[index].orderStatus = status;
  if (adminNotes !== null) {
    memoryCache.orders[index].adminNotes = adminNotes;
  }
  memoryCache.orders[index].updatedAt = new Date().toISOString();

  writeJson(ORDERS_FILE, memoryCache.orders);

  if (supabase) {
    const updatePayload = {
      orderStatus: status,
      updatedAt: memoryCache.orders[index].updatedAt
    };
    if (adminNotes !== null) {
      updatePayload.adminNotes = adminNotes;
    }
    safeSupabaseExec(
      supabase.from('orders')
        .update(updatePayload)
        .eq('id', id),
      'Update order status'
    );
  }

  return memoryCache.orders[index];
}

// Find orders by query, deviceId, or IDs (Strict device isolation to prevent privacy leaks)
function findOrders({ query, phone, name, ids, deviceId } = {}) {
  const allOrders = getOrders();

  // 1. Explicit search query from customer search bar (Order ID or Phone number)
  if (query && query.trim()) {
    const q = query.trim().toLowerCase();
    const cleanQPhone = q.replace(/[\s\-]/g, '');
    return allOrders.filter(o => {
      // Match by Order ID (e.g. MW-...)
      if (o.id && o.id.toLowerCase().includes(q)) return true;
      // Match by Customer Phone (require at least 6 digits to prevent matching everything)
      if (cleanQPhone.length >= 6) {
        const orderPhone = (o.customerPhone || '').replace(/[\s\-]/g, '');
        if (orderPhone.includes(cleanQPhone)) return true;
      }
      return false;
    });
  }

  // 2. Per-device or customer phone retrieval (Strict privacy to prevent foreign leaks)
  const idSet = (ids && Array.isArray(ids)) ? new Set(ids) : new Set();
  const cleanDeviceId = (deviceId || '').trim();
  const cleanPhone = (phone || '').replace(/[\s\-]/g, '');

  if (cleanDeviceId || idSet.size > 0 || cleanPhone.length >= 8) {
    return allOrders.filter(o => {
      // 1. Matched by deviceId from cloud (order genuinely created on this device)
      if (cleanDeviceId && o.deviceId && o.deviceId === cleanDeviceId) return true;
      // 2. Matched by order ID list saved on this device
      if (idSet.has(o.id)) return true;
      // 3. Matched by customer phone (reconnects customer's orders across browser resets)
      if (cleanPhone.length >= 8) {
        const orderPhone = (o.customerPhone || '').replace(/[\s\-]/g, '');
        if (orderPhone && (orderPhone === cleanPhone || orderPhone.includes(cleanPhone))) return true;
      }

      return false;
    });
  }

  // If new device or no matching identifiers, return empty array!
  // NEVER fallback to allOrders to ensure complete privacy across devices.
  return [];
}

// Permanent Used Slips Memory API
function getUsedSlips() {
  initLocalCache();
  return memoryCache.usedSlips || [];
}

function registerUsedSlip({ qrData, transactionRef, fileHash, orderId = null }) {
  initLocalCache();
  const cleanQr = (qrData || '').trim();
  const cleanRef = (transactionRef || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cleanHash = (fileHash || '').trim();

  if (!cleanQr && !cleanRef && !cleanHash) return;

  if (!Array.isArray(memoryCache.usedSlips)) {
    memoryCache.usedSlips = [];
  }

  const existing = memoryCache.usedSlips.some(s =>
    (cleanQr && s.qrData === cleanQr) ||
    (cleanRef && s.transactionRef && s.transactionRef === cleanRef) ||
    (cleanHash && s.fileHash === cleanHash)
  );

  if (!existing) {
    const entry = {
      qrData: cleanQr,
      transactionRef: cleanRef,
      fileHash: cleanHash,
      orderId,
      usedAt: new Date().toISOString()
    };
    memoryCache.usedSlips.push(entry);
    writeJson(USED_SLIPS_FILE, memoryCache.usedSlips);

    if (supabase) {
      safeSupabaseExec(
        supabase.from('settings')
          .upsert({ id: 'used_slips_registry', data: memoryCache.usedSlips, updatedAt: new Date().toISOString() }),
        'Update used_slips_registry'
      );
    }
  }
}

// Reset Mock/Test Orders (Clears orders & customer info, but PERMANENTLY PRESERVES SLIP MEMORY)
function resetOrders() {
  initLocalCache();

  // 1. Ensure all slips in existing orders are permanently archived before deleting orders
  if (Array.isArray(memoryCache.orders)) {
    memoryCache.orders.forEach(order => {
      const v = order.slipVerification || {};
      registerUsedSlip({
        qrData: order.qrData || v.qrData || v.rawQrData,
        transactionRef: order.transactionRef || v.transactionRef,
        fileHash: order.fileHash || v.fileHash,
        orderId: order.id
      });
    });
  }

  // 2. Clear orders data (Order history, customer names, phones, notes, items ordered)
  memoryCache.orders = [];
  writeJson(ORDERS_FILE, []);

  if (supabase) {
    safeSupabaseExec(
      supabase.from('orders')
        .delete()
        .neq('id', 'DO_NOT_DELETE_NON_EXISTENT'),
      'Reset orders'
    );
  }

  // 3. Clear physical slip image files from disk to reclaim disk storage
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

  // NOTE: memoryCache.usedSlips is INTENTIONALLY NOT WIPED!
  // It permanently remembers all slip QR codes, transaction refs, and hashes so old slips can NEVER be reused.
  return true;
}

// ==========================================
// SETTINGS API
// ==========================================
function getSettings() {
  initLocalCache();
  return memoryCache.settings || getDefaultSettings();
}

function updateSettings(updates) {
  initLocalCache();
  const current = getSettings();
  const updated = { ...current, ...updates };
  memoryCache.settings = updated;
  writeJson(SETTINGS_FILE, updated);

  if (supabase) {
    safeSupabaseExec(
      supabase.from('settings')
        .upsert({ id: 'current', data: updated, updatedAt: new Date().toISOString() }),
      'Update settings'
    );
  }

  return updated;
}

function verifyAdminPin(pin) {
  const settings = getSettings();
  return String(settings.adminPin || '411197') === String(pin).trim();
}

// Database Diagnostics for /health and Monitoring
function getDatabaseStatus() {
  initLocalCache();
  return {
    mode: memoryCache.isSupabaseActive ? 'supabase_cloud' : 'high_speed_memory_json',
    supabaseConnected: memoryCache.isSupabaseActive,
    supabaseConfigured: !!(supabaseUrl && supabaseKey),
    totalSnacks: memoryCache.snacks ? memoryCache.snacks.length : 0,
    totalOrders: memoryCache.orders ? memoryCache.orders.length : 0,
    totalUsedSlipsRemembered: memoryCache.usedSlips ? memoryCache.usedSlips.length : 0,
    lastSyncTime: memoryCache.lastSyncTime,
    syncError: memoryCache.syncError
  };
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
  getUsedSlips,
  registerUsedSlip,
  getSettings,
  updateSettings,
  verifyAdminPin,
  getDatabaseStatus
};
