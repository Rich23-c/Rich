// State (No permanent storage: requires entering PIN every time the page is opened)
try {
  localStorage.removeItem('admin_pin_token');
  sessionStorage.removeItem('admin_pin_token');
} catch (e) {}

let adminPin = '';
let currentTab = 'snacks';
let allOrders = [];
let allAdminSnacks = [];
let currentActiveOrderId = null;

// Initialize on DOM Ready: ALWAYS show login prompt
document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) lucide.createIcons();
  showLoginOverlay();

  // Auto-refresh orders every 8 seconds when authenticated
  setInterval(() => {
    if (adminPin && currentTab === 'orders') {
      loadAdminOrders(false);
    }
  }, 8000);
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
    return !!(data && data.success);
  } catch (err) {
    return false;
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
  if (input.value.length < 10) {
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
      err.innerText = 'กรุณากรอกรหัสผ่าน PIN 6 หลักก่อนเข้าใช้งาน';
      err.classList.remove('hidden');
    }
    return;
  }

  if (btn) btn.disabled = true;

  try {
    const isValid = await verifyPinWithServer(enteredPin);
    if (isValid) {
      adminPin = enteredPin;
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
      if (err) {
        err.innerText = '❌ รหัสผ่าน PIN ไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง';
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
  showLoginOverlay();
}

// Helper for authenticated requests
async function adminFetch(url, options = {}) {
  const headers = options.headers || {};
  headers['x-admin-pin'] = adminPin || '';
  options.headers = headers;

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
    loadAdminSettings()
  ]);
}

// Switch navigation tabs
function switchTab(tab) {
  currentTab = tab;
  ['snacks', 'orders', 'settings'].forEach(t => {
    const btn = document.getElementById(`tabBtn-${t}`);
    const content = document.getElementById(`tabContent-${t}`);
    if (t === tab) {
      btn.className = 'tab-btn px-4 py-3 text-xs sm:text-sm font-bold border-b-2 border-orange-600 text-orange-600 flex items-center gap-2 transition whitespace-nowrap';
      content.classList.remove('hidden');
    } else {
      btn.className = 'tab-btn px-4 py-3 text-xs sm:text-sm font-semibold border-b-2 border-transparent text-slate-500 hover:text-slate-800 flex items-center gap-2 transition whitespace-nowrap';
      content.classList.add('hidden');
    }
  });

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
    return o.orderStatus === 'verified' || o.orderStatus === 'preparing' || o.orderStatus === 'delivered';
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
    const res = await adminFetch('/api/admin/orders');
    const data = await res.json();
    if (data.success && data.data) {
      allOrders = data.data;
      updateStats();
      renderOrdersTable();
    }
  } catch (err) {
    console.error('Failed to load orders:', err);
  }
}

function renderOrdersTable() {
  const tbody = document.getElementById('ordersTableBody');
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
    if (order.slipImage) {
      slipHtml = `
        <div class="relative group inline-block cursor-pointer" onclick="openSlipDetailModal('${order.id}')" title="กดดูสลิปขนาดใหญ่">
          <img src="${order.slipImage}" class="w-12 h-14 object-cover rounded-xl border border-slate-300 shadow-xs hover:scale-105 transition" />
          <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 rounded-xl flex items-center justify-center text-white transition">
            <i data-lucide="zoom-in" class="w-4 h-4"></i>
          </div>
        </div>
      `;
    }

    // AI Verification badge
    let verifyBadge = '';
    const v = order.slipVerification;
    if (v) {
      if (v.isDuplicateSlip) {
        verifyBadge = `
          <div class="inline-flex flex-col items-center">
            <span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-red-100 text-red-800 border border-red-200">
              🚨 สลิปซ้ำ
            </span>
            <span class="text-[10px] text-red-600 mt-0.5 font-medium">เคยถูกใช้แล้ว</span>
          </div>
        `;
      } else if (v.isReadyToSave || v.status === 'VALID_AND_MATCHED' || v.isAmountMatched) {
        verifyBadge = `
          <div class="inline-flex flex-col items-center">
            <span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
              ✓ ยอดตรง ${order.totalPrice}฿
            </span>
            <span class="text-[10px] text-emerald-600 mt-0.5 font-medium">${v.transferDate || 'วันนี้'} &bull; ${v.bankName || 'สลิปถูกต้อง'}</span>
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
        <div class="font-mono font-bold text-orange-600 text-xs">${order.id}</div>
        <div class="text-[11px] text-slate-400 mt-0.5">${dateStr}</div>
      </td>
      <td class="p-3.5">
        <div class="font-bold text-slate-900 text-xs">${order.customerName}</div>
        <div class="text-[11px] text-slate-500">${order.customerPhone || 'ไม่ระบุเบอร์'}</div>
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
  const mobileContainer = document.getElementById('adminOrdersMobileCards');
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
        if (order.slipImage) {
          slipThumbHtml = `
            <button type="button" onclick="openSlipDetailModal('${order.id}')" class="flex items-center gap-2 bg-slate-50 hover:bg-slate-100 p-1.5 pr-3 rounded-xl border border-slate-200 transition text-left cursor-pointer active:scale-98">
              <img src="${order.slipImage}" class="w-10 h-12 object-cover rounded-lg border border-slate-300" />
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
              <div class="font-mono font-bold text-orange-600 text-xs">${order.id}</div>
              <div class="text-[10px] text-slate-400 mt-0.5">${dateStr}</div>
            </div>
            <div>${statusBadge}</div>
          </div>

          <!-- Customer info -->
          <div class="flex items-center justify-between text-xs">
            <div>
              <span class="text-slate-400 text-[10px]">ลูกค้า:</span>
              <span class="font-bold text-slate-800 ml-1">${order.customerName}</span>
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
  document.getElementById('slipModalOrderSub').innerText = `ออเดอร์: ${order.id} | ลูกค้า: ${order.customerName} (${order.customerPhone || 'ไม่มีเบอร์'})`;
  document.getElementById('slipModalImg').src = order.slipImage || '';
  document.getElementById('slipModalExpected').innerText = `${order.totalPrice.toFixed(2)} บาท`;

  const { cost: orderCost, profit: orderProfit, marginPercent: orderMargin } = getOrderCostAndProfit(order);
  const costEl = document.getElementById('slipModalCost');
  if (costEl) costEl.innerText = `${orderCost.toFixed(2)} บาท`;
  const profitEl = document.getElementById('slipModalProfit');
  if (profitEl) {
    profitEl.innerHTML = `<span class="${orderProfit >= 0 ? 'text-emerald-700' : 'text-rose-600'}">${orderProfit >= 0 ? '+' : ''}${orderProfit.toFixed(2)} บาท (${orderMargin}%)</span>`;
  }

  const v = order.slipVerification || {};
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

  const banner = document.getElementById('slipModalStatusBanner');
  if (order.orderStatus === 'pending') {
    banner.className = 'p-3 rounded-2xl border font-bold text-xs bg-amber-50 text-amber-800 border-amber-200';
    banner.innerText = '⏳ รอยืนยันสลิป: กรุณาตรวจสอบรูปสลิปเทียบกับยอดสั่งซื้อ แล้วกดปุ่ม "✅ ยืนยันสลิปถูกต้อง" ด้านล่าง';
  } else if (order.orderStatus === 'verified') {
    banner.className = 'p-3 rounded-2xl border font-bold text-xs bg-emerald-50 text-emerald-800 border-emerald-200';
    banner.innerText = '✅ สลิปได้รับการยืนยันแล้ว: ยอดเงินและสลิปถูกต้อง';
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

      // Update UI for store status in header and settings tab
      updateStoreStatusUi(s.isOpen);

    }
  } catch (err) {
    console.error('Failed to load settings:', err);
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
    closedMessage: document.getElementById('settingClosedMessage') ? document.getElementById('settingClosedMessage').value.trim() : ''
  };

  try {
    const res = await adminFetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    const data = await res.json();

    if (data.success) {
      Swal.fire({
        icon: 'success',
        title: 'บันทึกสำเร็จ 🎉',
        text: 'ข้อมูลรอบเปิดร้านและบัญชีถูกอัปเดตเรียบร้อยแล้ว',
        confirmButtonColor: '#f97316'
      });
    }
  } catch (err) {
    console.error('Save settings error:', err);
  }
}
