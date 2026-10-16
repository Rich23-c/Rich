// State (No permanent storage: requires entering PIN every time the page is opened)
try {
  localStorage.removeItem('admin_pin_token');
  sessionStorage.removeItem('admin_pin_token');
} catch (e) {}

let adminPin = '';
let adminSessionToken = '';
let currentTab = 'snacks';
let allOrders = [];
let allAdminSnacks = [];
let currentActiveOrderId = null;

// Security: Inactivity Auto-Logout Timer (15 minutes idle timeout)
let idleTimer = null;
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

function resetIdleTimer() {
  if (!adminPin && !adminSessionToken) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    logoutAdmin();
    Swal.fire({
      icon: 'info',
      title: 'เซสชันหมดอายุอัตโนมัติ 🔒',
      text: 'ไม่มีการใช้งานหน้าจอเป็นเวลา 15 นาที ระบบได้ล็อกหน้าจออัตโนมัติเพื่อความปลอดภัยของร้าน',
      confirmButtonColor: '#0f172a'
    });
  }, IDLE_TIMEOUT_MS);
}

// Track user interactions to keep session active
['mousemove', 'keydown', 'touchstart', 'scroll', 'click'].forEach(evt => {
  window.addEventListener(evt, resetIdleTimer, { passive: true });
});

// Security: Robust XSS sanitizer for all user-supplied data
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Initialize on DOM Ready: ALWAYS show login prompt
document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) lucide.createIcons();
  showLoginOverlay();

  // Auto-refresh orders every 5 seconds when authenticated
  setInterval(() => {
    if (adminPin || adminSessionToken) {
      loadAdminOrders(false);
    }
  }, 5000);
});

// Reset PIN whenever user leaves the page or closes the tab
window.addEventListener('beforeunload', () => {
  adminPin = '';
});
window.addEventListener('pagehide', () => {
  adminPin = '';
});

async function verifyPinWithServer(pin) {
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: (pin || '').trim() })
    });
    const data = await res.json();
    return data;
  } catch (err) {
    return { success: false, error: 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้' };
  }
}

function showLoginOverlay() {
  const overlay = document.getElementById('adminLoginOverlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.style.display = 'flex';
  }
  const input = document.getElementById('adminPinInput');
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 150);
  }
  const err = document.getElementById('pinErrorMessage');
  if (err) err.classList.add('hidden');
}

function hideLoginOverlay() {
  const overlay = document.getElementById('adminLoginOverlay');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.style.display = 'none';
  }
}

function keypadPress(digit) {
  const input = document.getElementById('adminPinInput');
  if (!input) return;
  if (input.value.length < 20) {
    input.value += digit;
  }
  const err = document.getElementById('pinErrorMessage');
  if (err) err.classList.add('hidden');
}

function keypadBackspace() {
  const input = document.getElementById('adminPinInput');
  if (!input) return;
  input.value = input.value.slice(0, -1);
}

function keypadClear() {
  const input = document.getElementById('adminPinInput');
  if (!input) return;
  input.value = '';
  const err = document.getElementById('pinErrorMessage');
  if (err) err.classList.add('hidden');
}

function togglePinVisibility() {
  const input = document.getElementById('adminPinInput');
  const eyeIcon = document.getElementById('pinEyeIcon');
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    if (eyeIcon) eyeIcon.setAttribute('data-lucide', 'eye-off');
  } else {
    input.type = 'password';
    if (eyeIcon) eyeIcon.setAttribute('data-lucide', 'eye');
  }
  if (window.lucide) lucide.createIcons();
}

async function submitAdminPin() {
  const input = document.getElementById('adminPinInput');
  const err = document.getElementById('pinErrorMessage');
  const btn = document.getElementById('loginSubmitBtn');
  const enteredPin = input ? input.value.trim() : '';

  if (!enteredPin) {
    if (err) {
      err.innerText = 'กรุณากรอกรหัสผ่าน PIN ก่อนเข้าใช้งาน';
      err.classList.remove('hidden');
    }
    return;
  }

  if (btn) btn.disabled = true;

  try {
    const loginResult = await verifyPinWithServer(enteredPin);
    if (loginResult && loginResult.success) {
      adminPin = enteredPin;
      adminSessionToken = loginResult.token || '';
      resetIdleTimer();
      hideLoginOverlay();
      await loadInitialData();
      Swal.fire({
        icon: 'success',
        title: 'เข้าสู่ระบบสำเร็จ 🎉',
        text: 'ยินดีต้อนรับสู่ระบบหลังบ้านร้านขนมแม้ว 🐾',
        timer: 1400,
        showConfirmButton: false
      });
    } else {
      const errMsg = (loginResult && loginResult.error) ? loginResult.error : '❌ รหัสผ่าน PIN ไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง';
      if (err) {
        err.innerText = errMsg;
        err.classList.remove('hidden');
      }
      if (input) {
        input.value = '';
        input.classList.add('border-red-500');
        setTimeout(() => input.classList.remove('border-red-500'), 1500);
      }
    }
  } catch (e) {
    console.error('Login error:', e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function logoutAdmin() {
  adminPin = '';
  adminSessionToken = '';
  clearTimeout(idleTimer);
  showLoginOverlay();
}

// Helper for authenticated requests (Uses Cryptographic Session Token + PIN Fallback)
async function adminFetch(url, options = {}) {
  const headers = options.headers || {};
  if (adminSessionToken) {
    headers['x-admin-token'] = adminSessionToken;
  }
  headers['x-admin-pin'] = adminPin || '';
  headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
  headers['Pragma'] = 'no-cache';
  options.headers = headers;
  options.cache = 'no-store';

  resetIdleTimer(); // Refresh idle timeout on active admin activity

  const res = await fetch(url, options);
  if (res.status === 401) {
    logoutAdmin();
    Swal.fire({
      icon: 'warning',
      title: 'เซสชันหมดอายุ',
      text: 'กรุณากรอกรหัสผ่าน PIN ใหม่เพื่อเข้าใช้งาน',
      confirmButtonColor: '#f97316'
    });
  }
  return res;
}

// Load initial data for all sections
async function loadInitialData() {
  await Promise.all([
    loadAdminSnacks(),
    loadAdminOrders(true),
    loadAdminSettings(),
    loadAdminAnalytics()
  ]);
}

// Switch navigation tabs
function switchTab(tab) {
  currentTab = tab;
  ['snacks', 'orders', 'settings', 'analytics'].forEach(t => {
    const btn = document.getElementById(`tabBtn-${t}`);
    const content = document.getElementById(`tabContent-${t}`);
    if (!btn || !content) return;
    if (t === tab) {
      btn.className = 'tab-btn px-4 py-3 text-xs sm:text-sm font-bold border-b-2 border-orange-600 text-orange-600 flex items-center gap-2 transition whitespace-nowrap';
      content.classList.remove('hidden');
    } else {
      btn.className = 'tab-btn px-4 py-3 text-xs sm:text-sm font-semibold border-b-2 border-transparent text-slate-500 hover:text-slate-800 flex items-center gap-2 transition whitespace-nowrap';
      content.classList.add('hidden');
    }
  });

  if (tab === 'orders') {
    loadAdminOrders(false);
  } else if (tab === 'analytics') {
    loadAdminAnalytics();
  }

  if (window.lucide) lucide.createIcons();
}

// Calculate profit for an individual order based on cost snapshot at the time of order
function getOrderCostAndProfit(order) {
  // 1. If order has totalCost and totalProfit snapshotted directly, ALWAYS use them!
  if (order.totalCost !== undefined && order.totalProfit !== undefined) {
    const cost = Number(order.totalCost) || 0;
    const profit = Number(order.totalProfit) || 0;
    const sales = Number(order.totalPrice) || 0;
    const marginPercent = sales > 0 ? Math.round((profit / sales) * 100) : 0;
    return { cost, profit, marginPercent };
  }

  // 2. If order items have their own cost snapshotted at order time, sum them up!
  let orderCost = 0;
  let hasItemCost = false;
  (order.items || []).forEach(item => {
    if (item.cost !== undefined && item.cost !== null) {
      orderCost += (Number(item.cost) || 0) * (Number(item.quantity) || 1);
      hasItemCost = true;
    }
  });

  if (hasItemCost) {
    const orderSales = Number(order.totalPrice) || 0;
    const orderProfit = orderSales - orderCost;
    const marginPercent = orderSales > 0 ? Math.round((orderProfit / orderSales) * 100) : 0;
    return { cost: orderCost, profit: orderProfit, marginPercent };
  }

  // 3. Fallback for legacy orders (prior to snapshotting): use current snack cost
  orderCost = 0;
  (order.items || []).forEach(item => {
    const snack = allAdminSnacks.find(s => s.id === item.snackId || s.name === item.name);
    const unitCost = (snack && snack.cost !== undefined) ? Number(snack.cost) : 0;
    orderCost += unitCost * (Number(item.quantity) || 1);
  });
  const orderSales = Number(order.totalPrice) || 0;
  const orderProfit = orderSales - orderCost;
  const marginPercent = orderSales > 0 ? Math.round((orderProfit / orderSales) * 100) : 0;
  return { cost: orderCost, profit: orderProfit, marginPercent };
}

// Update KPI Stats Cards
function updateStats() {
  const totalSnacks = allAdminSnacks.length;
  const totalOrders = allOrders.length;
  
  const validOrders = allOrders.filter(o => o.orderStatus !== 'cancelled');
  const totalSales = validOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);

  let totalCost = 0;
  validOrders.forEach(o => {
    const { cost } = getOrderCostAndProfit(o);
    totalCost += cost;
  });

  const totalProfit = totalSales - totalCost;
  const totalMargin = totalSales > 0 ? Math.round((totalProfit / totalSales) * 100) : 0;

  const verifiedSlips = allOrders.filter(o => {
    return o.orderStatus === 'verified' || o.orderStatus === 'preparing' || o.orderStatus === 'prepared' || o.orderStatus === 'delivered';
  }).length;

  const statTotalSnacksEl = document.getElementById('statTotalSnacks');
  if (statTotalSnacksEl) statTotalSnacksEl.innerText = totalSnacks;

  const statTotalOrdersEl = document.getElementById('statTotalOrders');
  if (statTotalOrdersEl) statTotalOrdersEl.innerText = totalOrders;

  const statTotalSalesEl = document.getElementById('statTotalSales');
  if (statTotalSalesEl) statTotalSalesEl.innerText = `${totalSales.toLocaleString()} ฿`;

  const statTotalCostEl = document.getElementById('statTotalCost');
  if (statTotalCostEl) statTotalCostEl.innerText = `${totalCost.toLocaleString()} ฿`;

  const statTotalProfitEl = document.getElementById('statTotalProfit');
  if (statTotalProfitEl) {
    statTotalProfitEl.innerHTML = `${totalProfit >= 0 ? '+' : ''}${totalProfit.toLocaleString()} ฿ <span class="text-[11px] font-normal text-slate-500">(${totalMargin}%)</span>`;
  }

  const statVerifiedSlipsEl = document.getElementById('statVerifiedSlips');
  if (statVerifiedSlipsEl) statVerifiedSlipsEl.innerText = verifiedSlips;

  const snacksCountBadge = document.getElementById('snacksCountBadge');
  if (snacksCountBadge) snacksCountBadge.innerText = totalSnacks;

  const ordersCountBadge = document.getElementById('ordersCountBadge');
  if (ordersCountBadge) ordersCountBadge.innerText = totalOrders;
}

// ==============================================
// 1. SNACK MANAGEMENT (MENU, PRICE & PHOTOS)
// ==============================================

async function loadAdminSnacks() {
  try {
    const res = await adminFetch('/api/admin/snacks');
    const data = await res.json();
    if (data.success && data.data) {
      allAdminSnacks = data.data;
      updateStats();
      renderAdminSnacks();
    }
  } catch (err) {
    console.error('Failed to load snacks:', err);
  }
}

let snacksSortable = null;

function renderAdminSnacks() {
  const container = document.getElementById('adminSnacksGrid');
  container.innerHTML = '';

  if (allAdminSnacks.length === 0) {
    container.innerHTML = `
      <div class="col-span-full py-12 text-center text-slate-400 bg-slate-50 rounded-3xl border border-dashed border-slate-200">
        <i data-lucide="cookie" class="w-10 h-10 mx-auto text-slate-300 mb-2"></i>
        <p class="text-sm font-semibold">ยังไม่มีรายการขนมในร้าน</p>
        <p class="text-xs text-slate-400 mt-1">กดปุ่ม "+ เพิ่มเมนูขนมใหม่" ด้านบนเพื่อเริ่มเพิ่มขนมแสนอร่อยได้เลย</p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  allAdminSnacks.forEach((snack, index) => {
    const card = document.createElement('div');
    card.setAttribute('data-id', snack.id);
    card.className = 'snack-draggable-card bg-white rounded-3xl p-4 sm:p-5 border border-slate-200/90 shadow-xs hover:shadow-md transition flex flex-col justify-between group';

    const imgSrc = snack.image || 'https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=500';

    const snackPrice = Number(snack.price) || 0;
    const snackCost = Number(snack.cost) || 0;
    const snackProfit = snackPrice - snackCost;
    const profitMargin = snackPrice > 0 ? Math.round((snackProfit / snackPrice) * 100) : 0;

    card.innerHTML = `
      <div>
        <!-- Drag & Order Header -->
        <div class="flex items-center justify-between pb-2 mb-2 border-b border-slate-100 text-xs">
          <div class="drag-handle flex items-center gap-1.5 text-slate-600 hover:text-slate-900 cursor-grab active:cursor-grabbing font-bold select-none py-1 px-2 rounded-xl hover:bg-slate-100 transition" title="กดค้างแล้วลากเพื่อสลับตำแหน่ง">
            <i data-lucide="grip-vertical" class="w-4 h-4 text-orange-500"></i>
            <span class="text-[11px] text-slate-700 font-bold">อันดับที่ ${index + 1}</span>
            <span class="text-[10px] text-slate-400 font-normal hidden sm:inline">(กดค้างลาก)</span>
          </div>

          <!-- Quick Move Up / Down Buttons (สำหรับมือถือและคอม) -->
          <div class="flex items-center gap-1">
            <button
              type="button"
              onclick="moveSnackPosition('${snack.id}', -1)"
              ${index === 0 ? 'disabled' : ''}
              class="w-7 h-7 flex items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-orange-50 hover:text-orange-600 hover:border-orange-200 disabled:opacity-20 disabled:pointer-events-none transition cursor-pointer shadow-2xs text-slate-600"
              title="เลื่อนขึ้น"
            >
              <i data-lucide="arrow-up" class="w-3.5 h-3.5"></i>
            </button>
            <button
              type="button"
              onclick="moveSnackPosition('${snack.id}', 1)"
              ${index === allAdminSnacks.length - 1 ? 'disabled' : ''}
              class="w-7 h-7 flex items-center justify-center rounded-lg border border-slate-200 bg-white hover:bg-orange-50 hover:text-orange-600 hover:border-orange-200 disabled:opacity-20 disabled:pointer-events-none transition cursor-pointer shadow-2xs text-slate-600"
              title="เลื่อนลง"
            >
              <i data-lucide="arrow-down" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </div>

        <!-- Snack Photo with Price Badge -->
        <div class="relative w-full h-44 rounded-2xl overflow-hidden mb-3 bg-slate-100">
          <img
            src="${imgSrc}"
            alt="${snack.name}"
            class="w-full h-full object-cover transition duration-300 group-hover:scale-105"
            onerror="this.src='https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=500'"
          />
          <div class="absolute top-2.5 right-2.5 bg-white/95 backdrop-blur-md px-3 py-1 rounded-full text-xs font-bold text-orange-600 shadow-sm border border-orange-100">
            ${snackPrice} ฿ / ${snack.unit || 'ชิ้น'}
          </div>

          <div class="absolute bottom-2.5 left-2.5">
            ${snack.isAvailable !== false
              ? '<span class="bg-emerald-500/90 text-white text-[10px] font-bold px-2.5 py-0.5 rounded-full shadow-sm">เปิดขายอยู่</span>'
              : '<span class="bg-slate-700/90 text-white text-[10px] font-bold px-2.5 py-0.5 rounded-full shadow-sm">ปิดชั่วคราว</span>'
            }
          </div>
        </div>

        <!-- Name & Description -->
        <h4 class="font-bold text-slate-900 text-base leading-snug font-heading mb-1">${snack.name}</h4>
        <p class="text-xs text-slate-500 line-clamp-2 mb-2.5">${snack.description || 'ไม่มีคำอธิบาย'}</p>

        <!-- Cost & Profit Breakdown Tag -->
        <div class="bg-slate-50 border border-slate-200/80 rounded-2xl p-2.5 mb-3 text-xs flex items-center justify-between">
          <div>
            <div class="text-[10px] text-slate-400 font-medium">ต้นทุน/หน่วย</div>
            <div class="font-bold text-slate-700">${snackCost > 0 ? snackCost + ' ฿' : '<span class="text-slate-400 font-normal">ยังไม่ระบุ</span>'}</div>
          </div>
          <div class="h-6 w-px bg-slate-200"></div>
          <div class="text-right">
            <div class="text-[10px] text-slate-400 font-medium">กำไรสุทธิ</div>
            <div class="font-bold ${snackProfit >= 0 ? 'text-emerald-600' : 'text-rose-500'}">
              ${snackProfit >= 0 ? '+' : ''}${snackProfit} ฿
              <span class="text-[10px] font-normal text-slate-500">(${profitMargin}%)</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Action Buttons -->
      <div class="pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5">
          <button
            onclick="openEditSnackModal('${snack.id}')"
            class="text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold px-3 py-1.5 rounded-xl transition flex items-center gap-1 cursor-pointer"
          >
            <i data-lucide="edit-3" class="w-3.5 h-3.5"></i>
            <span>แก้ไขราคา/รูป</span>
          </button>

          <button
            onclick="toggleSnackAvailability('${snack.id}', ${snack.isAvailable === false})"
            class="text-xs font-semibold px-2.5 py-1.5 rounded-xl transition cursor-pointer ${
              snack.isAvailable === false
                ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                : 'bg-amber-50 text-amber-700 hover:bg-amber-100'
            }"
          >
            ${snack.isAvailable === false ? 'เปิดขาย' : 'ปิดชั่วคราว'}
          </button>
        </div>

        <button
          onclick="deleteSnack('${snack.id}', '${snack.name}')"
          class="text-slate-400 hover:text-red-600 hover:bg-red-50 p-1.5 rounded-xl transition cursor-pointer"
          title="ลบเมนูนี้"
        >
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      </div>
    `;

    container.appendChild(card);
  });

  if (window.lucide) lucide.createIcons();
  initSnacksSortable();
}

function initSnacksSortable() {
  const container = document.getElementById('adminSnacksGrid');
  if (!container || typeof Sortable === 'undefined') return;

  if (snacksSortable) {
    snacksSortable.destroy();
  }

  snacksSortable = new Sortable(container, {
    animation: 250,
    handle: '.drag-handle',
    ghostClass: 'opacity-30',
    chosenClass: 'ring-2 ring-orange-500',
    dragClass: 'shadow-2xl',
    onEnd: async function () {
      const cards = container.querySelectorAll('.snack-draggable-card');
      const orderedIds = Array.from(cards).map(c => c.getAttribute('data-id')).filter(Boolean);
      await saveSnacksOrder(orderedIds);
    }
  });
}

// Move snack position up (-1) or down (+1) via button
async function moveSnackPosition(snackId, direction) {
  const index = allAdminSnacks.findIndex(s => s.id === snackId);
  if (index === -1) return;

  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= allAdminSnacks.length) return;

  const temp = allAdminSnacks[index];
  allAdminSnacks[index] = allAdminSnacks[targetIndex];
  allAdminSnacks[targetIndex] = temp;

  renderAdminSnacks();
  const orderedIds = allAdminSnacks.map(s => s.id);
  await saveSnacksOrder(orderedIds);
}

async function saveSnacksOrder(orderedIds) {
  try {
    const res = await adminFetch('/api/admin/snacks/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds })
    });
    const data = await res.json();
    if (data.success && data.data) {
      allAdminSnacks = data.data;
      renderAdminSnacks();
      const Toast = Swal.mixin({
        toast: true,
        position: 'top-end',
        showConfirmButton: false,
        timer: 1200
      });
      Toast.fire({
        icon: 'success',
        title: 'จัดเรียงลำดับขนมเรียบร้อย ✨'
      });
    }
  } catch (err) {
    console.error('Save snacks order error:', err);
  }
}

function openAddSnackModal() {
  document.getElementById('snackModalTitle').innerText = 'เพิ่มเมนูขนมใหม่ 🍰';
  document.getElementById('snackEditId').value = '';
  document.getElementById('snackNameInput').value = '';
  document.getElementById('snackPriceInput').value = '';
  document.getElementById('snackCostInput').value = '';
  document.getElementById('snackUnitInput').value = 'ชิ้น';
  document.getElementById('snackDescInput').value = '';
  document.getElementById('snackImageUrlInput').value = '';
  document.getElementById('snackImageFileInput').value = '';
  document.getElementById('snackImagePreview').src = 'https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=400';
  document.getElementById('snackAvailableInput').checked = true;

  updateSnackModalProfitPreview();
  document.getElementById('snackModal').classList.remove('hidden');
}

function openEditSnackModal(snackId) {
  const snack = allAdminSnacks.find(s => s.id === snackId);
  if (!snack) return;

  document.getElementById('snackModalTitle').innerText = 'แก้ไขเมนูขนม 🍰';
  document.getElementById('snackEditId').value = snack.id;
  document.getElementById('snackNameInput').value = snack.name || '';
  document.getElementById('snackPriceInput').value = snack.price || 0;
  document.getElementById('snackCostInput').value = (snack.cost !== undefined && snack.cost !== null) ? snack.cost : '';
  document.getElementById('snackUnitInput').value = snack.unit || 'ชิ้น';
  document.getElementById('snackDescInput').value = snack.description || '';
  document.getElementById('snackImageUrlInput').value = (snack.image && snack.image.startsWith('http')) ? snack.image : '';
  document.getElementById('snackImageFileInput').value = '';
  document.getElementById('snackImagePreview').src = snack.image || 'https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=400';
  document.getElementById('snackAvailableInput').checked = snack.isAvailable !== false;

  updateSnackModalProfitPreview();
  document.getElementById('snackModal').classList.remove('hidden');
}

function updateSnackModalProfitPreview() {
  const priceVal = parseFloat(document.getElementById('snackPriceInput')?.value) || 0;
  const costRaw = document.getElementById('snackCostInput')?.value.trim();
  const textEl = document.getElementById('snackModalProfitText');
  const boxEl = document.getElementById('snackProfitPreviewBox');
  if (!textEl || !boxEl) return;

  if (!costRaw && costRaw !== '0') {
    textEl.innerHTML = `ยังไม่ระบุต้นทุน (ราคาขาย <span class="font-bold text-orange-600">${priceVal.toLocaleString()} ฿</span>)`;
    boxEl.className = 'bg-slate-50 border border-slate-200/90 rounded-2xl p-3 flex items-center justify-between transition';
    return;
  }

  const costVal = parseFloat(costRaw) || 0;
  const profit = priceVal - costVal;
  const margin = priceVal > 0 ? Math.round((profit / priceVal) * 100) : 0;

  if (profit >= 0) {
    textEl.innerHTML = `กำไร <span class="font-bold text-emerald-700">+${profit.toLocaleString()} บาท</span>/หน่วย (${margin}% ของราคาขาย)`;
    boxEl.className = 'bg-emerald-50/80 border border-emerald-200/90 rounded-2xl p-3 flex items-center justify-between transition';
  } else {
    textEl.innerHTML = `ขาดทุน <span class="font-bold text-rose-600">${profit.toLocaleString()} บาท</span>/หน่วย (ต้นทุนสูงกว่าราคาขาย)`;
    boxEl.className = 'bg-rose-50/80 border border-rose-200/90 rounded-2xl p-3 flex items-center justify-between transition';
  }
}

// Auto-convert Thai keyboard number keys and Thai numerals to normal digits
function handlePriceInput(input) {
  const thaiMap = {
    'ๅ': '1', '/': '2', '-': '3', 'ภ': '4', 'ถ': '5',
    'ุ': '6', 'ึ': '7', 'ค': '8', 'ต': '9', 'จ': '0',
    '๑': '1', '๒': '2', '๓': '3', '๔': '4', '๕': '5',
    '๖': '6', '๗': '7', '๘': '8', '๙': '9', '๐': '0'
  };

  let val = input.value;
  let converted = '';
  for (let char of val) {
    if (thaiMap[char] !== undefined) {
      converted += thaiMap[char];
    } else if (/[0-9.]/.test(char)) {
      converted += char;
    }
  }
  input.value = converted;
}

function closeSnackModal() {
  document.getElementById('snackModal').classList.add('hidden');
}

function previewSnackFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('snackImagePreview').src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function previewSnackUrl(url) {
  if (url && url.startsWith('http')) {
    document.getElementById('snackImagePreview').src = url;
  }
}

async function handleSaveSnack() {
  const editId = document.getElementById('snackEditId').value;
  const name = document.getElementById('snackNameInput').value.trim();
  const priceRaw = document.getElementById('snackPriceInput').value.trim();
  const price = parseFloat(priceRaw);
  const costRaw = document.getElementById('snackCostInput').value.trim();
  const cost = costRaw !== '' ? (parseFloat(costRaw) || 0) : 0;
  const unit = document.getElementById('snackUnitInput').value.trim() || 'ชิ้น';
  const description = document.getElementById('snackDescInput').value.trim();
  const imageUrl = document.getElementById('snackImageUrlInput').value.trim();
  const imageFile = document.getElementById('snackImageFileInput').files[0];
  const isAvailable = document.getElementById('snackAvailableInput').checked;

  if (!name || isNaN(price) || price < 0) {
    Swal.fire({
      icon: 'warning',
      title: 'กรุณากรอกข้อมูลให้ครบถ้วน',
      text: 'กรุณาระบุชื่อขนมและราคาต่อชิ้นให้ถูกต้อง',
      confirmButtonColor: '#f97316'
    });
    return;
  }

  const formData = new FormData();
  formData.append('name', name);
  formData.append('price', price);
  formData.append('cost', cost >= 0 ? cost : 0);
  formData.append('unit', unit);
  formData.append('description', description);
  formData.append('isAvailable', isAvailable);

  if (imageFile) {
    formData.append('imageFile', imageFile);
  } else if (imageUrl) {
    formData.append('imageUrl', imageUrl);
  }

  const submitBtn = document.getElementById('saveSnackSubmitBtn');
  submitBtn.disabled = true;

  try {
    const url = editId ? `/api/admin/snacks/${editId}` : '/api/admin/snacks';
    const method = editId ? 'PUT' : 'POST';

    const res = await adminFetch(url, { method, body: formData });
    const data = await res.json();

    if (data.success) {
      closeSnackModal();
      await loadAdminSnacks();
      Swal.fire({
        icon: 'success',
        title: 'บันทึกสำเร็จ',
        text: 'อัปเดตเมนูขนมเรียบร้อยแล้ว',
        timer: 1500,
        showConfirmButton: false
      });
    } else {
      Swal.fire({
        icon: 'error',
        title: 'บันทึกไม่สำเร็จ',
        text: data.error || 'เกิดข้อผิดพลาด',
        confirmButtonColor: '#f97316'
      });
    }
  } catch (err) {
    console.error('Save snack error:', err);
  } finally {
    submitBtn.disabled = false;
  }
}

async function toggleSnackAvailability(snackId, newStatus) {
  try {
    const res = await adminFetch(`/api/admin/snacks/${snackId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAvailable: newStatus })
    });
    const data = await res.json();
    if (data.success) {
      await loadAdminSnacks();
      const Toast = Swal.mixin({
        toast: true,
        position: 'top-end',
        showConfirmButton: false,
        timer: 1500
      });
      Toast.fire({
        icon: newStatus ? 'success' : 'info',
        title: newStatus ? '🟢 เปิดขายเมนูนี้แล้ว' : '⏸️ ปิดรับออเดอร์เมนูนี้ชั่วคราว'
      });
    }
  } catch (err) {
    console.error('Toggle availability error:', err);
  }
}

async function deleteSnack(snackId, snackName) {
  const confirm = await Swal.fire({
    icon: 'warning',
    title: `ลบเมนู "${snackName}"?`,
    text: 'เมื่อลบแล้วจะไม่สามารถกู้คืนได้',
    showCancelButton: true,
    confirmButtonText: 'ใช่, ลบเลย',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#ef4444'
  });

  if (!confirm.isConfirmed) return;

  try {
    const res = await adminFetch(`/api/admin/snacks/${snackId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      await loadAdminSnacks();
      Swal.fire({
        icon: 'success',
        title: 'ลบเมนูเรียบร้อย',
        timer: 1200,
        showConfirmButton: false
      });
    }
  } catch (err) {
    console.error('Delete snack error:', err);
  }
}

// ==============================================
// 2. ORDERS MANAGEMENT & SLIP VERIFICATION
// ==============================================

async function loadAdminOrders(showLoading = false) {
  try {
    const res = await adminFetch(`/api/admin/orders?_t=${Date.now()}`);
    const data = await res.json();
    if (data.success && Array.isArray(data.data)) {
      allOrders = data.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      updateStats();
      renderOrdersTable();
    }
  } catch (err) {
    console.error('Failed to load orders:', err);
  }
}

// ==============================================
// KITCHEN & SHOPPING LIST (รายการเตรียมขนม & สั่งซื้อของ)
// ==============================================
const STORAGE_PURCHASED_ITEMS_KEY = 'snack_maew_purchased_items';

function getPurchasedItems() {
  try {
    const raw = localStorage.getItem(STORAGE_PURCHASED_ITEMS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function savePurchasedItems(map) {
  try {
    localStorage.setItem(STORAGE_PURCHASED_ITEMS_KEY, JSON.stringify(map));
  } catch (e) {
    console.error('Failed to save purchased snacks:', e);
  }
}

function toggleSnackPurchased(snackNameEncoded) {
  const snackName = decodeURIComponent(snackNameEncoded);
  const map = getPurchasedItems();
  // Mark as purchased and remove immediately from shopping list
  map[snackName] = true;
  savePurchasedItems(map);
  renderKitchenShoppingList();

  const Toast = Swal.mixin({
    toast: true,
    position: 'top-end',
    showConfirmButton: false,
    timer: 1500
  });
  Toast.fire({
    icon: 'success',
    title: `✓ ลบ "${snackName}" ออกจากรายการที่ต้องซื้อแล้ว`
  });
}

function clearAllPurchasedSnacks() {
  savePurchasedItems({});
  renderKitchenShoppingList();
  const Toast = Swal.mixin({
    toast: true,
    position: 'top-end',
    showConfirmButton: false,
    timer: 1500
  });
  Toast.fire({
    icon: 'success',
    title: 'รีเซ็ตและแสดงรายการขนมทั้งหมดเรียบร้อย'
  });
}

function renderKitchenShoppingList() {
  const container = document.getElementById('kitchenShoppingListGrid');
  const countBadge = document.getElementById('kitchenPendingCountBadge');
  if (!container) return;

  // Active orders that STILL NEED snacks to be prepared/purchased
  // (Excludes 'prepared', 'delivered', and 'cancelled')
  const activeOrders = allOrders.filter(o => 
    o.orderStatus !== 'prepared' && 
    o.orderStatus !== 'delivered' && 
    o.orderStatus !== 'cancelled'
  );

  // Aggregate items across active orders
  const itemsMap = {};
  activeOrders.forEach(order => {
    (order.items || []).forEach(item => {
      const name = (item.name || 'ขนม').trim();
      const unit = item.unit || 'ชิ้น';
      const qty = Number(item.quantity) || 0;
      if (qty <= 0) return;

      if (!itemsMap[name]) {
        const adminSnack = allAdminSnacks.find(s => s.name === name || s.id === item.snackId);
        const unitPrice = (item.price !== undefined && Number(item.price) >= 0) ? Number(item.price) : ((adminSnack && adminSnack.price) || 0);
        const unitCost = (item.cost !== undefined && Number(item.cost) >= 0) ? Number(item.cost) : ((adminSnack && adminSnack.cost) || 0);
        itemsMap[name] = {
          name: name,
          unit: unit,
          price: unitPrice,
          cost: unitCost,
          totalQuantity: 0,
          totalPrice: 0,
          totalCost: 0,
          image: (adminSnack && adminSnack.image) || item.image || 'https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=300',
          orders: []
        };
      }
      itemsMap[name].totalQuantity += qty;
      itemsMap[name].totalPrice += (itemsMap[name].price * qty);
      itemsMap[name].totalCost += (itemsMap[name].cost * qty);
      itemsMap[name].orders.push({
        orderId: order.id,
        customerName: order.customerName,
        quantity: qty,
        unit: unit,
        price: itemsMap[name].price,
        orderStatus: order.orderStatus
      });
    });
  });

  const purchasedMap = getPurchasedItems();
  const allItemsList = Object.values(itemsMap);

  // Auto clean up purchased keys that are no longer in any active order
  let cleaned = false;
  Object.keys(purchasedMap).forEach(key => {
    if (!itemsMap[key]) {
      delete purchasedMap[key];
      cleaned = true;
    }
  });
  if (cleaned) {
    savePurchasedItems(purchasedMap);
  }

  // Filter only items that have NOT been bought yet!
  // When admin clicks "ซื้อแล้ว", the item is immediately deleted/removed from this view!
  const unpurchasedItems = allItemsList.filter(item => !purchasedMap[item.name]);
  const boughtCount = allItemsList.length - unpurchasedItems.length;

  // Sort by quantity descending
  unpurchasedItems.sort((a, b) => b.totalQuantity - a.totalQuantity);

  const totalPieces = unpurchasedItems.reduce((sum, item) => sum + item.totalQuantity, 0);
  const totalAmount = unpurchasedItems.reduce((sum, item) => sum + item.totalPrice, 0);

  if (countBadge) {
    if (unpurchasedItems.length === 0) {
      countBadge.innerText = allItemsList.length > 0 ? '✓ ซื้อครบทุกรายการแล้ว' : '0 รายการ';
      countBadge.className = 'bg-emerald-600 text-white text-[11px] font-bold px-2.5 py-0.5 rounded-full shadow-2xs';
    } else {
      countBadge.innerText = `${unpurchasedItems.length} เมนูที่ต้องซื้อ (รวม ${totalPieces} ชิ้น • ฿${totalAmount.toLocaleString()})`;
      countBadge.className = 'bg-orange-600 text-white text-[11px] font-bold px-2.5 py-0.5 rounded-full shadow-2xs';
    }
  }

  container.innerHTML = '';

  if (unpurchasedItems.length === 0) {
    container.innerHTML = `
      <div class="col-span-full py-8 px-4 bg-white/90 rounded-2xl border border-dashed border-emerald-300 text-center space-y-2 shadow-2xs">
        <div class="w-12 h-12 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center text-2xl mx-auto shadow-2xs">
          🎉
        </div>
        <div>
          <h5 class="font-bold text-slate-800 text-sm">ซื้อและเตรียมของครบแล้วทุกเมนู! 🐾</h5>
          <p class="text-xs text-slate-500 mt-0.5 max-w-md mx-auto">
            ${boughtCount > 0 ? `ซื้อเสร็จสิ้นแล้วทั้งหมด ${boughtCount} เมนู (หากต้องการดูใหม่ กดปุ่ม "รีเซ็ต / แสดงรายการที่ลบไป" ด้านบนได้ครับ)` : 'ไม่มีรายการขนมที่ต้องเตรียมหรือซื้อเพิ่มในขณะนี้'}
          </p>
        </div>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  unpurchasedItems.forEach(item => {
    const card = document.createElement('div');
    card.className = 'bg-white rounded-2xl p-3.5 border border-amber-200/90 shadow-2xs hover:border-orange-300 space-y-3 transition duration-200';

    // Order breakdown tags
    const breakdownHtml = item.orders.map(o => `
      <span class="inline-flex items-center gap-1 bg-white/90 border border-slate-200/90 px-2 py-0.5 rounded-lg text-[10px] text-slate-700 shadow-2xs" title="ลูกค้า: ${escapeHtml(o.customerName)}">
        <span class="font-mono font-bold text-orange-600">${escapeHtml(o.orderId.replace('MW-', ''))}</span>
        <span class="font-extrabold text-slate-900">×${o.quantity}</span>
        <span class="text-slate-400">(${escapeHtml(o.customerName || 'ลูกค้า')})</span>
      </span>
    `).join('');

    const toggleButtonHtml = `
      <button
        type="button"
        onclick="toggleSnackPurchased('${encodeURIComponent(item.name)}')"
        class="w-full py-2.5 px-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl text-xs font-bold transition shadow-xs flex items-center justify-center gap-1.5 active:scale-95 cursor-pointer"
        title="แตะเพื่อลบรายการนี้ออกเมื่อซื้อแล้ว"
      >
        <i data-lucide="check" class="w-4 h-4 text-white"></i>
        <span>✓ ซื้อแล้ว (แตะเพื่อลบรายการนี้ออก)</span>
      </button>
    `;

    card.innerHTML = `
      <div class="flex items-start gap-3">
        <img
          src="${item.image}"
          alt="${item.name}"
          class="w-14 h-14 rounded-xl object-cover border border-slate-200 shrink-0 shadow-2xs"
          onerror="this.src='https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=300'"
        />
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between gap-1">
            <h5 class="font-extrabold text-slate-900 text-sm truncate" title="${item.name}">
              ${item.name}
            </h5>
            <span class="bg-amber-100 text-amber-900 text-[10px] font-bold px-2 py-0.5 rounded-full border border-amber-300 shrink-0">🛒 ต้องสั่ง/เตรียม</span>
          </div>

          <!-- จำนวนที่ต้องสั่งซื้อ และ ราคา -->
          <div class="mt-1.5 flex items-baseline justify-between gap-1 bg-amber-50/70 px-2.5 py-1.5 rounded-xl border border-amber-200/70">
            <div>
              <span class="text-[10px] text-slate-500 block leading-tight font-medium">จำนวนที่ต้องสั่ง:</span>
              <div class="flex items-baseline gap-1 mt-0.5">
                <span class="text-xl font-black text-orange-600 font-heading">
                  ${item.totalQuantity.toLocaleString()}
                </span>
                <span class="text-xs font-bold text-slate-700">${item.unit}</span>
              </div>
            </div>
            <div class="text-right">
              <span class="text-[10px] text-slate-500 block leading-tight font-medium">ราคา / ยอดรวม:</span>
              <div class="mt-0.5">
                <span class="text-sm font-black text-slate-900">฿${item.totalPrice.toLocaleString()}</span>
                ${item.price > 0 ? `<span class="text-[10px] text-slate-500 block">(@฿${item.price}/${item.unit})</span>` : ''}
              </div>
            </div>
          </div>
          ${item.totalCost > 0 ? `
            <div class="text-[10px] text-slate-500 mt-1 flex items-center justify-between px-1">
              <span>ต้นทุนที่ต้องเตรียม:</span>
              <span class="font-bold text-slate-700">฿${item.totalCost.toLocaleString()} (ทุน ฿${item.cost}/${item.unit})</span>
            </div>
          ` : ''}
        </div>
      </div>

      <!-- Breakdown of which orders ordered this snack -->
      <div class="bg-slate-50/80 p-2 rounded-xl border border-slate-100">
        <div class="text-[10px] text-slate-500 font-semibold mb-1">จาก ${item.orders.length} ออเดอร์ที่รอทำ:</div>
        <div class="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto">
          ${breakdownHtml}
        </div>
      </div>

      <!-- Item Purchased Toggle Button -->
      <div>
        ${toggleButtonHtml}
      </div>
    `;

    container.appendChild(card);
  });

  if (window.lucide) lucide.createIcons();
}

function renderOrdersTable() {
  const tbody = document.getElementById('ordersTableBody');
  const mobileContainer = document.getElementById('adminOrdersMobileCards');
  tbody.innerHTML = '';

  if (allOrders.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="p-10 text-center text-slate-400 bg-slate-50/50">
          <i data-lucide="inbox" class="w-8 h-8 mx-auto text-slate-300 mb-1.5"></i>
          <p class="font-medium text-xs">ยังไม่มีรายการสั่งซื้อเข้ามา</p>
        </td>
      </tr>
    `;
    if (mobileContainer) {
      mobileContainer.innerHTML = `
        <div class="p-8 text-center text-slate-400 bg-slate-50/70 rounded-2xl border border-dashed border-slate-200">
          <i data-lucide="inbox" class="w-8 h-8 mx-auto text-slate-300 mb-1.5"></i>
          <p class="font-medium text-xs">ยังไม่มีรายการสั่งซื้อเข้ามา</p>
        </div>
      `;
    }
    renderKitchenShoppingList();
    if (window.lucide) lucide.createIcons();
    return;
  }

  allOrders.forEach(order => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-50 transition';

    // Items list preview
    const itemsHtml = (order.items || []).map(i => `
      <div class="text-[11px] leading-tight">
        &bull; <b>${i.name}</b> × ${i.quantity} ${i.unit} (${i.subtotal}฿)
      </div>
    `).join('');

    // Slip preview button / thumbnail
    let slipHtml = '<span class="text-slate-400 text-[11px]">ไม่มีสลิป</span>';
    const thumbImg = order.slipBase64 || (order.slipVerification && order.slipVerification.slipBase64) || order.slipImage || '';
    if (thumbImg) {
      slipHtml = `
        <div class="relative group inline-block cursor-pointer" onclick="openSlipDetailModal('${order.id}')" title="กดดูสลิปขนาดใหญ่">
          <img src="${thumbImg}" class="w-12 h-14 object-cover rounded-xl border border-slate-300 shadow-xs hover:scale-105 transition" onerror="this.onerror=null; this.src='/images/shop-qr.png';" />
          <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 rounded-xl flex items-center justify-center text-white transition">
            <i data-lucide="zoom-in" class="w-4 h-4"></i>
          </div>
        </div>
      `;
    }

    // QR Verification badge
    let verifyBadge = '';
    const v = order.slipVerification;
    if (v) {
      if (v.isDuplicateSlip) {
        verifyBadge = `
          <div class="inline-flex flex-col items-center">
            <span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-red-100 text-red-800 border border-red-200">
              🚨 สลิปซ้ำ (QR ซ้ำ)
            </span>
            <span class="text-[10px] text-red-600 mt-0.5 font-medium">เคยถูกใช้แล้ว</span>
          </div>
        `;
      } else if (!v.hasQrCode || v.status === 'NO_QR_CODE') {
        verifyBadge = `
          <div class="inline-flex flex-col items-center">
            <span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-red-100 text-red-800 border border-red-300">
              ❌ ไม่มี QR Code
            </span>
            <span class="text-[10px] text-red-600 mt-0.5 font-medium">ไม่พบ QR ในสลิป</span>
          </div>
        `;
      } else if (v.isReadyToSave || v.status === 'VALID_AND_MATCHED' || v.hasQrCode) {
        const bankName = order.bankName || v.bankName || 'ธนาคารไทย';
        const refSnippet = v.transactionRef ? (v.transactionRef.length > 8 ? v.transactionRef.slice(-6) : v.transactionRef) : '';
        verifyBadge = `
          <div class="inline-flex flex-col items-center">
            <span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
              ✓ QR ผ่าน (${bankName})
            </span>
            <span class="text-[10px] text-emerald-600 mt-0.5 font-medium">${refSnippet ? 'Ref: ' + refSnippet + ' &bull; ' : ''}${order.totalPrice}฿</span>
          </div>
        `;
      } else {
        verifyBadge = `
          <div class="inline-flex flex-col items-center">
            <span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-300">
              ⚠️ รอตรวจสอบ
            </span>
          </div>
        `;
      }
    } else {
      verifyBadge = '<span class="px-2 py-0.5 rounded-full text-[10px] text-slate-400">ไม่มีข้อมูล</span>';
    }

    // Confirm button if pending review
    const confirmBtnHtml = (order.orderStatus === 'pending') ? `
      <button
        type="button"
        onclick="changeOrderStatus('${order.id}', 'verified')"
        class="inline-flex items-center gap-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs px-3 py-1.5 rounded-xl shadow-xs transition active:scale-95 cursor-pointer mb-1.5"
        title="กดยืนยันว่าตรวจสอบสลิปถูกต้องแล้ว"
      >
        <i data-lucide="check-circle" class="w-3.5 h-3.5"></i>
        <span>ยืนยันสลิป</span>
      </button>
    ` : '';

    // Status select dropdown
    const statusSelectHtml = `
      <div class="flex flex-col items-center">
        ${confirmBtnHtml}
        <select
          onchange="changeOrderStatus('${order.id}', this.value)"
          class="text-xs font-semibold rounded-xl px-2.5 py-1.5 border border-slate-200 focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white shadow-xs"
        >
          <option value="pending" ${order.orderStatus === 'pending' ? 'selected' : ''}>⏳ รอตรวจสอบสลิป</option>
          <option value="verified" ${order.orderStatus === 'verified' ? 'selected' : ''}>🟢 ยืนยันสลิปแล้ว</option>
          <option value="preparing" ${order.orderStatus === 'preparing' ? 'selected' : ''}>👨‍🍳 กำลังเตรียมขนม</option>
          <option value="prepared" ${order.orderStatus === 'prepared' ? 'selected' : ''}>🍰 เตรียมขนมเสร็จแล้ว</option>
          <option value="delivered" ${order.orderStatus === 'delivered' ? 'selected' : ''}>🚚 ส่งมอบเรียบร้อย</option>
          <option value="cancelled" ${order.orderStatus === 'cancelled' ? 'selected' : ''}>❌ ยกเลิก</option>
        </select>
      </div>
    `;

    const dateStr = new Date(order.createdAt).toLocaleString('th-TH', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    });

    const { cost: orderCost, profit: orderProfit, marginPercent: orderMargin } = getOrderCostAndProfit(order);

    tr.innerHTML = `
      <td class="p-3.5">
        <div class="font-mono font-bold text-orange-600 text-xs">${escapeHtml(order.id)}</div>
        <div class="text-[11px] text-slate-400 mt-0.5">${escapeHtml(dateStr)}</div>
      </td>
      <td class="p-3.5">
        <div class="font-bold text-slate-900 text-xs">${escapeHtml(order.customerName)}</div>
        <div class="text-[11px] text-slate-500">${escapeHtml(order.customerPhone || 'ไม่ระบุเบอร์')}</div>
        <div class="inline-flex items-center gap-1 text-[10px] text-slate-600 bg-slate-100 px-2 py-0.5 rounded-md mt-1 font-medium" title="${escapeHtml(order.deviceModel || 'ไม่ระบุรุ่น')}">
          <span>📱</span>
          <span>${escapeHtml(order.deviceModel || 'อุปกรณ์มือถือ')}</span>
        </div>
      </td>
      <td class="p-3.5 space-y-1">
        ${itemsHtml}
      </td>
      <td class="p-3.5 text-right">
        <div class="font-bold text-slate-900 text-sm">${order.totalPrice.toLocaleString()} ฿</div>
        <div class="text-[11px] font-semibold ${orderProfit >= 0 ? 'text-emerald-600' : 'text-rose-500'} mt-0.5 whitespace-nowrap">
          กำไร ${orderProfit >= 0 ? '+' : ''}${orderProfit.toLocaleString()} ฿
        </div>
        <div class="text-[10px] text-slate-400 whitespace-nowrap">
          (ต้นทุน ${orderCost.toLocaleString()} ฿)
        </div>
      </td>
      <td class="p-3.5 text-center">
        ${slipHtml}
      </td>
      <td class="p-3.5 text-center">
        ${verifyBadge}
      </td>
      <td class="p-3.5 text-center">
        ${statusSelectHtml}
      </td>
    `;

    tbody.appendChild(tr);
  });

  // Also render Mobile Cards for smartphones (adminOrdersMobileCards)
  if (mobileContainer) {
    mobileContainer.innerHTML = '';
    if (allOrders.length === 0) {
      mobileContainer.innerHTML = `
        <div class="p-8 text-center text-slate-400 bg-slate-50/70 rounded-2xl border border-dashed border-slate-200">
          <i data-lucide="inbox" class="w-8 h-8 mx-auto text-slate-300 mb-1.5"></i>
          <p class="font-medium text-xs">ยังไม่มีรายการสั่งซื้อเข้ามา</p>
        </div>
      `;
    } else {
      allOrders.forEach(order => {
        const { cost: orderCost, profit: orderProfit, marginPercent: orderMargin } = getOrderCostAndProfit(order);
        const card = document.createElement('div');
        card.className = 'bg-white rounded-2xl p-4 border border-slate-200 shadow-xs space-y-3';

        const dateStr = new Date(order.createdAt).toLocaleString('th-TH', {
          day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
        });

        // Items list
        const itemsHtml = (order.items || []).map(i => `
          <div class="flex justify-between text-xs py-0.5">
            <span class="text-slate-800 font-medium">🍪 ${i.name} × ${i.quantity} ${i.unit}</span>
            <span class="text-slate-600 font-semibold">${i.subtotal} ฿</span>
          </div>
        `).join('');

        // Status badge info
        let statusBadge = '';
        if (order.orderStatus === 'pending') statusBadge = '<span class="bg-amber-100 text-amber-800 text-[10px] font-bold px-2.5 py-0.5 rounded-full border border-amber-200">⏳ รอตรวจสอบสลิป</span>';
        else if (order.orderStatus === 'verified') statusBadge = '<span class="bg-emerald-100 text-emerald-800 text-[10px] font-bold px-2.5 py-0.5 rounded-full border border-emerald-200">🟢 ยืนยันสลิปแล้ว</span>';
        else if (order.orderStatus === 'preparing') statusBadge = '<span class="bg-blue-100 text-blue-800 text-[10px] font-bold px-2.5 py-0.5 rounded-full border border-blue-200">👨‍🍳 กำลังเตรียมขนม</span>';
        else if (order.orderStatus === 'prepared') statusBadge = '<span class="bg-amber-100 text-amber-900 text-[10px] font-bold px-2.5 py-0.5 rounded-full border border-amber-300">🍰 เตรียมขนมเสร็จแล้ว</span>';
        else if (order.orderStatus === 'delivered') statusBadge = '<span class="bg-emerald-600 text-white text-[10px] font-bold px-2.5 py-0.5 rounded-full">🚚 ส่งมอบแล้ว</span>';
        else if (order.orderStatus === 'cancelled') statusBadge = '<span class="bg-red-100 text-red-700 text-[10px] font-bold px-2.5 py-0.5 rounded-full border border-red-200">❌ ยกเลิก</span>';

        // AI Verification badge
        let verifyBadge = '';
        const v = order.slipVerification;
        if (v && v.isDuplicateSlip) {
          verifyBadge = `<span class="text-[10px] text-red-700 font-bold bg-red-50 px-2 py-0.5 rounded-lg border border-red-200">🚨 สลิปซ้ำ!</span>`;
        } else if (order.orderStatus === 'verified' || (v && (v.isReadyToSave || v.status === 'VALID_AND_MATCHED' || v.isAmountMatched))) {
          verifyBadge = `<span class="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-2 py-0.5 rounded-lg border border-emerald-200">✓ ยืนยันสลิปแล้ว (${v?.transferDate || 'วันนี้'})</span>`;
        } else {
          verifyBadge = `<span class="text-[10px] text-amber-700 font-bold bg-amber-50 px-2 py-0.5 rounded-lg border border-amber-200">⏳ รอแอดมินตรวจ</span>`;
        }

        // Phone call button
        const phoneCallBtn = order.customerPhone ? `
          <a href="tel:${order.customerPhone}" class="inline-flex items-center gap-1 text-[11px] text-blue-700 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded-lg border border-blue-200 font-bold active:scale-95 transition">
            <i data-lucide="phone-call" class="w-3 h-3"></i>
            <span>โทร ${order.customerPhone}</span>
          </a>
        ` : '<span class="text-[11px] text-slate-400">ไม่ระบุเบอร์</span>';

        // Slip thumbnail button
        let slipThumbHtml = '<span class="text-xs text-slate-400">ไม่มีสลิป</span>';
        const mobileThumbImg = order.slipBase64 || (order.slipVerification && order.slipVerification.slipBase64) || order.slipImage || '';
        if (mobileThumbImg) {
          slipThumbHtml = `
            <button type="button" onclick="openSlipDetailModal('${order.id}')" class="flex items-center gap-2 bg-slate-50 hover:bg-slate-100 p-1.5 pr-3 rounded-xl border border-slate-200 transition text-left cursor-pointer active:scale-98">
              <img src="${mobileThumbImg}" class="w-10 h-12 object-cover rounded-lg border border-slate-300" onerror="this.onerror=null; this.src='/images/shop-qr.png';" />
              <div>
                <div class="text-[11px] font-bold text-slate-800 flex items-center gap-1">
                  <i data-lucide="zoom-in" class="w-3 h-3 text-orange-600"></i>
                  <span>ดูสลิปโอน</span>
                </div>
                <div class="text-[10px] text-slate-500">แตะเพื่อซูมดูรูปเต็ม</div>
              </div>
            </button>
          `;
        }

        const mobileConfirmBtn = (order.orderStatus === 'pending') ? `
          <button
            type="button"
            onclick="changeOrderStatus('${order.id}', 'verified')"
            class="w-full py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl shadow-xs transition flex items-center justify-center gap-1.5 active:scale-95 cursor-pointer mb-2"
          >
            <i data-lucide="check-circle" class="w-4 h-4"></i>
            <span>✅ กดยืนยันสลิปถูกต้อง</span>
          </button>
        ` : '';

        card.innerHTML = `
          <!-- Card Header -->
          <div class="flex items-center justify-between border-b border-slate-100 pb-2.5">
            <div>
              <div class="font-mono font-bold text-orange-600 text-xs">${escapeHtml(order.id)}</div>
              <div class="text-[10px] text-slate-400 mt-0.5">${escapeHtml(dateStr)}</div>
            </div>
            <div>${statusBadge}</div>
          </div>

          <!-- Customer info -->
          <div class="flex items-center justify-between text-xs">
            <div>
              <span class="text-slate-400 text-[10px]">ลูกค้า:</span>
              <span class="font-bold text-slate-800 ml-1">${escapeHtml(order.customerName)}</span>
              <div class="inline-flex items-center gap-1 text-[10px] text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded mt-0.5 font-medium">
                <span>📱</span>
                <span>${escapeHtml(order.deviceModel || 'อุปกรณ์มือถือ')}</span>
              </div>
            </div>
            <div>${phoneCallBtn}</div>
          </div>

          <!-- Items list -->
          <div class="bg-slate-50 p-2.5 rounded-xl border border-slate-100 divide-y divide-slate-100">
            ${itemsHtml}
            <div class="flex justify-between items-baseline pt-1.5 mt-1 font-bold">
              <span class="text-xs text-slate-600">ยอดรวมทั้งสิ้น:</span>
              <div class="text-right">
                <div class="text-base text-orange-600 font-heading">${order.totalPrice.toLocaleString()} บาท</div>
                <div class="text-[11px] font-semibold ${orderProfit >= 0 ? 'text-emerald-600' : 'text-rose-500'}">
                  กำไร ${orderProfit >= 0 ? '+' : ''}${orderProfit.toLocaleString()} ฿ <span class="text-[10px] font-normal text-slate-500">(ต้นทุน ${orderCost.toLocaleString()} ฿)</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Slip & Verification info -->
          <div class="flex items-center justify-between gap-2 pt-0.5">
            <div>${slipThumbHtml}</div>
            <div>${verifyBadge}</div>
          </div>

          <!-- Status update dropdown -->
          <div class="pt-2 border-t border-slate-100 space-y-2">
            ${mobileConfirmBtn}
            <div class="flex items-center justify-between gap-2">
              <span class="text-[11px] text-slate-500 font-semibold shrink-0">สถานะ:</span>
              <select
                onchange="changeOrderStatus('${order.id}', this.value)"
                class="w-full text-xs font-bold rounded-xl px-2.5 py-2 border border-slate-200 focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white shadow-xs"
              >
                <option value="pending" ${order.orderStatus === 'pending' ? 'selected' : ''}>⏳ รอตรวจสอบสลิป</option>
                <option value="verified" ${order.orderStatus === 'verified' ? 'selected' : ''}>🟢 ยืนยันสลิปแล้ว</option>
                <option value="preparing" ${order.orderStatus === 'preparing' ? 'selected' : ''}>👨‍🍳 กำลังเตรียมขนม</option>
                <option value="prepared" ${order.orderStatus === 'prepared' ? 'selected' : ''}>🍰 เตรียมขนมเสร็จแล้ว</option>
                <option value="delivered" ${order.orderStatus === 'delivered' ? 'selected' : ''}>🚚 ส่งมอบเรียบร้อย</option>
                <option value="cancelled" ${order.orderStatus === 'cancelled' ? 'selected' : ''}>❌ ยกเลิก</option>
              </select>
            </div>
          </div>
        `;

        mobileContainer.appendChild(card);
      });
    }
  }

  renderKitchenShoppingList();
  if (window.lucide) lucide.createIcons();
}

async function changeOrderStatus(orderId, newStatus) {
  try {
    const res = await adminFetch(`/api/admin/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });
    const data = await res.json();
    if (data.success) {
      const order = allOrders.find(o => o.id === orderId);
      if (order) order.orderStatus = newStatus;
      updateStats();
      renderOrdersTable();

      const Toast = Swal.mixin({
        toast: true,
        position: 'top-end',
        showConfirmButton: false,
        timer: 1200
      });
      Toast.fire({
        icon: 'success',
        title: 'อัปเดตสถานะออเดอร์สำเร็จ'
      });
    }
  } catch (err) {
    console.error('Update status error:', err);
  }
}

// Open Slip Zoom Modal
function openSlipDetailModal(orderId) {
  const order = allOrders.find(o => o.id === orderId);
  if (!order) return;

  currentActiveOrderId = orderId;
  const v = order.slipVerification || {};
  document.getElementById('slipModalOrderSub').innerText = `ออเดอร์: ${order.id} | ลูกค้า: ${order.customerName} (${order.customerPhone || 'ไม่มีเบอร์'})`;
  document.getElementById('slipModalExpected').innerText = `${order.totalPrice.toFixed(2)} บาท`;

  const slipImgEl = document.getElementById('slipModalImg');
  const slipFallbackEl = document.getElementById('slipModalImgFallback');
  const candidateSrc = order.slipBase64 || v.slipBase64 || order.slipImage || '';

  if (slipImgEl) {
    if (candidateSrc) {
      slipImgEl.classList.remove('hidden');
      if (slipFallbackEl) slipFallbackEl.classList.add('hidden');

      slipImgEl.onerror = () => {
        // If image failed to load, try Base64 if not tried yet
        if ((order.slipBase64 || v.slipBase64) && slipImgEl.src !== (order.slipBase64 || v.slipBase64)) {
          slipImgEl.src = order.slipBase64 || v.slipBase64;
        } else {
          slipImgEl.classList.add('hidden');
          if (slipFallbackEl) {
            slipFallbackEl.classList.remove('hidden');
            if (window.lucide) lucide.createIcons();
          }
        }
      };

      slipImgEl.src = candidateSrc;
    } else {
      slipImgEl.classList.add('hidden');
      if (slipFallbackEl) {
        slipFallbackEl.classList.remove('hidden');
        if (window.lucide) lucide.createIcons();
      }
    }
  }

  const { cost: orderCost, profit: orderProfit, marginPercent: orderMargin } = getOrderCostAndProfit(order);
  const costEl = document.getElementById('slipModalCost');
  if (costEl) costEl.innerText = `${orderCost.toFixed(2)} บาท`;
  const profitEl = document.getElementById('slipModalProfit');
  if (profitEl) {
    profitEl.innerHTML = `<span class="${orderProfit >= 0 ? 'text-emerald-700' : 'text-rose-600'}">${orderProfit >= 0 ? '+' : ''}${orderProfit.toFixed(2)} บาท (${orderMargin}%)</span>`;
  }

  const detected = v.detectedAmount !== null && v.detectedAmount !== undefined ? v.detectedAmount : null;
  document.getElementById('slipModalDetected').innerText = detected !== null ? `${detected.toFixed(2)} บาท` : 'ตรวจไม่พบ';
  document.getElementById('slipModalDate').innerText = `${v.transferDate || '-'} ${v.transferTime || ''}`;
  document.getElementById('slipModalBank').innerText = v.bankName || '-';
  document.getElementById('slipModalSender').innerText = v.senderName || '-';
  document.getElementById('slipModalRef').innerText = v.transactionRef || '-';

  // QR Code detection display
  const qrEl = document.getElementById('slipModalQr');
  if (qrEl) {
    if (v.hasQrCode) {
      qrEl.innerHTML = `<span class="inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200 text-[11px]"><i data-lucide="check-circle" class="w-3 h-3 text-emerald-600"></i> ตรวจพบ Mini QR Code (${v.qrData ? (v.qrData.substring(0, 18) + '...') : 'ถอดรหัสแล้ว'})</span>`;
    } else {
      qrEl.innerHTML = `<span class="inline-flex items-center gap-1 text-slate-500 bg-slate-50 px-2 py-0.5 rounded-md border border-slate-200 text-[11px]"><i data-lucide="help-circle" class="w-3 h-3 text-slate-400"></i> ไม่มี QR / ตรวจไม่พบ</span>`;
    }
  }

  // Duplicate check display
  const dupEl = document.getElementById('slipModalDuplicate');
  if (dupEl) {
    if (v.isDuplicateSlip) {
      const dupInfo = v.duplicateInfo ? `(ซ้ำกับออเดอร์ #${v.duplicateInfo.orderId})` : '';
      dupEl.innerHTML = `<span class="inline-flex items-center gap-1 text-red-700 bg-red-50 px-2 py-0.5 rounded-md border border-red-200 text-[11px] font-bold"><i data-lucide="alert-triangle" class="w-3 h-3 text-red-500"></i> สลิปซ้ำ ${dupInfo}</span>`;
    } else {
      dupEl.innerHTML = `<span class="inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200 text-[11px] font-semibold"><i data-lucide="shield-check" class="w-3 h-3 text-emerald-600"></i> ไม่ซ้ำ (สลิปใหม่)</span>`;
    }
  }

  // Device model display
  const deviceEl = document.getElementById('slipModalDevice');
  if (deviceEl) {
    const d = order.deviceInfo || (v && v.deviceInfo) || {};
    const model = order.deviceModel || d.summary || d.deviceModel || 'อุปกรณ์มือถือ';
    deviceEl.innerText = `📱 ${model}`;
  }

  const banner = document.getElementById('slipModalStatusBanner');
  if (order.orderStatus === 'pending') {
    banner.className = 'p-3 rounded-2xl border font-bold text-xs bg-amber-50 text-amber-800 border-amber-200';
    banner.innerText = '⏳ รอยืนยันสลิป: กรุณาตรวจสอบรูปสลิปเทียบกับยอดสั่งซื้อ แล้วกดปุ่ม "✅ ยืนยันสลิปถูกต้อง" ด้านล่าง';
  } else if (order.orderStatus === 'verified') {
    banner.className = 'p-3 rounded-2xl border font-bold text-xs bg-emerald-50 text-emerald-800 border-emerald-200';
    banner.innerText = '✅ สลิปได้รับการยืนยันแล้ว: ยอดเงินและสลิปถูกต้อง';
  } else if (order.orderStatus === 'prepared') {
    banner.className = 'p-3 rounded-2xl border font-bold text-xs bg-amber-50 text-amber-900 border-amber-300';
    banner.innerText = '🍰 ขนมเตรียมเสร็จเรียบร้อยแล้ว: พร้อมส่งมอบให้ลูกค้า';
  } else if (v.isDuplicateSlip) {
    banner.className = 'p-3 rounded-2xl border font-bold text-xs bg-red-50 text-red-800 border-red-200';
    banner.innerText = `🚨 ตรวจพบสลิปซ้ำ! ${v.message || 'สลิปนี้ถูกใช้ไปแล้วในระบบ'}`;
  } else {
    banner.className = 'p-3 rounded-2xl border font-bold text-xs bg-slate-50 text-slate-800 border-slate-200';
    banner.innerText = '📄 รูปสลิปการโอนเงิน';
  }

  document.getElementById('slipDetailModal').classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closeSlipDetailModal() {
  document.getElementById('slipDetailModal').classList.add('hidden');
}

async function quickUpdateStatus(newStatus) {
  if (!currentActiveOrderId) return;
  await changeOrderStatus(currentActiveOrderId, newStatus);
  closeSlipDetailModal();
}

// Reset Mock Orders
async function resetMockOrders() {
  const confirm = await Swal.fire({
    icon: 'warning',
    title: 'ต้องการล้างข้อมูลคำสั่งซื้อจำลองทั้งหมด?',
    text: 'ออเดอร์ทดลองและรูปสลิปทดสอบทั้งหมดจะถูกลบออกจากระบบ',
    showCancelButton: true,
    confirmButtonText: 'ใช่, ล้างข้อมูลเลย 🗑️',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#ef4444'
  });

  if (!confirm.isConfirmed) return;

  try {
    const res = await adminFetch('/api/admin/reset-mock-orders', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      await loadAdminOrders(true);
      Swal.fire({
        icon: 'success',
        title: 'ล้างข้อมูลเรียบร้อยแล้ว!',
        text: 'ระบบพร้อมรับคำสั่งซื้อจริงแล้วครับ',
        timer: 1500,
        showConfirmButton: false
      });
    }
  } catch (err) {
    console.error('Reset mock orders error:', err);
  }
}

// Test Email Notification
async function testEmailNotification() {
  const receiver = document.getElementById('settingEmailReceiver').value.trim();
  const sender = document.getElementById('settingEmailSender').value.trim();
  const appPassword = document.getElementById('settingEmailAppPassword').value.trim();

  if (!sender || !appPassword) {
    Swal.fire({
      icon: 'warning',
      title: 'กรุณากรอกข้อมูลให้ครบ',
      text: 'กรุณากรอก Gmail ผู้ส่ง และ รหัสผ่านแอป (App Password) ก่อนกดทดสอบครับ',
      confirmButtonColor: '#f97316'
    });
    return;
  }

  Swal.fire({
    title: 'กำลังทดสอบส่ง Email...',
    text: 'กรุณารอสักครู่ ระบบกำลังเชื่อมต่อไปยังเซิร์ฟเวอร์เมล...',
    allowOutsideClick: false,
    didOpen: () => Swal.showLoading()
  });

  try {
    const res = await adminFetch('/api/admin/test-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiver, sender, appPassword })
    });
    const data = await res.json();

    if (data.success) {
      Swal.fire({
        icon: 'success',
        title: 'ส่งอีเมลสำเร็จ! 🎉',
        text: data.message || 'ระบบได้ส่งอีเมลทดสอบไปเรียบร้อยแล้ว กรุณาเช็กกล่องจดหมายของคุณ',
        confirmButtonColor: '#10b981'
      });
    } else {
      Swal.fire({
        icon: 'error',
        title: 'ส่งอีเมลไม่สำเร็จ',
        text: data.error || 'กรุณาตรวจสอบอีเมลและ App Password อีกครั้ง',
        confirmButtonColor: '#f97316'
      });
    }
  } catch (err) {
    Swal.fire({
      icon: 'error',
      title: 'เกิดข้อผิดพลาด',
      text: err.message,
      confirmButtonColor: '#f97316'
    });
  }
}

// ==============================================
// 3. SHOP SETTINGS MANAGEMENT
// ==============================================

let currentAdminSettings = null;

async function loadAdminSettings() {
  try {
    const res = await adminFetch('/api/admin/settings');
    const data = await res.json();
    if (data.success && data.data) {
      currentAdminSettings = data.data;
      const s = data.data;
      document.getElementById('settingShopName').value = s.shopName || '';
      document.getElementById('settingShopSubtitle').value = s.shopSubtitle || '';
      const ppIdEl = document.getElementById('settingPromptpayId');
      if (ppIdEl) ppIdEl.value = s.promptpayId || '';
      document.getElementById('settingPromptpayName').value = s.promptpayName || '';
      document.getElementById('settingBankName').value = s.bankName || '';
      document.getElementById('settingBankAcc').value = s.bankAccountNumber || '';

      if (s.promptpayQrImage) {
        const qrEl = document.getElementById('adminQrPreview');
        if (qrEl) qrEl.src = s.promptpayQrImage;
      }

      // Store status fields
      document.getElementById('settingIsOpen').checked = s.isOpen !== false;
      document.getElementById('settingClosedMessage').value = s.closedMessage || '';

      // Laptop Sponsor Banner fields
      const bannerEnabledEl = document.getElementById('settingLaptopBannerEnabled');
      if (bannerEnabledEl) bannerEnabledEl.checked = s.laptopBannerEnabled !== false;
      const bannerTitleEl = document.getElementById('settingLaptopBannerTitle');
      if (bannerTitleEl) bannerTitleEl.value = s.laptopBannerTitle || '';
      const bannerTextEl = document.getElementById('settingLaptopBannerText');
      if (bannerTextEl) bannerTextEl.value = s.laptopBannerText || '';
      const bannerContactEl = document.getElementById('settingLaptopBannerContact');
      if (bannerContactEl) bannerContactEl.value = s.laptopBannerContact || '';
      const bannerImgEl = document.getElementById('settingLaptopBannerImage');
      if (bannerImgEl) bannerImgEl.value = s.laptopBannerImage || '';
      const bannerLinkEl = document.getElementById('settingLaptopBannerLink');
      if (bannerLinkEl) bannerLinkEl.value = s.laptopBannerLink || '';

      updateLaptopBannerBadge(s.laptopBannerEnabled !== false);
      updateAdminBannerPreview();

      // Gemini AI Slip Verification keys (Dual-Layer Persistence)
      const geminiEl = document.getElementById('settingGeminiKeys');
      let effectiveKeys = s.geminiApiKeys || s.geminiApiKey || '';

      if (effectiveKeys) {
        try { localStorage.setItem('cached_gemini_api_keys', effectiveKeys); } catch (e) {}
      } else {
        try {
          const cached = localStorage.getItem('cached_gemini_api_keys');
          if (cached) {
            effectiveKeys = cached;
            adminFetch('/api/admin/save-gemini-keys', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ geminiApiKeys: cached })
            }).catch(() => {});
          }
        } catch (e) {}
      }

      if (geminiEl) geminiEl.value = effectiveKeys;
      updateGeminiKeyBadge(effectiveKeys);

      // Update UI for store status in header and settings tab
      updateStoreStatusUi(s.isOpen);

    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

function updateLaptopBannerBadge(isEnabled) {
  const badge = document.getElementById('settingLaptopBannerBadge');
  if (badge) {
    if (isEnabled) {
      badge.className = 'text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200';
      badge.innerText = '🟢 เปิดใช้งาน';
    } else {
      badge.className = 'text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-300';
      badge.innerText = '⚪ ปิดใช้งาน';
    }
  }
}

function updateAdminBannerPreview() {
  const url = (document.getElementById('settingLaptopBannerImage')?.value || '').trim();
  const imgEl = document.getElementById('adminBannerPreviewImg');
  const placeholderEl = document.getElementById('adminBannerPlaceholder');
  if (!imgEl || !placeholderEl) return;

  if (url) {
    imgEl.src = url;
    imgEl.classList.remove('hidden');
    placeholderEl.classList.add('hidden');
  } else {
    imgEl.classList.add('hidden');
    placeholderEl.classList.remove('hidden');
  }
}

function clearAdminBannerImage() {
  const input = document.getElementById('settingLaptopBannerImage');
  if (input) input.value = '';
  updateAdminBannerPreview();
}

async function handleBannerFileUpload(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  const formData = new FormData();
  formData.append('bannerFile', file);

  try {
    const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
    Toast.fire({ icon: 'info', title: 'กำลังอัปโหลดรูปภาพแบนเนอร์...' });

    const res = await adminFetch('/api/admin/upload-banner', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (data.success && data.imageUrl) {
      const urlInput = document.getElementById('settingLaptopBannerImage');
      if (urlInput) urlInput.value = data.imageUrl;
      updateAdminBannerPreview();
      Toast.fire({ icon: 'success', title: 'อัปโหลดรูปแบนเนอร์เรียบร้อยแล้ว!' });
    } else {
      throw new Error(data.error || 'ไม่สามารถอัปโหลดรูปภาพได้');
    }
  } catch (err) {
    Swal.fire({ icon: 'error', title: 'อัปโหลดไม่สำเร็จ', text: err.message, confirmButtonColor: '#f97316' });
  }
}

// Quick toggle store status from header or settings
async function quickToggleStoreOpen() {
  const currentStatus = currentAdminSettings ? (currentAdminSettings.isOpen !== false) : true;
  await handleToggleStoreStatus(!currentStatus);
}

async function handleToggleStoreStatus(newStatus) {
  try {
    const res = await adminFetch('/api/admin/toggle-open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isOpen: newStatus })
    });
    const data = await res.json();
    if (data.success) {
      if (!currentAdminSettings) currentAdminSettings = {};
      currentAdminSettings.isOpen = data.isOpen;
      updateStoreStatusUi(data.isOpen);

      const Toast = Swal.mixin({
        toast: true,
        position: 'top-end',
        showConfirmButton: false,
        timer: 2000
      });
      if (data.isOpen) {
        Toast.fire({
          icon: 'success',
          title: '🟢 เปิดรับออเดอร์แล้ว! ลูกค้าสั่งซื้อได้ตามปกติ'
        });
      } else {
        Toast.fire({
          icon: 'warning',
          title: '🔴 ปิดรับออเดอร์แล้ว! หน้าเว็บลูกค้าหยุดขายทันที'
        });
      }
    }
  } catch (err) {
    console.error('Toggle store status error:', err);
  }
}

function updateStoreStatusUi(isOpen) {
  const isStoreOpen = isOpen !== false;

  // Header button
  const headerBtn = document.getElementById('headerStoreToggleBtn');
  const headerDot = document.getElementById('headerStoreDot');
  const headerText = document.getElementById('headerStoreText');
  const headerTextMobile = document.getElementById('headerStoreTextMobile');

  if (headerBtn) {
    if (isStoreOpen) {
      headerBtn.className = 'text-xs font-bold px-2.5 sm:px-3 py-2 rounded-xl transition flex items-center gap-1.5 cursor-pointer shadow-2xs active:scale-95 bg-emerald-50 text-emerald-800 border border-emerald-300 hover:bg-emerald-100';
      if (headerDot) headerDot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
      if (headerText) headerText.innerText = '🟢 เปิดรับออเดอร์';
      if (headerTextMobile) headerTextMobile.innerText = '🟢 เปิดอยู่';
    } else {
      headerBtn.className = 'text-xs font-bold px-2.5 sm:px-3 py-2 rounded-xl transition flex items-center gap-1.5 cursor-pointer shadow-2xs active:scale-95 bg-red-50 text-red-800 border border-red-300 hover:bg-red-100';
      if (headerDot) headerDot.className = 'w-2 h-2 rounded-full bg-red-500';
      if (headerText) headerText.innerText = '🔴 ปิดรับออเดอร์';
      if (headerTextMobile) headerTextMobile.innerText = '🔴 ปิดอยู่';
    }
  }

  // Settings tab toggle & badges
  const settingCheckbox = document.getElementById('settingIsOpen');
  if (settingCheckbox) settingCheckbox.checked = isStoreOpen;

  const settingBadge = document.getElementById('settingIsOpenBadge');
  if (settingBadge) {
    if (isStoreOpen) {
      settingBadge.className = 'text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200';
      settingBadge.innerText = '🟢 เปิดรับออเดอร์ (ลูกค้าสั่งซื้อได้)';
    } else {
      settingBadge.className = 'text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-800 border border-red-200';
      settingBadge.innerText = '🔴 ปิดรับออเดอร์ (หยุดขายทันที)';
    }
  }
}

async function saveShopSettings() {
  const ppIdEl = document.getElementById('settingPromptpayId');
  const bannerEnabledEl = document.getElementById('settingLaptopBannerEnabled');
  const bannerTitleEl = document.getElementById('settingLaptopBannerTitle');
  const bannerTextEl = document.getElementById('settingLaptopBannerText');
  const bannerContactEl = document.getElementById('settingLaptopBannerContact');
  const bannerImgEl = document.getElementById('settingLaptopBannerImage');
  const bannerLinkEl = document.getElementById('settingLaptopBannerLink');

  const updates = {
    shopName: document.getElementById('settingShopName').value.trim(),
    shopSubtitle: document.getElementById('settingShopSubtitle').value.trim(),
    promptpayId: ppIdEl ? ppIdEl.value.trim() : (currentAdminSettings?.promptpayId || ''),
    promptpayName: document.getElementById('settingPromptpayName').value.trim(),
    bankName: document.getElementById('settingBankName').value.trim(),
    bankAccountNumber: document.getElementById('settingBankAcc').value.trim(),
    promptpayQrImage: (currentAdminSettings && currentAdminSettings.promptpayQrImage) ? currentAdminSettings.promptpayQrImage : '/images/shop-qr.png',

    // Store status settings
    isOpen: document.getElementById('settingIsOpen').checked,
    closedMessage: document.getElementById('settingClosedMessage') ? document.getElementById('settingClosedMessage').value.trim() : '',

    // Laptop Sponsor Banner settings (Only visible on Laptop/PC)
    laptopBannerEnabled: bannerEnabledEl ? bannerEnabledEl.checked : true,
    laptopBannerTitle: bannerTitleEl ? bannerTitleEl.value.trim() : '',
    laptopBannerText: bannerTextEl ? bannerTextEl.value.trim() : '',
    laptopBannerContact: bannerContactEl ? bannerContactEl.value.trim() : '',
    laptopBannerImage: bannerImgEl ? bannerImgEl.value.trim() : '',
    laptopBannerLink: bannerLinkEl ? bannerLinkEl.value.trim() : '',

    // Gemini AI Slip Verification keys
    geminiApiKeys: (function() {
      const el = document.getElementById('settingGeminiKeys');
      const val = el ? el.value.trim() : '';
      if (val) return val;
      try {
        const cached = localStorage.getItem('cached_gemini_api_keys');
        if (cached) return cached;
      } catch (e) {}
      return (currentAdminSettings && currentAdminSettings.geminiApiKeys) || '';
    })()
  };

  try {
    const res = await adminFetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    const data = await res.json();

    if (data.success) {
      if (updates.geminiApiKeys) {
        try { localStorage.setItem('cached_gemini_api_keys', updates.geminiApiKeys); } catch (e) {}
        updateGeminiKeyBadge(updates.geminiApiKeys);
      }
      Swal.fire({
        icon: 'success',
        title: 'บันทึกสำเร็จ 🎉',
        text: 'การตั้งค่าร้าน ข้อมูลพร้อมเพย์ และคีย์ AI ถูกอัปเดตเรียบร้อยแล้ว',
        confirmButtonColor: '#f97316'
      });
    }
  } catch (err) {
    console.error('Save settings error:', err);
  }
}

// ==========================================
// VISITOR ANALYTICS CONTROLLER (TAB 4)
// ==========================================
let currentAnalyticsData = null;

function formatThaiDateOnly(isoString) {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return d.toLocaleDateString('th-TH', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  } catch (e) {
    return isoString;
  }
}

function formatThaiTimeOnly(isoString) {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return d.toLocaleTimeString('th-TH', {
      hour: '2-digit',
      minute: '2-digit'
    }) + ' น.';
  } catch (e) {
    return isoString;
  }
}

function formatThaiDateTimeFull(isoString) {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return d.toLocaleString('th-TH', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }) + ' น.';
  } catch (e) {
    return isoString;
  }
}

async function loadAdminAnalytics() {
  try {
    const res = await adminFetch(`/api/admin/analytics/visitors?_t=${Date.now()}`);
    const result = await res.json();
    if (!result.success || !result.data) return;

    currentAnalyticsData = result.data;
    renderAnalyticsUI(currentAnalyticsData);
  } catch (err) {
    console.error('Error loading analytics:', err);
  }
}

function renderAnalyticsUI(data) {
  if (!data) return;

  const summary = data.summary || {};
  const dailyStats = data.dailyStats || [];
  const visitors = data.visitors || [];

  // 1. Update KPI Cards & Header Badge
  const badgeEl = document.getElementById('analyticsTotalBadge');
  if (badgeEl) badgeEl.textContent = `${summary.totalUniqueVisitors || 0} คน`;

  const statUniqueEl = document.getElementById('statAnalyticsTotalUnique');
  if (statUniqueEl) statUniqueEl.textContent = Number(summary.totalUniqueVisitors || 0).toLocaleString();

  const statVisitsEl = document.getElementById('statAnalyticsTotalVisits');
  if (statVisitsEl) statVisitsEl.textContent = Number(summary.totalVisits || 0).toLocaleString();

  const statTodayUniqueEl = document.getElementById('statAnalyticsTodayUnique');
  if (statTodayUniqueEl) statTodayUniqueEl.textContent = Number(summary.todayUniqueVisitors || 0).toLocaleString();

  const statTodayVisitsEl = document.getElementById('statAnalyticsTodayVisits');
  if (statTodayVisitsEl) statTodayVisitsEl.textContent = Number(summary.todayVisits || 0).toLocaleString();

  const dailyBadge = document.getElementById('dailyStatsCountBadge');
  if (dailyBadge) dailyBadge.textContent = `${dailyStats.length} วัน`;

  // 2. Render Daily Stats Table
  renderDailyStatsTable(dailyStats);

  // 3. Render Visitors Table
  renderVisitorsTable(visitors);

  if (window.lucide) lucide.createIcons();
}

function renderDailyStatsTable(dailyStats) {
  const tbody = document.getElementById('dailyStatsTableBody');
  if (!tbody) return;

  if (!dailyStats || dailyStats.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="py-8 text-center text-slate-400">
          ยังไม่มีข้อมูลคนเข้าชมเว็บในขณะนี้ เมื่อมีลูกค้าเปิดเว็บ ระบบจะบันทึกให้อัตโนมัติทันที
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = dailyStats.map(d => {
    const avg = d.uniqueVisitors > 0 ? (d.totalVisits / d.uniqueVisitors).toFixed(1) : '1.0';
    return `
      <tr class="hover:bg-slate-50/70 transition">
        <td class="py-3 px-4 font-bold text-slate-800">
          📅 ${formatThaiDateOnly(d.date)}
        </td>
        <td class="py-3 px-4 text-center">
          <span class="inline-flex items-center gap-1 bg-indigo-50 text-indigo-700 font-black px-2.5 py-0.5 rounded-full border border-indigo-200">
            ${d.uniqueVisitors.toLocaleString()} คน
          </span>
        </td>
        <td class="py-3 px-4 text-center">
          <span class="inline-flex items-center gap-1 bg-orange-50 text-orange-700 font-black px-2.5 py-0.5 rounded-full border border-orange-200">
            ${d.totalVisits.toLocaleString()} ครั้ง
          </span>
        </td>
        <td class="py-3 px-4 text-right text-slate-500 font-medium">
          เฉลี่ย ${avg} ครั้ง/คน
        </td>
      </tr>
    `;
  }).join('');
}

function renderVisitorsTable(visitors) {
  const tbody = document.getElementById('visitorsTableBody');
  if (!tbody) return;

  if (!visitors || visitors.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="py-8 text-center text-slate-400">
          ยังไม่มีรายชื่อผู้เข้าชมในขณะนี้
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = visitors.map(v => {
    const hasName = v.customerName && String(v.customerName).trim();
    const nameDisplay = hasName
      ? `<div class="flex flex-col">
           <span class="font-bold text-slate-900 text-sm flex items-center gap-1.5">
             <span class="text-amber-500">👤</span>
             <span class="text-orange-950 font-extrabold">${escapeHtml(v.customerName)}</span>
           </span>
           <span class="font-mono text-[10px] text-slate-400 font-semibold mt-0.5">
             รหัส: ${escapeHtml(v.visitorCode)}
           </span>
         </div>`
      : `<div class="flex items-center gap-1.5">
           <span class="font-mono font-black bg-amber-50 text-amber-800 border border-amber-200 px-2.5 py-1 rounded-xl text-xs shadow-2xs">
             🏷️ ${escapeHtml(v.visitorCode)}
           </span>
           <span class="text-[10px] text-slate-400 font-normal">(ยังไม่พิมพ์ชื่อ)</span>
         </div>`;

    return `
      <tr class="hover:bg-slate-50/70 transition">
        <td class="py-3 px-4">
          ${nameDisplay}
        </td>
        <td class="py-3 px-4 text-slate-700">
          <div class="flex items-center gap-1.5 text-xs font-medium">
            <span>📱</span>
            <span>${escapeHtml(v.device || 'ไม่ระบุ')}</span>
          </div>
        </td>
        <td class="py-3 px-4 text-center">
          <span class="inline-flex items-center gap-1 bg-orange-100 text-orange-800 font-black px-2.5 py-0.5 rounded-full text-xs">
            ${v.totalVisits.toLocaleString()} ครั้ง
          </span>
        </td>
        <td class="py-3 px-4 text-center text-xs text-slate-500 font-medium">
          ${formatThaiDateTimeFull(v.lastSeen)}
        </td>
        <td class="py-3 px-4 text-right">
          <button
            onclick="openVisitorDetailModal('${v.visitorId}')"
            class="px-3 py-1.5 bg-orange-50 hover:bg-orange-100 text-orange-700 font-bold rounded-xl text-xs border border-orange-200 transition active:scale-95 inline-flex items-center gap-1 cursor-pointer"
          >
            <i data-lucide="search" class="w-3.5 h-3.5"></i>
            <span>ดูประวัติ (${v.totalVisits} ครั้ง)</span>
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function filterVisitorList(query) {
  if (!currentAnalyticsData || !Array.isArray(currentAnalyticsData.visitors)) return;
  const q = (query || '').trim().toLowerCase();
  if (!q) {
    renderVisitorsTable(currentAnalyticsData.visitors);
    return;
  }

  const filtered = currentAnalyticsData.visitors.filter(v => {
    return (v.visitorCode && v.visitorCode.toLowerCase().includes(q)) ||
           (v.customerName && v.customerName.toLowerCase().includes(q)) ||
           (v.device && v.device.toLowerCase().includes(q));
  });

  renderVisitorsTable(filtered);
  if (window.lucide) lucide.createIcons();
}

function openVisitorDetailModal(visitorId) {
  if (!currentAnalyticsData || !Array.isArray(currentAnalyticsData.visitors)) return;
  const visitor = currentAnalyticsData.visitors.find(v => v.visitorId === visitorId);
  if (!visitor) return;

  const modal = document.getElementById('visitorDetailModal');
  const codeBadge = document.getElementById('modalVisitorCodeBadge');
  const deviceEl = document.getElementById('modalVisitorDeviceText');
  const totalVisitsEl = document.getElementById('modalVisitorTotalVisits');
  const lastSeenEl = document.getElementById('modalVisitorLastSeen');
  const daysCountEl = document.getElementById('modalVisitorDaysCount');
  const dailyListEl = document.getElementById('modalVisitorDailyList');

  if (codeBadge) {
    if (visitor.customerName) {
      codeBadge.textContent = `คุณ${visitor.customerName} (${visitor.visitorCode})`;
    } else {
      codeBadge.textContent = visitor.visitorCode || 'USR-XXXX';
    }
  }
  if (deviceEl) deviceEl.textContent = `อุปกรณ์: ${visitor.device || 'ไม่ระบุ'}`;
  if (totalVisitsEl) totalVisitsEl.textContent = `${visitor.totalVisits || 0} ครั้ง`;
  if (lastSeenEl) lastSeenEl.textContent = formatThaiDateTimeFull(visitor.lastSeen);

  const breakdowns = visitor.dailyBreakdown || [];
  if (daysCountEl) daysCountEl.textContent = `เข้าชมทั้งหมด ${breakdowns.length} วัน`;

  if (dailyListEl) {
    if (breakdowns.length === 0) {
      dailyListEl.innerHTML = '<div class="text-center py-4 text-xs text-slate-400">ไม่มีข้อมูลวันเข้าชม</div>';
    } else {
      dailyListEl.innerHTML = breakdowns.map(b => {
        const timeBadges = (b.timestamps || []).map(ts => {
          return `<span class="bg-white border border-slate-200 text-slate-700 text-[11px] font-medium px-2 py-0.5 rounded-md shadow-2xs">🕐 ${formatThaiTimeOnly(ts)}</span>`;
        }).join('');

        return `
          <div class="bg-slate-50 border border-slate-200/80 rounded-2xl p-3 space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-slate-800">
                📅 ${formatThaiDateOnly(b.date)}
              </span>
              <span class="bg-orange-100 text-orange-800 text-[11px] font-black px-2 py-0.5 rounded-full">
                เข้าชม ${b.count} ครั้ง
              </span>
            </div>
            <div class="flex flex-wrap gap-1.5 pt-1 border-t border-slate-200/60">
              ${timeBadges}
            </div>
          </div>
        `;
      }).join('');
    }
  }

  if (modal) {
    modal.classList.remove('hidden');
  }

  if (window.lucide) lucide.createIcons();
}

function closeVisitorDetailModal() {
  const modal = document.getElementById('visitorDetailModal');
  if (modal) modal.classList.add('hidden');
}

async function confirmResetAnalytics() {
  const result = await Swal.fire({
    title: 'ยืนยันล้างข้อมูลสถิติ?',
    text: 'ระบบจะล้างประวัติการเข้าชมทั้งหมด ยอดผู้เข้าชมจะถูกรีเซ็ตเป็น 0',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#ef4444',
    cancelButtonColor: '#94a3b8',
    confirmButtonText: 'ล้างสถิติทั้งหมด',
    cancelButtonText: 'ยกเลิก'
  });

  if (result.isConfirmed) {
    try {
      const res = await adminFetch('/api/admin/analytics/visitors', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        Swal.fire({
          icon: 'success',
          title: 'ล้างสถิติเรียบร้อย',
          timer: 1200,
          showConfirmButton: false
        });
        loadAdminAnalytics();
      }
    } catch (e) {
      console.error(e);
    }
  }
}

// ==========================================
// ADMIN APP PWA INSTALLER (ANDROID / MOBILE)
// ==========================================
let deferredAdminPwaPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredAdminPwaPrompt = e;
});

window.addEventListener('appinstalled', () => {
  deferredAdminPwaPrompt = null;
  Swal.fire({
    icon: 'success',
    title: 'ติดตั้งแอปหลังบ้านเรียบร้อย 🎉',
    text: 'ไอคอน "แอดมินแม้ว 🐾" พร้อมใช้งานบนหน้าจอหลักมือถือของคุณแล้วครับ!',
    timer: 2000,
    showConfirmButton: false
  });
});

function downloadWindowsShortcut(targetType = 'admin') {
  const isCustomer = (targetType === 'customer');
  const name = isCustomer ? 'ร้านขนมแม้ว' : 'แอดมินร้านขนมแม้ว';
  const targetUrl = isCustomer ? window.location.origin : `${window.location.origin}/admin`;
  
  // Create an HTML launcher that Windows and Chrome natively open directly into the browser
  const htmlContent = `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <title>${isCustomer ? 'ร้านขนมแม้ว 🐾' : 'แอดมินร้านขนมแม้ว 🐾'}</title>
  <meta http-equiv="refresh" content="0; url=${targetUrl}">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; text-align: center; }
    .card { background: #1e293b; padding: 2rem; border-radius: 1rem; box-shadow: 0 10px 25px rgba(0,0,0,0.5); border: 1px solid #334155; max-width: 400px; }
    h2 { margin: 0 0 0.5rem 0; color: #f97316; }
    p { color: #94a3b8; font-size: 14px; margin-bottom: 1rem; }
    a { color: #38bdf8; font-weight: bold; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🐾 ${isCustomer ? 'ร้านขนมแม้ว' : 'แอดมินร้านขนมแม้ว'}</h2>
    <p>กำลังเปิดระบบ กรุณารอสักครู่...</p>
    <a href="${targetUrl}">คลิกที่นี่หากเบราว์เซอร์ไม่เปิดอัตโนมัติ</a>
  </div>
  <script>
    window.location.replace("${targetUrl}");
  </script>
</body>
</html>`;

  const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);

  Swal.fire({
    icon: 'success',
    title: 'ดาวน์โหลดไฟล์ทางลัดสำเร็จ! 💻',
    html: `
      <div class="text-left text-xs sm:text-sm space-y-2 text-slate-700">
        <p>ดาวน์โหลดไฟล์ <b>${name}.html</b> เรียบร้อยแล้ว</p>
        <div class="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-emerald-900 font-medium">
          ✨ ดับเบิลคลิกที่ไฟล์นี้เพื่อเปิดระบบได้ทันที และสามารถลากไปวางบน <b>Desktop ของ Windows</b> เป็นทางลัดได้เลยครับ!
        </div>
      </div>
    `,
    confirmButtonColor: '#ea580c',
    confirmButtonText: 'ตกลง'
  });
}

async function triggerPwaInstall(platform = 'windows') {
  if (deferredAdminPwaPrompt) {
    deferredAdminPwaPrompt.prompt();
    const { outcome } = await deferredAdminPwaPrompt.userChoice;
    if (outcome === 'accepted') {
      Swal.fire({
        icon: 'success',
        title: 'กำลังติดตั้ง... 🎉',
        text: 'ระบบกำลังเพิ่มไอคอน "แอดมินแม้ว 🐾" ลงในเครื่องของคุณ',
        timer: 1800,
        showConfirmButton: false
      });
    }
    deferredAdminPwaPrompt = null;
    return;
  }

  // Windows Desktop Install Guide & Download Shortcut
  if (platform === 'windows') {
    Swal.fire({
      title: '💻 ติดตั้งแอป Admin บน Windows',
      html: `
        <div class="text-left text-xs sm:text-sm space-y-3.5 text-slate-700">
          <p class="font-bold text-slate-900">
            ใช้งานเป็นแอปเดสก์ท็อปบน Windows เต็มจอ สะดวก รวดเร็ว ไม่มีแถบเบราว์เซอร์:
          </p>

          <div class="bg-blue-50/80 border border-blue-200 rounded-2xl p-3.5 space-y-2.5 text-blue-950 font-medium">
            <div class="flex items-start gap-2.5">
              <span class="w-5 h-5 rounded-full bg-blue-200 text-blue-900 font-bold flex items-center justify-center text-xs shrink-0 mt-0.5">1</span>
              <span>ใน Google Chrome หรือ Microsoft Edge ให้สังเกตที่ <b>แถบ URL ด้านขวาบน</b> จะมีไอคอน <b>⊕ (Install App / ติดตั้งแอป)</b></span>
            </div>
            <div class="flex items-start gap-2.5">
              <span class="w-5 h-5 rounded-full bg-blue-200 text-blue-900 font-bold flex items-center justify-center text-xs shrink-0 mt-0.5">2</span>
              <span>คลิก <b>"ติดตั้ง" (Install)</b> ระบบจะสร้างไอคอน <b>"แอดมินแม้ว 🐾"</b> บน Windows Desktop และ Start Menu ทันที</span>
            </div>
          </div>

          <div class="pt-2 text-center">
            <p class="text-xs text-slate-500 mb-2">หรือดาวน์โหลดไฟล์ทางลัดไปไว้บนหน้าจอ Desktop ได้เลย:</p>
            <button
              type="button"
              onclick="downloadWindowsShortcut('admin')"
              class="inline-flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white font-bold py-2.5 px-4 rounded-xl text-xs shadow-md transition cursor-pointer active:scale-95"
            >
              <span>📥 ดาวน์โหลดทางลัดสำหรับ Windows (ดับเบิลคลิกเปิดได้ทันที)</span>
            </button>
          </div>
        </div>
      `,
      icon: 'info',
      confirmButtonText: 'ปิดหน้าต่าง',
      confirmButtonColor: '#ea580c'
    });
    return;
  }

  // Android Mobile Install Guide
  Swal.fire({
    title: '📲 วิธีติดตั้งแอป Admin บนมือถือ Android',
    html: `
      <div class="text-left text-xs sm:text-sm space-y-3 text-slate-700">
        <p class="font-bold text-slate-800">
          ติดตั้งเป็นแอปแท้ลงบนหน้าจอมือถือได้ทันที โดยไม่ต้องโหลดผ่าน Google Play:
        </p>
        <div class="bg-amber-50/80 border border-amber-200 rounded-2xl p-3.5 space-y-2 text-amber-950 font-medium">
          <div class="flex items-start gap-2">
            <span class="w-5 h-5 rounded-full bg-amber-200 text-amber-900 font-bold flex items-center justify-center text-xs shrink-0 mt-0.5">1</span>
            <span>แตะที่ <b>ปุ่มจุด 3 จุด (⋮)</b> ที่มุมขวาบนของเบราว์เซอร์ Google Chrome</span>
          </div>
          <div class="flex items-start gap-2">
            <span class="w-5 h-5 rounded-full bg-amber-200 text-amber-900 font-bold flex items-center justify-center text-xs shrink-0 mt-0.5">2</span>
            <span>เลือกเมนู <b>"ติดตั้งแอป" (Install app)</b> หรือ <b>"เพิ่มลงในหน้าจอหลัก" (Add to Home screen)</b></span>
          </div>
          <div class="flex items-start gap-2">
            <span class="w-5 h-5 rounded-full bg-amber-200 text-amber-900 font-bold flex items-center justify-center text-xs shrink-0 mt-0.5">3</span>
            <span>แตะยืนยัน <b>"ติดตั้ง" (Install)</b></span>
          </div>
        </div>
        <div class="bg-emerald-50 border border-emerald-200 rounded-xl p-2.5 text-center text-emerald-800 text-xs font-bold">
          ✨ ไอคอนสีเข้ม "แอดมินแม้ว 🐾" จะปรากฏบนหน้าจอมือถือ เปิดใช้งานได้เต็มจอ ไม่มีแถบเว็บกวนใจ!
        </div>
      </div>
    `,
    icon: 'info',
    confirmButtonText: 'รับทราบวิธีติดตั้ง',
    confirmButtonColor: '#ea580c'
  });
}

function toggleInputVisibility(inputId) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.type = (el.type === 'password') ? 'text' : 'password';
  if (window.lucide) lucide.createIcons();
}

// ==========================================
// ADMIN PIN CHANGE HANDLER
// ==========================================
async function handleChangeAdminPin() {
  const currentPinInput = document.getElementById('adminCurrentPinInput');
  const newPinInput = document.getElementById('adminNewPinInput');
  const confirmPinInput = document.getElementById('adminConfirmPinInput');
  const btn = document.getElementById('adminChangePinBtn');

  let currentPin = currentPinInput ? currentPinInput.value.trim() : '';
  const newPin = newPinInput ? newPinInput.value.trim() : '';
  const confirmPin = confirmPinInput ? confirmPinInput.value.trim() : '';

  if (!currentPin) {
    currentPin = adminPin || '0958174540';
  }

  if (!newPin) {
    Swal.fire({
      icon: 'warning',
      title: 'กรุณากรอกรหัส PIN ใหม่',
      text: 'รหัส PIN ใหม่ต้องมีความยาวอย่างน้อย 4 ตัวอักษรหรือตัวเลข',
      confirmButtonColor: '#ea580c'
    });
    return;
  }

  if (newPin.length < 4 || newPin.length > 20) {
    Swal.fire({
      icon: 'warning',
      title: 'ความยาวรหัส PIN ไม่ถูกต้อง',
      text: 'รหัส PIN ใหม่ต้องมีความยาว 4 - 20 ตัวอักษรหรือตัวเลข',
      confirmButtonColor: '#ea580c'
    });
    return;
  }

  if (newPin !== confirmPin) {
    Swal.fire({
      icon: 'error',
      title: 'รหัส PIN ใหม่ไม่ตรงกัน',
      text: 'กรุณากรอกรหัส PIN ใหม่และยืนยันรหัส PIN ให้ตรงกัน',
      confirmButtonColor: '#ea580c'
    });
    return;
  }

  const result = await Swal.fire({
    title: 'ยืนยันการเปลี่ยนรหัส PIN หรือไม่?',
    html: `คุณกำลังจะเปลี่ยนรหัส PIN แอดมินเป็น: <b class="text-orange-600 font-mono text-lg">${newPin}</b><br><span class="text-xs text-slate-500">กรุณาจดจำรหัสใหม่นี้ไว้สำหรับเข้าสู่ระบบในครั้งต่อไป</span>`,
    icon: 'question',
    showCancelButton: true,
    confirmButtonText: 'ยืนยันเปลี่ยนรหัส',
    cancelButtonText: 'ยกเลิก',
    confirmButtonColor: '#0f172a',
    cancelButtonColor: '#94a3b8'
  });

  if (!result.isConfirmed) return;

  if (btn) btn.disabled = true;

  try {
    const res = await adminFetch('/api/admin/change-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPin, newPin })
    });
    const data = await res.json();

    if (data.success) {
      // Update local memory PIN so the active session is uninterrupted
      adminPin = newPin;

      // Clear input fields
      if (currentPinInput) currentPinInput.value = '';
      if (newPinInput) newPinInput.value = '';
      if (confirmPinInput) confirmPinInput.value = '';

      Swal.fire({
        icon: 'success',
        title: 'เปลี่ยนรหัส PIN สำเร็จ 🎉',
        html: `รหัส PIN ใหม่ของคุณคือ: <b class="text-emerald-700 font-mono text-lg">${newPin}</b><br><p class="text-xs text-slate-500 mt-2">ระบบบันทึกรหัสใหม่ลงฐานข้อมูลเรียบร้อยแล้ว ในการเข้าใช้งานครั้งถัดไปให้ใช้รหัสใหม่นี้ครับ</p>`,
        confirmButtonColor: '#10b981'
      });
    } else {
      Swal.fire({
        icon: 'error',
        title: 'เปลี่ยนรหัสไม่สำเร็จ',
        text: data.error || 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง',
        confirmButtonColor: '#ea580c'
      });
    }
  } catch (err) {
    console.error('Change PIN error:', err);
    Swal.fire({
      icon: 'error',
      title: 'เกิดข้อผิดพลาด',
      text: err.message || 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้',
      confirmButtonColor: '#ea580c'
    });
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ==========================================
// GEMINI AI API KEY MANAGEMENT & TEST
// ==========================================
function updateGeminiKeyBadge(keys) {
  const badge = document.getElementById('geminiKeyStatusBadge');
  if (!badge) return;
  const count = (keys || '').split(',').map(k => k.trim()).filter(Boolean).length;
  if (count > 0) {
    badge.className = 'text-[10px] bg-emerald-100 text-emerald-800 font-bold px-2 py-0.5 rounded-full border border-emerald-200';
    badge.innerText = `🟢 จำคีย์ในระบบแล้ว (${count} คีย์พร้อมใช้งาน)`;
  } else {
    badge.className = 'text-[10px] bg-amber-100 text-amber-800 font-bold px-2 py-0.5 rounded-full border border-amber-200';
    badge.innerText = '⚠️ ยังไม่มีคีย์ในระบบ';
  }
}

async function testGeminiApiKey() {
  const geminiEl = document.getElementById('settingGeminiKeys');
  const btn = document.getElementById('btnTestGeminiKey');
  const apiKey = geminiEl ? geminiEl.value.trim() : '';

  if (!apiKey) {
    Swal.fire({
      icon: 'warning',
      title: 'กรุณากรอกคีย์ก่อนทดสอบ',
      text: 'กรุณาวาง Gemini API Key ในช่องก่อนกดปุ่มทดสอบ',
      confirmButtonColor: '#ea580c'
    });
    return;
  }

  const origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ กำลังทดสอบ...</span>';
  }

  try {
    const res = await adminFetch('/api/admin/test-gemini-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey })
    });
    const data = await res.json();

    if (data.success) {
      try { localStorage.setItem('cached_gemini_api_keys', apiKey); } catch (e) {}
      updateGeminiKeyBadge(apiKey);

      Swal.fire({
        icon: 'success',
        title: 'คีย์ AI ใช้งานได้สมบูรณ์ 🎉',
        html: `<div class="text-xs sm:text-sm text-slate-700 text-left space-y-2">
          <p>✅ <b>เชื่อมต่อกับ Google Gemini สำเร็จ 100%</b></p>
          <p>🤖 ระบบพร้อมใช้งานสำหรับตรวจสลิปโอนเงินอัตโนมัติแล้ว</p>
          <p class="text-slate-500 font-mono text-[11px] bg-slate-50 p-2 rounded-lg border border-slate-200">สถานะ: ${data.message}</p>
        </div>`,
        confirmButtonColor: '#10b981'
      });
    } else {
      Swal.fire({
        icon: 'error',
        title: 'การเชื่อมต่อไม่สำเร็จ',
        html: `<div class="text-xs sm:text-sm text-red-600 text-left">${data.error || 'คีย์ไม่ถูกต้อง หรือไม่มีสิทธิ์ใช้งาน'}</div>`,
        confirmButtonColor: '#ea580c'
      });
    }
  } catch (err) {
    Swal.fire({
      icon: 'error',
      title: 'เกิดข้อผิดพลาดในการทดสอบ',
      text: err.message || 'ไม่สามารถติดต่อเซิร์ฟเวอร์ได้',
      confirmButtonColor: '#ea580c'
    });
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }
}

async function saveGeminiApiKeysOnly() {
  const geminiEl = document.getElementById('settingGeminiKeys');
  const btn = document.getElementById('btnSaveGeminiKeyOnly');
  const geminiApiKeys = geminiEl ? geminiEl.value.trim() : '';

  if (!geminiApiKeys) {
    Swal.fire({
      icon: 'warning',
      title: 'กรุณากรอกคีย์ Gemini API',
      text: 'ไม่สามารถบันทึกค่าว่างได้',
      confirmButtonColor: '#ea580c'
    });
    return;
  }

  if (btn) btn.disabled = true;

  try {
    const res = await adminFetch('/api/admin/save-gemini-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ geminiApiKeys })
    });
    const data = await res.json();

    if (data.success) {
      try { localStorage.setItem('cached_gemini_api_keys', geminiApiKeys); } catch (e) {}
      updateGeminiKeyBadge(geminiApiKeys);

      Swal.fire({
        icon: 'success',
        title: 'บันทึกคีย์ AI สำเร็จ 🎉',
        text: 'ระบบได้จดจำคีย์ Gemini API ลงฐานข้อมูลและเบราว์เซอร์เรียบร้อยแล้ว ไม่ลืมแน่นอนครับ',
        confirmButtonColor: '#10b981'
      });
    } else {
      Swal.fire({
        icon: 'error',
        title: 'บันทึกไม่สำเร็จ',
        text: data.error || 'เกิดข้อผิดพลาดในการบันทึก',
        confirmButtonColor: '#ea580c'
      });
    }
  } catch (err) {
    Swal.fire({
      icon: 'error',
      title: 'เกิดข้อผิดพลาด',
      text: err.message || 'ไม่สามารถติดต่อเซิร์ฟเวอร์ได้',
      confirmButtonColor: '#ea580c'
    });
  } finally {
    if (btn) btn.disabled = false;
  }
}

