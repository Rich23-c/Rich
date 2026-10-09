// State
let allSnacks = [];
let selectedItems = {}; // { snackId: { id, name, price, unit, quantity, image } }
let shopSettings = {};
let currentSlipFile = null;
let currentSlipVerification = null;
let uploadedSlipUrl = null;
let qrDebounceTimeout = null;

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', async () => {
  if (window.lucide) lucide.createIcons();

  // Restore customer contact info from persistent storage
  const nameInput = document.getElementById('customerName');
  const phoneInput = document.getElementById('customerPhone');
  if (nameInput) {
    const savedName = localStorage.getItem('snack_maew_customer_name');
    if (savedName && !nameInput.value) nameInput.value = savedName;
    nameInput.addEventListener('input', e => {
      localStorage.setItem('snack_maew_customer_name', e.target.value.trim());
    });
  }
  if (phoneInput) {
    const savedPhone = localStorage.getItem('snack_maew_customer_phone');
    if (savedPhone && !phoneInput.value) phoneInput.value = savedPhone;
    phoneInput.addEventListener('input', e => {
      localStorage.setItem('snack_maew_customer_phone', e.target.value.trim());
    });
  }

  await loadShopSettings();
  await loadSnacks();

  setupDropZone();
  updateHistoryBadge();
  syncDeviceOrdersFromCloud();
});

// Load public shop settings
async function loadShopSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (data.success && data.data) {
      shopSettings = data.data;

      // Update UI with shop settings
      if (shopSettings.shopName) {
        document.getElementById('shopNameHeader').innerText = shopSettings.shopName;
        document.title = `${shopSettings.shopName} - สั่งขนมออนไลน์`;
      }
      if (shopSettings.shopSubtitle) {
        document.getElementById('shopSubtitleHeader').innerText = shopSettings.shopSubtitle;
      }
      if (shopSettings.shopAnnouncement) {
        document.getElementById('announcementText').innerText = shopSettings.shopAnnouncement;
      }
      if (shopSettings.bankName) {
        document.getElementById('bankNameDisplay').innerText = shopSettings.bankName;
      }
      if (shopSettings.bankAccountNumber) {
        document.getElementById('bankAccDisplay').innerText = shopSettings.bankAccountNumber;
      }
      if (shopSettings.promptpayName) {
        document.getElementById('bankAccNameDisplay').innerText = shopSettings.promptpayName;
      }
      const pIdEl = document.getElementById('promptpayIdDisplay');
      if (shopSettings.promptpayId && pIdEl) {
        pIdEl.innerText = shopSettings.promptpayId;
      }
      if (shopSettings.promptpayQrImage) {
        const qrImg = document.getElementById('promptpayQrImg');
        if (qrImg) qrImg.src = shopSettings.promptpayQrImage;
      }

      // Apply store open/closed status across the entire page
      const isStoreOpen = shopSettings.isOpen !== false;
      applyStoreOpenStatus(isStoreOpen);
    }
  } catch (err) {
    console.error('Failed to load shop settings:', err);
  }
}

// Function to control Store Open / Closed mode across the entire customer interface
function applyStoreOpenStatus(isOpen) {
  const noticeEl = document.getElementById('storeClosedNotice');
  const noticeText = document.getElementById('storeClosedNoticeText');
  const announcementBar = document.getElementById('announcementBar');
  const announcementText = document.getElementById('announcementText');
  const step1Section = document.getElementById('step1Section');
  const summarySection = document.getElementById('summarySection');
  const paymentSection = document.getElementById('paymentSection');
  const headerTotalBadge = document.getElementById('headerTotalBadge');

  if (!isOpen) {
    // 1. Show Big Closed Notice Banner
    if (noticeEl) {
      noticeEl.classList.remove('hidden');
      if (noticeText) {
        noticeText.innerText = (shopSettings && shopSettings.closedMessage) || 'ขณะนี้ร้านปิดรับออเดอร์ชั่วคราว แล้วพบกันใหม่รอบหน้านะจ๊ะ 🐱';
      }
    }

    // 2. Set Announcement bar to red
    if (announcementBar) {
      announcementBar.className = 'bg-gradient-to-r from-red-600 via-rose-600 to-red-700 text-white text-xs sm:text-sm py-2 px-4 text-center font-bold shadow-sm flex items-center justify-center gap-2';
      if (announcementText) {
        announcementText.innerText = `🔴 ขณะนี้ร้านปิดรับออเดอร์ชั่วคราว: ${(shopSettings && shopSettings.closedMessage) || 'แล้วพบกันใหม่รอบหน้านะจ๊ะ 🐱'}`;
      }
    }

    // 3. Disable ordering sections
    if (step1Section) step1Section.classList.add('opacity-50', 'pointer-events-none');
    if (summarySection) summarySection.classList.add('opacity-50', 'pointer-events-none');
    if (paymentSection) paymentSection.classList.add('hidden');

    // 4. Reset Cart
    selectedItems = {};
    if (headerTotalBadge) {
      headerTotalBadge.innerText = 'ร้านปิด';
      headerTotalBadge.className = 'bg-slate-400 text-white text-[11px] sm:text-xs px-2 py-0.5 rounded-full font-bold';
    }

    // 5. Re-render snacks with locked controls if loaded
    if (allSnacks && allSnacks.length > 0) {
      renderSnacksGrid();
    }
  } else {
    // Store is OPEN!
    if (noticeEl) noticeEl.classList.add('hidden');

    if (announcementBar) {
      announcementBar.className = 'bg-gradient-to-r from-amber-500 via-orange-500 to-amber-600 text-white text-sm py-2 px-4 text-center font-medium shadow-sm flex items-center justify-center gap-2';
      if (announcementText) {
        announcementText.innerText = (shopSettings && shopSettings.shopAnnouncement) || '🎉 ยินดีต้อนรับสู่ร้านขนมแม้ว!';
      }
    }

    if (step1Section) step1Section.classList.remove('opacity-50', 'pointer-events-none');
    if (summarySection) summarySection.classList.remove('opacity-50', 'pointer-events-none');
    if (paymentSection) paymentSection.classList.remove('hidden');

    if (headerTotalBadge) {
      headerTotalBadge.className = 'bg-orange-600 text-white text-[11px] sm:text-xs px-2 py-0.5 rounded-full font-bold';
      updateTotal();
    }

    if (allSnacks && allSnacks.length > 0) {
      renderSnacksGrid();
    }
  }

  if (window.lucide) lucide.createIcons();
}

// Load snacks catalog
async function loadSnacks() {
  const container = document.getElementById('snacksGrid');
  try {
    const res = await fetch('/api/snacks');
    const data = await res.json();

    if (!data.success || !data.data || data.data.length === 0) {
      container.innerHTML = `
        <div class="col-span-full py-12 text-center text-slate-400">
          <p>ขณะนี้ยังไม่มีรายการขนมที่พร้อมจำหน่าย</p>
        </div>
      `;
      return;
    }

    allSnacks = data.data;
    renderSnacksGrid();
  } catch (err) {
    console.error('Failed to load snacks:', err);
    container.innerHTML = `
      <div class="col-span-full py-8 text-center text-red-500">
        <p>เกิดข้อผิดพลาดในการโหลดเมนูขนม กรุณารีเฟรชหน้านี้ใหม่</p>
      </div>
    `;
  }
}

// Render snacks cards with checkbox and quantity controls
function renderSnacksGrid() {
  const container = document.getElementById('snacksGrid');
  container.innerHTML = '';

  const isStoreOpen = !shopSettings || shopSettings.isOpen !== false;

  allSnacks.forEach(snack => {
    const isSnackAvailable = isStoreOpen && (snack.isAvailable !== false);
    const isSelected = isStoreOpen && !!selectedItems[snack.id];
    const qty = isSelected ? selectedItems[snack.id].quantity : 1;
    const subtotal = snack.price * qty;

    const card = document.createElement('div');
    card.id = `snack-card-${snack.id}`;
    card.className = `snack-card bg-white rounded-2xl p-4 sm:p-5 border ${
      !isStoreOpen
        ? 'border-stone-200 bg-stone-50/70 shadow-2xs opacity-75'
        : (!isSnackAvailable
          ? 'border-stone-200 bg-stone-50/70 shadow-2xs opacity-75'
          : (isSelected ? 'border-stone-900 bg-stone-50/20 shadow-sm ring-1 ring-stone-900' : 'border-stone-200/90 shadow-[0_1px_3px_rgba(0,0,0,0.02)]')
        )
    } flex flex-col justify-between transition-all`;

    // Fallback delicious image if empty
    const imgSrc = snack.image || 'https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=500&auto=format&fit=crop&q=80';

    let overlayBadge = '';
    if (!isStoreOpen) {
      overlayBadge = `
        <div class="absolute inset-0 bg-black/40 backdrop-blur-[1px] flex items-center justify-center rounded-xl">
          <span class="bg-stone-900 text-white text-xs font-medium px-3 py-1 rounded-full shadow-sm flex items-center gap-1">
            <i data-lucide="lock" class="w-3 h-3"></i> ปิดรับการสั่งซื้อ
          </span>
        </div>
      `;
    } else if (snack.isAvailable === false) {
      overlayBadge = `
        <div class="absolute inset-0 bg-black/40 backdrop-blur-[1px] flex items-center justify-center rounded-xl">
          <span class="bg-stone-800 text-white text-xs font-medium px-3 py-1 rounded-full shadow-sm flex items-center gap-1">
            <i data-lucide="pause-circle" class="w-3 h-3"></i> สินค้าหมดชั่วคราว
          </span>
        </div>
      `;
    }

    let actionAreaHtml = '';
    if (!isStoreOpen) {
      actionAreaHtml = `
        <div class="pt-3 border-t border-stone-100">
          <div class="flex items-center justify-center gap-2 text-stone-500 bg-stone-50 py-2 px-3 rounded-xl text-xs font-normal select-none border border-stone-200">
            <span class="w-1.5 h-1.5 rounded-full bg-stone-400"></span>
            <span>ขณะนี้ร้านปิดรับการสั่งซื้อ</span>
          </div>
        </div>
      `;
    } else if (snack.isAvailable === false) {
      actionAreaHtml = `
        <div class="pt-3 border-t border-stone-100">
          <div class="flex items-center justify-center gap-2 text-stone-600 bg-stone-50 py-2 px-3 rounded-xl text-xs font-normal select-none border border-stone-200">
            <span class="w-1.5 h-1.5 rounded-full bg-stone-400"></span>
            <span>เมนูนี้หมดชั่วคราว</span>
          </div>
        </div>
      `;
    } else {
      actionAreaHtml = `
        <div class="pt-3 border-t border-stone-100 space-y-2.5">
          <!-- Checkbox Selection -->
          <label class="flex items-center gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              id="checkbox-${snack.id}"
              class="w-4 h-4 text-stone-900 rounded border-stone-300 focus:ring-stone-900 cursor-pointer accent-stone-900"
              ${isSelected ? 'checked' : ''}
              onchange="toggleSnackSelection('${snack.id}', this.checked)"
            />
            <span class="text-xs font-medium ${isSelected ? 'text-stone-900' : 'text-stone-600'}">
              ${isSelected ? '✓ เลือกเมนูนี้แล้ว' : 'ติ๊กเลือกเมนูนี้'}
            </span>
          </label>

          <!-- Quantity Controls -->
          <div id="qty-container-${snack.id}" class="${isSelected ? 'flex' : 'hidden'} items-center justify-between bg-stone-50 p-2 rounded-xl border border-stone-200">
            <span class="text-xs font-normal text-stone-600 pl-1">จำนวน (${snack.unit || 'ชิ้น'}):</span>
            <div class="flex items-center gap-1.5">
              <button
                type="button"
                onclick="updateSnackQty('${snack.id}', -1)"
                class="qty-btn w-7 h-7 rounded-lg bg-white hover:bg-stone-200 active:bg-stone-300 text-stone-800 font-semibold text-sm flex items-center justify-center transition border border-stone-200 active:scale-95 touch-manipulation cursor-pointer"
                aria-label="ลดจำนวน"
              >-</button>
              <input
                type="number"
                min="1"
                max="999"
                value="${qty}"
                id="qty-input-${snack.id}"
                onchange="setSnackQty('${snack.id}', this.value)"
                class="w-12 text-center text-sm font-semibold text-stone-900 focus:outline-none bg-transparent py-0.5"
              />
              <button
                type="button"
                onclick="updateSnackQty('${snack.id}', 1)"
                class="qty-btn w-7 h-7 rounded-lg bg-white hover:bg-stone-200 active:bg-stone-300 text-stone-800 font-semibold text-sm flex items-center justify-center transition border border-stone-200 active:scale-95 touch-manipulation cursor-pointer"
                aria-label="เพิ่มจำนวน"
              >+</button>
            </div>
          </div>

          <!-- Card Subtotal -->
          <div id="subtotal-${snack.id}" class="${isSelected ? 'flex' : 'hidden'} justify-between items-center text-xs text-stone-600 px-1">
            <span>ราคารวมเมนูนี้:</span>
            <span class="font-semibold text-stone-900">${subtotal.toLocaleString()} บาท</span>
          </div>
        </div>
      `;
    }

    card.innerHTML = `
      <div>
        <!-- Snack Image -->
        <div class="relative w-full h-44 rounded-xl overflow-hidden mb-3 bg-stone-100 group">
          <img
            src="${imgSrc}"
            alt="${snack.name}"
            class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-102"
            onerror="this.src='https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=500&auto=format&fit=crop&q=80'"
          />
          <div class="absolute top-2.5 right-2.5 bg-stone-900/85 text-white backdrop-blur-md px-2.5 py-0.5 rounded-full text-xs font-medium">
            ${snack.price} ฿ / ${snack.unit || 'ชิ้น'}
          </div>
          ${overlayBadge}
        </div>

        <!-- Title & Description -->
        <h4 class="font-medium text-stone-900 text-base leading-snug font-heading mb-1">
          ${snack.name}
        </h4>
        <p class="text-xs text-stone-500 line-clamp-2 mb-3 font-normal">
          ${snack.description || 'ขนมโฮมเมดแสนอร่อย ปรุงสดใหม่จากเตา'}
        </p>
      </div>

      <!-- Action Area -->
      ${actionAreaHtml}
    `;

    container.appendChild(card);
  });

  if (window.lucide) lucide.createIcons();
}

// Toggle selection checkbox
function toggleSnackSelection(snackId, isChecked) {
  if (shopSettings && shopSettings.isOpen === false) {
    Swal.fire({
      icon: 'info',
      title: 'ขณะนี้ร้านปิดรับการสั่งซื้อ',
      text: shopSettings.closedMessage || 'แล้วพบกันใหม่รอบหน้านะจ๊ะ 🐱',
      confirmButtonColor: '#f97316'
    });
    return;
  }
  const snack = allSnacks.find(s => s.id === snackId);
  if (!snack) return;

  if (isChecked) {
    selectedItems[snackId] = {
      snackId: snack.id,
      name: snack.name,
      price: snack.price,
      unit: snack.unit || 'ชิ้น',
      quantity: 1,
      image: snack.image
    };
  } else {
    delete selectedItems[snackId];
  }

  updateCardUI(snackId);
  updateOrderSummary();
}

// Update quantity by delta (+1 or -1)
function updateSnackQty(snackId, delta) {
  if (!selectedItems[snackId]) return;
  const current = selectedItems[snackId].quantity || 1;
  const newQty = Math.max(1, current + delta);
  selectedItems[snackId].quantity = newQty;

  const input = document.getElementById(`qty-input-${snackId}`);
  if (input) input.value = newQty;

  updateCardUI(snackId);
  updateOrderSummary();
}

// Direct quantity input change
function setSnackQty(snackId, val) {
  if (!selectedItems[snackId]) return;
  let newQty = parseInt(val) || 1;
  if (newQty < 1) newQty = 1;
  selectedItems[snackId].quantity = newQty;

  const input = document.getElementById(`qty-input-${snackId}`);
  if (input) input.value = newQty;

  updateCardUI(snackId);
  updateOrderSummary();
}

// Update individual card styling and subtotal
function updateCardUI(snackId) {
  const isSelected = !!selectedItems[snackId];
  const card = document.getElementById(`snack-card-${snackId}`);
  const qtyContainer = document.getElementById(`qty-container-${snackId}`);
  const subtotalEl = document.getElementById(`subtotal-${snackId}`);
  const checkbox = document.getElementById(`checkbox-${snackId}`);

  if (checkbox) checkbox.checked = isSelected;

  if (isSelected) {
    const item = selectedItems[snackId];
    const subtotal = item.price * item.quantity;
    if (card) {
      card.className = card.className.replace(/border-stone-200\/90|shadow-\[0_1px_3px_rgba\(0,0,0,0\.02\)\]|border-slate-200|shadow-xs/g, '').trim();
      card.classList.add('border-stone-900', 'bg-stone-50/20', 'shadow-sm', 'ring-1', 'ring-stone-900');
    }
    if (qtyContainer) qtyContainer.classList.remove('hidden');
    if (subtotalEl) {
      subtotalEl.classList.remove('hidden');
      subtotalEl.innerHTML = `<span>ราคารวมเมนูนี้:</span> <span class="font-semibold text-stone-900">${subtotal.toLocaleString()} บาท</span>`;
    }
  } else {
    if (card) {
      card.classList.remove('border-stone-900', 'bg-stone-50/20', 'shadow-sm', 'ring-1', 'ring-stone-900', 'border-orange-500', 'bg-amber-50/50', 'ring-2', 'ring-orange-500/20');
      card.classList.add('border-stone-200/90', 'shadow-[0_1px_3px_rgba(0,0,0,0.02)]');
    }
    if (qtyContainer) qtyContainer.classList.add('hidden');
    if (subtotalEl) subtotalEl.classList.add('hidden');
  }
}

// Calculate grand total and update summary table
function updateOrderSummary() {
  const items = Object.values(selectedItems);
  const countBadge = document.getElementById('selectedCountBadge');
  const summaryContainer = document.getElementById('summaryItemsContainer');
  const grandTotalDisplay = document.getElementById('grandTotalDisplay');
  const headerTotalBadge = document.getElementById('headerTotalBadge');
  const qrAmountDisplay = document.getElementById('qrAmountDisplay');

  let total = 0;
  items.forEach(item => {
    total += item.price * item.quantity;
  });

  if (countBadge) countBadge.innerText = items.length;
  if (grandTotalDisplay) grandTotalDisplay.innerText = total.toLocaleString();
  if (headerTotalBadge) headerTotalBadge.innerText = `${total.toLocaleString()} ฿`;
  if (qrAmountDisplay) qrAmountDisplay.innerText = total.toFixed(2);

  // Sync mobile floating cart bar
  const mobileFloatingBar = document.getElementById('mobileFloatingBar');
  const floatingCartCount = document.getElementById('floatingCartCount');
  const floatingCartTotal = document.getElementById('floatingCartTotal');
  if (floatingCartCount) floatingCartCount.innerText = items.length;
  if (floatingCartTotal) floatingCartTotal.innerText = total.toLocaleString();

  if (mobileFloatingBar) {
    if (items.length > 0) {
      mobileFloatingBar.classList.add('show');
    } else {
      mobileFloatingBar.classList.remove('show');
    }
  }

  // Render summary items breakdown
  if (items.length === 0) {
    summaryContainer.innerHTML = `
      <div class="p-8 text-center bg-stone-50/50 rounded-2xl border border-dashed border-stone-200 text-stone-400 space-y-2">
        <i data-lucide="shopping-cart" class="w-7 h-7 mx-auto text-stone-300"></i>
        <p class="text-xs sm:text-sm">ยังไม่ได้เลือกขนม กรุณาติ๊กเลือกขนมที่ต้องการด้านบน</p>
      </div>
    `;
  } else {
    let rowsHtml = items.map(item => `
      <div class="flex items-center justify-between p-3 bg-stone-50/80 rounded-xl border border-stone-200/80 hover:bg-stone-50 transition">
        <div class="flex items-center gap-3">
          <img src="${item.image || 'https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=200'}" class="w-10 h-10 rounded-lg object-cover border border-stone-200" />
          <div>
            <h5 class="font-medium text-stone-900 text-xs sm:text-sm">${item.name}</h5>
            <span class="text-[11px] text-stone-500">${item.price} บาท × ${item.quantity} ${item.unit}</span>
          </div>
        </div>
        <div class="text-right">
          <span class="font-semibold text-stone-900 text-xs sm:text-sm">${(item.price * item.quantity).toLocaleString()} บาท</span>
        </div>
      </div>
    `).join('');

    summaryContainer.innerHTML = rowsHtml;
  }

  if (window.lucide) lucide.createIcons();

  // Debounce PromptPay QR regeneration
  clearTimeout(qrDebounceTimeout);
  qrDebounceTimeout = setTimeout(() => {
    generatePromptPayQr(total);
  }, 400);

  // If a slip was already uploaded and total changed, prompt or re-verify
  if (currentSlipFile) {
    triggerSlipVerification();
  }
}

// Generate dynamic PromptPay QR code
async function generatePromptPayQr(amount) {
  const qrImg = document.getElementById('promptpayQrImg');
  const loadingOverlay = document.getElementById('qrLoadingOverlay');

  // If using custom uploaded QR image (e.g. TrueMoney QR), keep displaying it!
  if (shopSettings && shopSettings.promptpayQrImage) {
    qrImg.src = shopSettings.promptpayQrImage;
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
    return;
  }

  if (loadingOverlay) loadingOverlay.classList.remove('hidden');

  try {
    const res = await fetch(`/api/promptpay-qr?amount=${amount}`);
    const data = await res.json();
    if (data.success && data.qrDataUrl) {
      qrImg.src = data.qrDataUrl;
    }
  } catch (err) {
    console.error('Failed to generate PromptPay QR:', err);
  } finally {
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
  }
}

// Setup drag & drop for slip upload
function setupDropZone() {
  const dropZone = document.getElementById('slipDropZone');
  if (!dropZone) return;

  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, e => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('dropzone-active');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, e => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('dropzone-active');
    }, false);
  });

  dropZone.addEventListener('drop', e => {
    const dt = e.dataTransfer;
    const file = dt.files[0];
    if (file) {
      handleSlipSelected(file);
    }
  });
}

// Handle slip file selection -> Automatically verifies and saves order immediately!
function handleSlipSelected(file) {
  if (!file) return;

  if (shopSettings && shopSettings.isOpen === false) {
    Swal.fire({
      icon: 'warning',
      title: 'ขณะนี้ร้านปิดรับการสั่งซื้อ',
      text: shopSettings.closedMessage || 'ระบบปิดรับการสั่งซื้อและการชำระเงินชั่วคราว',
      confirmButtonColor: '#f97316'
    });
    return;
  }

  if (!file.type.startsWith('image/')) {
    Swal.fire({
      icon: 'warning',
      title: 'ไฟล์ไม่ถูกต้อง',
      text: 'กรุณาอัปโหลดไฟล์รูปภาพสลิปเท่านั้น (JPG, PNG, HEIC)',
      confirmButtonColor: '#f97316'
    });
    return;
  }

  // Pre-check 1: Customer Name
  const customerName = document.getElementById('customerName').value.trim();
  if (!customerName) {
    Swal.fire({
      icon: 'warning',
      title: 'กรุณาระบุชื่อลูกค้าก่อน',
      text: 'กรุณาใส่ชื่อของคุณในข้อ 1 ด้านบนก่อนแนบสลิปนะจ๊ะ 📝',
      confirmButtonColor: '#f97316'
    });
    document.getElementById('customerName').focus();
    removeSlip();
    return;
  }

  // Pre-check 2: Snacks Selection
  const items = Object.values(selectedItems);
  if (items.length === 0) {
    Swal.fire({
      icon: 'warning',
      title: 'ยังไม่ได้เลือกขนม',
      text: 'กรุณาติ๊กถูกเลือกขนมที่ต้องการอย่างน้อย 1 รายการก่อนแนบสลิปจ้า 🍪',
      confirmButtonColor: '#f97316'
    });
    removeSlip();
    return;
  }

  currentSlipFile = file;

  // Show preview thumbnail
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('slipPreviewImg').src = e.target.result;
    document.getElementById('slipFileName').innerText = file.name;
    document.getElementById('slipFileSize').innerText = `${(file.size / (1024 * 1024)).toFixed(2)} MB`;

    document.getElementById('slipDropZone').classList.add('hidden');
    document.getElementById('slipVerificationBox').classList.remove('hidden');

    // Reveal order confirmation button immediately!
    const confirmSection = document.getElementById('customerConfirmSection');
    if (confirmSection) confirmSection.classList.remove('hidden');
    const hintBanner = document.getElementById('slipHintBanner');
    if (hintBanner) hintBanner.classList.add('hidden');

    if (window.lucide) lucide.createIcons();

    // Trigger AI Slip Pre-Verification automatically!
    autoVerifySlip(file);
  };
  reader.readAsDataURL(file);
}

// Automatically pre-verify slip with AI and QR Code recognition
async function autoVerifySlip(file) {
  if (!file) return;

  const items = Object.values(selectedItems);
  const total = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);

  const loadingCard = document.getElementById('verifyingLoadingCard');
  const resultCard = document.getElementById('verificationResultCard');
  const reverifyBtn = document.getElementById('reverifyBtn');

  if (loadingCard) loadingCard.classList.remove('hidden');
  if (resultCard) resultCard.classList.add('hidden');
  if (reverifyBtn) reverifyBtn.disabled = true;

  try {
    const formData = new FormData();
    formData.append('slip', file);
    formData.append('expectedAmount', total);

    const res = await fetch('/api/verify-slip', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    if (data.success && data.verification) {
      currentSlipVerification = data.verification;
      uploadedSlipUrl = data.slipUrl;
      displayVerificationResult(data.verification, total);
    } else {
      currentSlipVerification = null;
      if (resultCard) {
        resultCard.classList.remove('hidden');
        const title = document.getElementById('verificationTitle');
        const summary = document.getElementById('verificationSummary');
        const iconContainer = document.getElementById('statusIconContainer');
        if (title) title.innerText = '⚠️ การตรวจสอบเบื้องต้นไม่สำเร็จ';
        if (summary) summary.innerText = data.error || 'ไม่สามารถวิเคราะห์ข้อมูลจากภาพสลิปได้ แต่คุณยังสามารถกดยืนยันออเดอร์เพื่อให้เจ้าของร้านตรวจเช็คได้';
        if (iconContainer) {
          iconContainer.className = 'w-8 h-8 rounded-full bg-amber-500 text-white flex items-center justify-center shrink-0 shadow-sm';
          iconContainer.innerHTML = '<i data-lucide="alert-circle" class="w-5 h-5"></i>';
        }
      }
    }
  } catch (err) {
    console.warn('Slip verification error:', err);
    if (resultCard) {
      resultCard.classList.remove('hidden');
      const title = document.getElementById('verificationTitle');
      const summary = document.getElementById('verificationSummary');
      if (title) title.innerText = '⚠️ ระบบตรวจสลิปขัดข้องชั่วคราว';
      if (summary) summary.innerText = 'คุณยังสามารถกดปุ่ม "ยืนยันการสั่งซื้อ" ได้ตามปกติ เจ้าของร้านจะทำการตรวจสลิปด้วยตนเองครับ';
    }
  } finally {
    if (loadingCard) loadingCard.classList.add('hidden');
    if (reverifyBtn) reverifyBtn.disabled = false;
    if (window.lucide) lucide.createIcons();
  }
}

// Manual re-verify button handler
function triggerSlipVerification() {
  if (currentSlipFile) {
    autoVerifySlip(currentSlipFile);
  }
}

// Customer confirms the order -> Save to database
async function confirmAndSaveOrder() {
  if (shopSettings && shopSettings.isOpen === false) {
    Swal.fire({
      icon: 'warning',
      title: 'ขณะนี้ร้านปิดรับการสั่งซื้อ',
      text: shopSettings.closedMessage || 'ระบบไม่เปิดรับออเดอร์ในขณะนี้ครับ',
      confirmButtonColor: '#f97316'
    });
    return;
  }

  const customerName = document.getElementById('customerName').value.trim();
  const customerPhone = document.getElementById('customerPhone').value.trim();
  const items = Object.values(selectedItems);
  const total = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);

  if (!customerName) {
    Swal.fire({
      icon: 'warning',
      title: 'กรุณาระบุชื่อลูกค้า',
      text: 'กรุณากรอกชื่อของคุณในช่องด้านบนก่อนยืนยันการสั่งซื้อครับ',
      confirmButtonColor: '#f97316'
    });
    return;
  }

  if (items.length === 0) {
    Swal.fire({
      icon: 'warning',
      title: 'ยังไม่ได้เลือกขนม',
      text: 'กรุณาเลือกขนมอย่างน้อย 1 รายการ',
      confirmButtonColor: '#f97316'
    });
    return;
  }

  if (!currentSlipFile && !uploadedSlipUrl) {
    Swal.fire({
      icon: 'warning',
      title: 'ยังไม่ได้แนบสลิป',
      text: 'กรุณาแนบรูปสลิปการโอนเงินก่อนกดยืนยันการสั่งซื้อครับ',
      confirmButtonColor: '#f97316'
    });
    return;
  }

  // Enforce QR Code only requirement: Must have a valid QR Code
  if (currentSlipVerification) {
    if (!currentSlipVerification.hasQrCode || currentSlipVerification.status === 'NO_QR_CODE') {
      Swal.fire({
        icon: 'error',
        title: 'ไม่พบ QR Code ในสลิป',
        text: 'ระบบกำหนดให้ต้องตรวจสอบสลิปจาก QR Code เท่านั้น กรุณาแนบรูปสลิปที่มี Mini QR Code ธนาคารครับ',
        confirmButtonColor: '#f97316'
      });
      return;
    }
    if (currentSlipVerification.isDuplicateSlip || currentSlipVerification.status === 'DUPLICATE_SLIP') {
      Swal.fire({
        icon: 'error',
        title: 'ตรวจพบสลิปซ้ำ',
        text: 'QR Code ในสลิปนี้เคยถูกใช้งานสั่งซื้อไปแล้วในระบบ กรุณาใช้สลิปการโอนเงินใหม่ครับ',
        confirmButtonColor: '#f97316'
      });
      return;
    }
    if (currentSlipVerification.detectedAmount !== null && currentSlipVerification.isAmountMatched === false) {
      const diff = currentSlipVerification.amountDifference || (currentSlipVerification.detectedAmount - total);
      Swal.fire({
        icon: 'error',
        title: 'ยอดเงินในสลิปไม่ตรงกับยอดสั่งซื้อ',
        html: `ยอดเงินในสลิปของคุณคือ <b>${currentSlipVerification.detectedAmount.toFixed(2)} บาท</b><br>แต่มียอดสั่งซื้อรวม <b>${total.toFixed(2)} บาท</b><br><span class="text-red-500 font-bold">${diff < 0 ? 'ขาดอีก ' + Math.abs(diff).toFixed(2) + ' บาท' : 'ยอดเกิน ' + diff.toFixed(2) + ' บาท'}</span><br><br>กรุณาโอนเงินให้ถูกต้องครบถ้วน หรือเปลี่ยนรูปสลิปใหม่ครับ 🐾`,
        confirmButtonColor: '#ef4444'
      });
      return;
    }
  }

  // Show saving progress
  Swal.fire({
    title: 'กำลังส่งคำสั่งซื้อ...',
    text: 'กรุณารอสักครู่ ระบบกำลังบันทึกข้อมูลออเดอร์...',
    allowOutsideClick: false,
    didOpen: () => Swal.showLoading()
  });

  const formData = new FormData();
  if (currentSlipFile && !uploadedSlipUrl) {
    formData.append('slip', currentSlipFile);
  }
  if (uploadedSlipUrl) {
    formData.append('existingSlipUrl', uploadedSlipUrl);
  } else if (currentSlipFile) {
    formData.append('slip', currentSlipFile);
  }
  if (currentSlipVerification) {
    formData.append('existingVerification', JSON.stringify(currentSlipVerification));
    if (currentSlipVerification.slipBase64) {
      formData.append('slipBase64', currentSlipVerification.slipBase64);
    }
  }
  formData.append('deviceId', getDeviceId());
  formData.append('customerName', customerName);
  formData.append('customerPhone', customerPhone);
  formData.append('items', JSON.stringify(items));

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    if (data.success && data.order) {
      Swal.close();

      // Confetti celebration 🎉
      if (window.confetti) {
        confetti({
          particleCount: 120,
          spread: 80,
          origin: { y: 0.6 }
        });
      }

      // Save customer contact info to persistent storage
      if (customerName) localStorage.setItem('snack_maew_customer_name', customerName);
      if (customerPhone) localStorage.setItem('snack_maew_customer_phone', customerPhone);

      // Save to local storage history
      saveOrderToLocalHistory(data.order.id);
      updateHistoryBadge();

      // Refresh cloud sync & active order notice
      syncDeviceOrdersFromCloud();

      // Show success modal receipt & live status tracker
      showReceiptModal(data.order);
      resetOrderForm();
    } else {
      Swal.fire({
        icon: 'error',
        title: 'บันทึกคำสั่งซื้อไม่สำเร็จ',
        text: data.error || 'กรุณาลองใหม่อีกครั้ง',
        confirmButtonColor: '#f97316'
      });
    }
  } catch (err) {
    console.error('Order saving error:', err);
    Swal.fire({
      icon: 'error',
      title: 'เกิดข้อผิดพลาด',
      text: err.message || 'ไม่สามารถบันทึกคำสั่งซื้อได้',
      confirmButtonColor: '#f97316'
    });
  }
}

// Alias for form onsubmit
function submitOrder() {
  confirmAndSaveOrder();
}

// Remove uploaded slip
function removeSlip() {
  currentSlipFile = null;
  uploadedSlipUrl = null;
  currentSlipVerification = null;
  const slipInput = document.getElementById('slipInput');
  if (slipInput) slipInput.value = '';
  document.getElementById('slipDropZone').classList.remove('hidden');
  document.getElementById('slipVerificationBox').classList.add('hidden');

  const loadingCard = document.getElementById('verifyingLoadingCard');
  if (loadingCard) loadingCard.classList.add('hidden');
  const resultCard = document.getElementById('verificationResultCard');
  if (resultCard) resultCard.classList.add('hidden');

  const confirmSection = document.getElementById('customerConfirmSection');
  if (confirmSection) confirmSection.classList.add('hidden');
  const hintBanner = document.getElementById('slipHintBanner');
  if (hintBanner) hintBanner.classList.remove('hidden');

  const confirmBtn = document.getElementById('confirmOrderBtn');
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    confirmBtn.innerHTML = '<i data-lucide="check-circle" class="w-5 h-5"></i><span>✅ กดยืนยันการสั่งซื้อขนม (ส่งออเดอร์) 🐾</span>';
  }
}

// Display verification result card with badges and details
function displayVerificationResult(v, expectedAmount) {
  const card = document.getElementById('verificationResultCard');
  const iconContainer = document.getElementById('statusIconContainer');
  const title = document.getElementById('verificationTitle');
  const summary = document.getElementById('verificationSummary');
  const confirmBtn = document.getElementById('confirmOrderBtn');

  const detectedAmountText = document.getElementById('detectedAmountText');
  const expectedAmountText = document.getElementById('expectedAmountText');
  const detectedBankText = document.getElementById('detectedBankText');
  const detectedTimeText = document.getElementById('detectedTimeText');
  const detectedRefText = document.getElementById('detectedRefText');
  const detectedReceiverText = document.getElementById('detectedReceiverText');

  card.classList.remove('hidden', 'bg-emerald-50', 'border-emerald-200', 'bg-amber-50', 'border-amber-200', 'bg-red-50', 'border-red-200', 'bg-blue-50', 'border-blue-200');

  expectedAmountText.innerText = `${expectedAmount.toFixed(2)} บาท`;
  detectedAmountText.innerText = v.detectedAmount !== null ? `${v.detectedAmount.toFixed(2)} บาท` : 'ตรวจไม่พบ';
  detectedBankText.innerText = v.bankName || '-';
  detectedTimeText.innerText = `${v.transferDate || ''} ${v.transferTime || ''}`.trim() || '-';
  detectedRefText.innerText = v.transactionRef || '-';

  // Handle QR indicator and duplicate warning
  const detectedQrBox = document.getElementById('detectedQrBox');
  const detectedQrText = document.getElementById('detectedQrText');
  const duplicateWarningBox = document.getElementById('duplicateSlipWarningBox');
  const duplicateWarningText = document.getElementById('duplicateSlipWarningText');

  if (detectedQrBox && detectedQrText) {
    if (v.hasQrCode) {
      detectedQrBox.className = 'col-span-2 flex items-center justify-between bg-emerald-50/90 px-3 py-2 rounded-xl border border-emerald-300';
      const bankLabel = v.bankName ? ` (${v.bankName})` : '';
      detectedQrText.innerHTML = `<span class="inline-flex items-center gap-1.5 font-bold text-emerald-800 text-xs"><i data-lucide="check-circle-2" class="w-4 h-4 text-emerald-600"></i> ${v.qrStatusText || 'ตรวจพบ Mini QR Code ธนาคาร'}${bankLabel}</span>`;
    } else {
      detectedQrBox.className = 'col-span-2 flex items-center justify-between bg-red-50 px-3 py-1.5 rounded-xl border border-red-200';
      detectedQrText.innerText = '❌ ไม่พบ QR Code ในสลิป (ระบบกำหนดให้ต้องมี QR Code)';
      detectedQrText.className = 'font-bold text-red-600 text-xs';
    }
  }

  if (duplicateWarningBox && duplicateWarningText) {
    if (v.isDuplicateSlip) {
      duplicateWarningBox.classList.remove('hidden');
      duplicateWarningText.innerText = v.message || 'สลิปนี้เคยถูกส่งมาแล้วในออเดอร์ก่อนหน้า ไม่สามารถใช้สลิปซ้ำได้';
    } else {
      duplicateWarningBox.classList.add('hidden');
    }
  }

  if (detectedReceiverText) {
    if (v.isReceiverMatched) {
      detectedReceiverText.innerText = `${v.receiverName || 'พัชญ์ชามญชุ์'} ✅ (เข้าบัญชีร้าน)`;
      detectedReceiverText.className = 'font-bold text-emerald-800 text-xs';
    } else {
      detectedReceiverText.innerText = `${v.receiverName || 'ไม่พบบัญชีร้าน'} ❌ (ไม่ใช่บัญชีร้าน)`;
      detectedReceiverText.className = 'font-bold text-red-600 text-xs';
    }
  }

  if (!v.hasQrCode || v.status === 'NO_QR_CODE') {
    // Missing QR Code!
    card.classList.add('bg-red-50', 'border-red-300');
    iconContainer.className = 'w-8 h-8 rounded-full bg-red-600 text-white flex items-center justify-center shrink-0 shadow-sm';
    iconContainer.innerHTML = '<i data-lucide="qr-code" class="w-5 h-5"></i>';
    title.className = 'text-sm font-bold text-red-900';
    title.innerText = '❌ ตรวจไม่พบ QR Code ในรูปภาพสลิป';
    summary.className = 'text-xs text-red-700 font-bold';
    summary.innerText = v.message || 'ระบบกำหนดให้ต้องตรวจสอบสลิปจาก QR Code เท่านั้น กรุณาแนบรูปสลิปการโอนเงินที่มี Mini QR Code ของธนาคารที่ชัดเจนครับ';

    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.classList.add('opacity-50', 'cursor-not-allowed');
      confirmBtn.innerHTML = '<i data-lucide="alert-triangle" class="w-5 h-5"></i><span>⚠️ สลิปไม่มี QR Code (ไม่สามารถส่งออเดอร์ได้)</span>';
    }
  } else if (v.isDuplicateSlip || v.status === 'DUPLICATE_SLIP') {
    // Duplicate slip detected!
    card.classList.add('bg-red-50', 'border-red-300');
    iconContainer.className = 'w-8 h-8 rounded-full bg-red-600 text-white flex items-center justify-center shrink-0 shadow-sm';
    iconContainer.innerHTML = '<i data-lucide="shield-alert" class="w-5 h-5"></i>';
    title.className = 'text-sm font-bold text-red-900';
    title.innerText = '🚫 สลิปนี้ซ้ำ! QR Code นี้เคยถูกใช้งานในระบบแล้ว';
    summary.className = 'text-xs text-red-700 font-medium';
    summary.innerText = v.message || 'ตรวจพบว่า QR Code นี้เคยถูกใช้สั่งซื้อไปแล้ว กรุณาใช้สลิปการโอนเงินใหม่';

    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.classList.add('opacity-50', 'cursor-not-allowed');
      confirmBtn.innerHTML = '<i data-lucide="alert-triangle" class="w-5 h-5"></i><span>⚠️ QR Code นี้ถูกใช้ไปแล้ว</span>';
    }
  } else if (v.status === 'VALID_AND_MATCHED' || v.isReadyToSave) {
    // Exact Match, Valid Date & Valid Shop Receiver!
    card.classList.add('bg-emerald-50', 'border-emerald-200');
    iconContainer.className = 'w-8 h-8 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0 shadow-sm';
    iconContainer.innerHTML = '<i data-lucide="check-circle" class="w-5 h-5"></i>';
    title.className = 'text-sm font-bold text-emerald-900';
    title.innerText = '✅ ตรวจสอบ QR Code ในสลิปถูกต้อง!';
    summary.className = 'text-xs text-emerald-700 font-medium';
    summary.innerText = `ตรวจพบ Mini QR ธนาคาร (${v.bankName || 'ธนาคารไทย'}) | เลขอ้างอิง: ${v.transactionRef || '-'} | ยอดเงินตรง ${expectedAmount.toFixed(2)} บาท`;

    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.classList.remove('opacity-50', 'cursor-not-allowed');
      confirmBtn.innerHTML = '<i data-lucide="check-circle" class="w-5 h-5"></i><span>✅ กดยืนยันการสั่งซื้อขนม (ส่งออเดอร์) 🐾</span>';
    }
  } else if (v.status === 'RECEIVER_MISMATCHED' || !v.isReceiverMatched) {
    // Receiver Mismatch (Not the shop's account!)
    card.classList.add('bg-red-50', 'border-red-200');
    iconContainer.className = 'w-8 h-8 rounded-full bg-red-500 text-white flex items-center justify-center shrink-0 shadow-sm';
    iconContainer.innerHTML = '<i data-lucide="shield-alert" class="w-5 h-5"></i>';
    title.className = 'text-sm font-bold text-red-900';
    title.innerText = '❌ สลิปนี้ไม่ได้โอนเข้าบัญชีของทางร้าน';
    summary.className = 'text-xs text-red-700';
    summary.innerText = v.message || `ชื่อผู้รับในสลิป (${v.receiverName || 'ไม่ระบุ'}) ไม่ตรงกับบัญชีของร้าน`;

    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.classList.remove('opacity-50', 'cursor-not-allowed');
      confirmBtn.innerHTML = '<i data-lucide="check-circle" class="w-5 h-5"></i><span>✅ กดยืนยันการสั่งซื้อขนม (ส่งออเดอร์) 🐾</span>';
    }
  } else if (v.status === 'AMOUNT_MISMATCHED' || (!v.isAmountMatched && v.detectedAmount !== null)) {
    // Amount Mismatch - Strict Block!
    card.classList.add('bg-red-50', 'border-red-300');
    iconContainer.className = 'w-8 h-8 rounded-full bg-red-600 text-white flex items-center justify-center shrink-0 shadow-sm';
    iconContainer.innerHTML = '<i data-lucide="x-circle" class="w-5 h-5"></i>';
    title.className = 'text-sm font-bold text-red-900';
    title.innerText = '❌ ยอดเงินในสลิปไม่ตรงกับยอดที่สั่งซื้อ!';
    summary.className = 'text-xs text-red-700 font-bold';
    const diff = v.amountDifference || (v.detectedAmount - expectedAmount);
    summary.innerText = `ยอดในสลิปโอนมา ${v.detectedAmount?.toFixed(2) || 0} บาท แต่มียอดสั่งซื้อ ${expectedAmount.toFixed(2)} บาท (${diff < 0 ? 'ขาดอีก ' + Math.abs(diff).toFixed(2) : 'ยอดเกิน ' + diff.toFixed(2)} บาท) กรุณาโอนเงินให้ครบหรือแนบสลิปที่ถูกต้องครับ`;

    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.classList.add('opacity-50', 'cursor-not-allowed');
      confirmBtn.innerHTML = '<i data-lucide="alert-triangle" class="w-5 h-5"></i><span>⚠️ ยอดเงินไม่ตรง (ขาดอีก ' + (diff < 0 ? Math.abs(diff).toFixed(2) : '0.00') + ' บาท)</span>';
    }
  } else if (v.status === 'DATE_MISMATCHED' || !v.isDateToday) {
    // Date Mismatch (Old slip)
    card.classList.add('bg-amber-50', 'border-amber-200');
    iconContainer.className = 'w-8 h-8 rounded-full bg-amber-500 text-white flex items-center justify-center shrink-0 shadow-sm';
    iconContainer.innerHTML = '<i data-lucide="calendar-x" class="w-5 h-5"></i>';
    title.className = 'text-sm font-bold text-amber-900';
    title.innerText = '⚠️ วันที่ในสลิปไม่ใช่วันนี้';
    summary.className = 'text-xs text-amber-800';
    summary.innerText = `ในสลิปตรวจพบวันที่ ${v.transferDate || 'วันอื่น'} ซึ่งไม่ใช่วันปัจจุบัน กรุณาใช้สลิปที่โอนวันนี้`;
  } else if (v.status === 'NOT_A_SLIP') {
    // Not a valid slip
    card.classList.add('bg-red-50', 'border-red-200');
    iconContainer.className = 'w-8 h-8 rounded-full bg-red-500 text-white flex items-center justify-center shrink-0 shadow-sm';
    iconContainer.innerHTML = '<i data-lucide="x-circle" class="w-5 h-5"></i>';
    title.className = 'text-sm font-bold text-red-900';
    title.innerText = '❌ ภาพที่แนบไม่ใช่สลิปการโอนเงิน';
    summary.className = 'text-xs text-red-700';
    summary.innerText = 'กรุณาตรวจสอบและอัปโหลดรูปภาพสลิปการโอนเงินธนาคารที่ชัดเจน';
  } else {
    card.classList.add('bg-blue-50', 'border-blue-200');
    iconContainer.className = 'w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center shrink-0 shadow-sm';
    iconContainer.innerHTML = '<i data-lucide="info" class="w-5 h-5"></i>';
    title.className = 'text-sm font-bold text-blue-900';
    title.innerText = 'ℹ️ ข้อมูลสลิป';
    summary.className = 'text-xs text-blue-700';
    summary.innerText = v.message || 'กรุณาตรวจสอบความถูกต้องของสลิป';
  }

  if (window.lucide) lucide.createIcons();
}

// State for order history & tracking
let currentActiveReceiptOrderId = null;
const LOCAL_STORAGE_ORDERS_KEY = 'snack_maew_my_orders';

// Helpers for localStorage
function getLocalOrderIds() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_ORDERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveOrderToLocalHistory(orderId) {
  if (!orderId) return;
  try {
    const ids = getLocalOrderIds();
    if (!ids.includes(orderId)) {
      ids.unshift(orderId);
      localStorage.setItem(LOCAL_STORAGE_ORDERS_KEY, JSON.stringify(ids.slice(0, 50)));
    }
  } catch (e) {
    console.warn('Failed to save order to localStorage:', e);
  }
  updateHistoryBadge();
}

function updateHistoryBadge() {
  const badge = document.getElementById('headerHistoryCountBadge');
  if (!badge) return;
  const ids = getLocalOrderIds();
  if (ids.length > 0) {
    badge.innerText = ids.length;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// Persistent Device ID across reloads, browser closing, iOS Safari / LINE in-app webview
function getDeviceId() {
  const DEVICE_COOKIE_NAME = 'snack_maew_device_id';
  let deviceId = null;

  // 1. Try reading from localStorage
  try {
    deviceId = localStorage.getItem('snack_maew_device_id');
  } catch (e) {}

  // 2. Try reading from cookie if localStorage was empty or cleared
  if (!deviceId) {
    const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + DEVICE_COOKIE_NAME + '=([^;]*)'));
    if (match && match[1]) {
      deviceId = decodeURIComponent(match[1]);
    }
  }

  // 3. If still no deviceId, generate a persistent device ID
  if (!deviceId) {
    deviceId = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 10);
  }

  // 4. Save to both localStorage and cookie (10 years)
  try {
    localStorage.setItem('snack_maew_device_id', deviceId);
  } catch (e) {}

  try {
    const expires = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = `${DEVICE_COOKIE_NAME}=${encodeURIComponent(deviceId)}; expires=${expires}; path=/; SameSite=Lax`;
  } catch (e) {}

  return deviceId;
}

let latestActiveDeviceOrder = null;

// Synchronize device orders from cloud (Mobile memory across browser close)
async function syncDeviceOrdersFromCloud() {
  try {
    const deviceId = getDeviceId();
    const localIds = getLocalOrderIds();
    const phoneInput = document.getElementById('customerPhone');
    const nameInput = document.getElementById('customerName');
    const savedPhone = (phoneInput && phoneInput.value.trim()) || localStorage.getItem('snack_maew_customer_phone') || '';
    const savedName = (nameInput && nameInput.value.trim()) || localStorage.getItem('snack_maew_customer_name') || '';

    const params = new URLSearchParams();
    if (deviceId) params.append('deviceId', deviceId);
    if (localIds.length > 0) params.append('ids', localIds.join(','));
    if (savedPhone) params.append('phone', savedPhone);
    if (savedName) params.append('name', savedName);

    const res = await fetch(`/api/orders-history?${params.toString()}`);
    const data = await res.json();

    if (data.success && Array.isArray(data.data) && data.data.length > 0) {
      const orders = data.data;

      // 1. Merge recovered order IDs back into local history
      orders.forEach(o => {
        if (o && o.id) saveOrderToLocalHistory(o.id);
      });
      updateHistoryBadge();

      // 2. Pre-fill customer name & phone from most recent order if empty
      const latestOrder = orders[0];
      if (latestOrder) {
        if (nameInput && !nameInput.value.trim() && latestOrder.customerName) {
          nameInput.value = latestOrder.customerName;
          localStorage.setItem('snack_maew_customer_name', latestOrder.customerName);
        }
        if (phoneInput && !phoneInput.value.trim() && latestOrder.customerPhone) {
          phoneInput.value = latestOrder.customerPhone;
          localStorage.setItem('snack_maew_customer_phone', latestOrder.customerPhone);
        }
      }

      // 3. Check for active (in-progress) orders: pending, verified, preparing, prepared
      const activeOrders = orders.filter(o =>
        ['pending', 'verified', 'preparing', 'prepared'].includes(o.orderStatus)
      );

      const banner = document.getElementById('deviceActiveOrdersBanner');
      if (banner) {
        if (activeOrders.length > 0) {
          latestActiveDeviceOrder = activeOrders[0];
          const badgeStatus = document.getElementById('activeOrderBadgeStatus');
          const idText = document.getElementById('activeOrderIdText');
          const countBadge = document.getElementById('deviceActiveOrdersCount');
          const previewText = document.getElementById('deviceActiveOrderPreview');
          const mainText = document.getElementById('deviceActiveOrdersText');
          const statusInfo = getOrderStatusInfo(latestActiveDeviceOrder.orderStatus);

          if (badgeStatus) {
            badgeStatus.className = `text-[10px] sm:text-xs font-medium px-2 py-0.5 rounded-full border ${statusInfo.badgeClass}`;
            badgeStatus.innerText = statusInfo.label;
          }
          if (idText) {
            idText.innerText = `${latestActiveDeviceOrder.id} • ${latestActiveDeviceOrder.customerName} (${latestActiveDeviceOrder.totalPrice.toLocaleString()} ฿)`;
          }
          if (countBadge) countBadge.innerText = `${activeOrders.length} รายการ`;
          if (mainText) mainText.innerText = `คุณมี ${activeOrders.length} ออเดอร์กำลังดำเนินการ: ${statusInfo.label}`;
          if (previewText) {
            const itemsSummary = (latestActiveDeviceOrder.items || []).map(i => `${i.name} × ${i.quantity}`).join(', ');
            previewText.innerText = `รหัส: ${latestActiveDeviceOrder.id} • ${latestActiveDeviceOrder.customerName} (${latestActiveDeviceOrder.totalPrice.toLocaleString()} ฿) - ${itemsSummary}`;
          }

          banner.classList.remove('hidden');
          if (window.lucide) lucide.createIcons();
        } else {
          banner.classList.add('hidden');
        }
      }
    }
  } catch (err) {
    console.warn('Could not sync device orders from cloud:', err);
  }
}

// Open active order from banner
function openActiveOrderFromBanner() {
  if (latestActiveDeviceOrder) {
    showReceiptModal(latestActiveDeviceOrder);
  } else {
    openOrderHistoryModal();
  }
}

// Order Status definitions & styles
function getOrderStatusInfo(status) {
  switch (status) {
    case 'preparing':
      return {
        label: '👨‍🍳 กำลังเตรียมขนม',
        step: 2,
        progressPercent: '60%',
        badgeClass: 'bg-blue-100 text-blue-800 border-blue-200',
        detail: '👨‍🍳 ร้านแม้วกำลังอบและจัดเตรียมขนมสดใหม่ตามออเดอร์ของคุณอย่างตั้งใจ',
        step1Active: true,
        step2Active: true,
        step3Active: false,
        step4Active: false
      };
    case 'prepared':
      return {
        label: '🍰 เตรียมขนมเสร็จแล้ว',
        step: 3,
        progressPercent: '85%',
        badgeClass: 'bg-amber-100 text-amber-900 border-amber-300',
        detail: '🍰 ร้านแม้วทำขนมเสร็จเรียบร้อยแล้ว พร้อมส่งมอบให้คุณจ้า 🐾',
        step1Active: true,
        step2Active: true,
        step3Active: true,
        step4Active: false
      };
    case 'delivered':
      return {
        label: '🚚 ส่งมอบเรียบร้อย',
        step: 4,
        progressPercent: '100%',
        badgeClass: 'bg-emerald-100 text-emerald-800 border-emerald-200',
        detail: '🚚 ขนมส่งมอบเรียบร้อยแล้ว หรือพร้อมให้คุณรับประทานแล้ว ทานให้อร่อยนะจ๊ะ! 🐾',
        step1Active: true,
        step2Active: true,
        step3Active: true,
        step4Active: true
      };
    case 'cancelled':
      return {
        label: '❌ ยกเลิกคำสั่งซื้อ',
        step: -1,
        progressPercent: '0%',
        badgeClass: 'bg-red-100 text-red-800 border-red-200',
        detail: '❌ คำสั่งซื้อนี้ถูกยกเลิกแล้ว หากมีข้อสงสัยสามารถติดต่อร้านได้โดยตรงครับ',
        step1Active: false,
        step2Active: false,
        step3Active: false,
        step4Active: false
      };
    case 'pending':
      return {
        label: '⏳ รอร้านตรวจสอบสลิป',
        step: 0,
        progressPercent: '15%',
        badgeClass: 'bg-amber-100 text-amber-800 border-amber-200',
        detail: '⏳ ส่งสลิปเรียบร้อยแล้ว! ร้านแม้วกำลังตรวจสอบสลิปและจะเริ่มทำขนมให้คุณในไม่ช้าจ้า 🐾',
        step1Active: false,
        step2Active: false,
        step3Active: false,
        step4Active: false
      };
    case 'verified':
      return {
        label: '🟢 ยืนยันสลิปแล้ว',
        step: 1,
        progressPercent: '35%',
        badgeClass: 'bg-emerald-100 text-emerald-800 border-emerald-200',
        detail: '🟢 ร้านแม้วตรวจสอบและยืนยันสลิปเรียบร้อยแล้ว กำลังจัดเตรียมคิวทำขนมสดใหม่ให้คุณครับ 🍰',
        step1Active: true,
        step2Active: false,
        step3Active: false,
        step4Active: false
      };
    default:
      return {
        label: '⏳ รอตรวจสอบสลิป',
        step: 0,
        progressPercent: '15%',
        badgeClass: 'bg-amber-100 text-amber-800 border-amber-200',
        detail: '⏳ ส่งสลิปเรียบร้อยแล้ว! รอทางร้านตรวจสอบสลิป',
        step1Active: false,
        step2Active: false,
        step3Active: false,
        step4Active: false
      };
  }
}

// Render Status Stepper in Receipt Modal (4 Steps)
function renderReceiptStatus(order) {
  const statusInfo = getOrderStatusInfo(order.orderStatus);
  const progressLine = document.getElementById('modalStatusProgressLine');
  const step1Icon = document.getElementById('modalStep1Icon');
  const step2Icon = document.getElementById('modalStep2Icon');
  const step3Icon = document.getElementById('modalStep3Icon');
  const step4Icon = document.getElementById('modalStep4Icon');
  const step1Text = document.getElementById('modalStep1Text');
  const step2Text = document.getElementById('modalStep2Text');
  const step3Text = document.getElementById('modalStep3Text');
  const step4Text = document.getElementById('modalStep4Text');
  const detailBox = document.getElementById('modalStatusDetailBox');

  if (progressLine) progressLine.style.width = statusInfo.progressPercent;

  if (order.orderStatus === 'cancelled') {
    if (step1Icon) step1Icon.className = 'w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-red-500 text-white flex items-center justify-center text-xs font-bold';
    if (step2Icon) step2Icon.className = 'w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-slate-200 text-slate-400 flex items-center justify-center text-xs font-bold';
    if (step3Icon) step3Icon.className = 'w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-slate-200 text-slate-400 flex items-center justify-center text-xs font-bold';
    if (step4Icon) step4Icon.className = 'w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-slate-200 text-slate-400 flex items-center justify-center text-xs font-bold';
    if (detailBox) {
      detailBox.className = 'bg-red-50 p-2.5 rounded-xl border border-red-200 text-xs text-center font-bold text-red-800';
      detailBox.innerText = statusInfo.detail;
    }
    return;
  }

  // Step 1: ยืนยันสลิป
  if (step1Icon) {
    step1Icon.className = statusInfo.step1Active
      ? 'w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-stone-900 text-white flex items-center justify-center text-xs font-medium shadow-2xs transition'
      : 'w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-stone-200 text-stone-600 flex items-center justify-center text-xs font-medium';
    step1Icon.innerHTML = statusInfo.step1Active ? '✓' : '1';
  }
  if (step1Text) {
    step1Text.className = statusInfo.step1Active ? 'text-[9px] sm:text-[10px] font-medium text-stone-900' : 'text-[9px] sm:text-[10px] font-normal text-stone-500';
  }

  // Step 2: กำลังทำ
  if (step2Icon) {
    step2Icon.className = statusInfo.step2Active
      ? 'w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-stone-900 text-white flex items-center justify-center text-xs font-medium shadow-2xs transition'
      : 'w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-stone-200 text-stone-600 flex items-center justify-center text-xs font-medium';
    step2Icon.innerHTML = statusInfo.step2Active ? (statusInfo.step3Active ? '✓' : '👨‍🍳') : '2';
  }
  if (step2Text) {
    step2Text.className = statusInfo.step2Active ? 'text-[9px] sm:text-[10px] font-medium text-stone-900' : 'text-[9px] sm:text-[10px] font-normal text-stone-500';
  }

  // Step 3: ขนมเสร็จแล้ว 🍰
  if (step3Icon) {
    step3Icon.className = statusInfo.step3Active
      ? 'w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-stone-900 text-white flex items-center justify-center text-xs font-medium shadow-2xs transition'
      : 'w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-stone-200 text-stone-600 flex items-center justify-center text-xs font-medium';
    step3Icon.innerHTML = statusInfo.step3Active ? (statusInfo.step4Active ? '✓' : '🍰') : '3';
  }
  if (step3Text) {
    step3Text.className = statusInfo.step3Active ? 'text-[9px] sm:text-[10px] font-medium text-stone-900' : 'text-[9px] sm:text-[10px] font-normal text-stone-500';
  }

  // Step 4: ส่งมอบแล้ว 🚚
  if (step4Icon) {
    step4Icon.className = statusInfo.step4Active
      ? 'w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-stone-900 text-white flex items-center justify-center text-xs font-medium shadow-2xs transition'
      : 'w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-stone-200 text-stone-600 flex items-center justify-center text-xs font-medium';
    step4Icon.innerHTML = statusInfo.step4Active ? '✓' : '4';
  }
  if (step4Text) {
    step4Text.className = statusInfo.step4Active ? 'text-[9px] sm:text-[10px] font-medium text-stone-900' : 'text-[9px] sm:text-[10px] font-normal text-stone-500';
  }

  // Detail box
  if (detailBox) {
    detailBox.className = 'bg-white p-2.5 rounded-xl border border-stone-200 text-xs text-center font-normal text-stone-700 shadow-2xs';
    detailBox.innerText = statusInfo.detail;
  }
}

// Refresh active receipt status in modal
async function refreshActiveReceiptStatus() {
  if (!currentActiveReceiptOrderId) return;
  try {
    const res = await fetch(`/api/orders/${currentActiveReceiptOrderId}`);
    const data = await res.json();
    if (data.success && data.order) {
      renderReceiptStatus(data.order);
      const Toast = Swal.mixin({
        toast: true,
        position: 'top-end',
        showConfirmButton: false,
        timer: 1500,
        timerProgressBar: true
      });
      Toast.fire({
        icon: 'info',
        title: `สถานะล่าสุด: ${getOrderStatusInfo(data.order.orderStatus).label}`
      });
    }
  } catch (e) {
    console.error('Failed to refresh order status:', e);
  }
}

// Show receipt success modal with live status
function showReceiptModal(order) {
  currentActiveReceiptOrderId = order.id;
  saveOrderToLocalHistory(order.id);

  document.getElementById('modalOrderId').innerText = order.id;
  document.getElementById('modalCustomerName').innerText = order.customerName;
  document.getElementById('modalOrderDate').innerText = new Date(order.createdAt).toLocaleString('th-TH');
  document.getElementById('modalTotalPrice').innerText = `${order.totalPrice.toLocaleString()} บาท`;

  const itemsListEl = document.getElementById('modalItemsList');
  itemsListEl.innerHTML = (order.items || []).map(item => `
    <div class="flex justify-between text-xs text-slate-700">
      <span>${item.name} (${item.quantity} ${item.unit})</span>
      <span class="font-bold">${item.subtotal.toLocaleString()} ฿</span>
    </div>
  `).join('');

  const statusEl = document.getElementById('modalSlipStatus');
  if (order.orderStatus === 'verified' || order.orderStatus === 'preparing' || order.orderStatus === 'prepared' || order.orderStatus === 'delivered') {
    statusEl.className = 'font-bold px-2.5 py-0.5 rounded-full text-xs bg-emerald-100 text-emerald-700';
    statusEl.innerText = `✅ ร้านยืนยันสลิปแล้ว (${order.totalPrice.toLocaleString()} บาท)`;
  } else {
    statusEl.className = 'font-bold px-2.5 py-0.5 rounded-full text-xs bg-amber-100 text-amber-800';
    statusEl.innerText = '⏳ แนบสลิปแล้ว (รอร้านตรวจสอบ)';
  }

  renderReceiptStatus(order);

  document.getElementById('receiptModal').classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closeReceiptModal() {
  document.getElementById('receiptModal').classList.add('hidden');
}

// Open Order History Modal
function openOrderHistoryModal() {
  document.getElementById('orderHistoryModal').classList.remove('hidden');
  loadOrderHistory();
  if (window.lucide) lucide.createIcons();
}

function closeOrderHistoryModal() {
  document.getElementById('orderHistoryModal').classList.add('hidden');
}

// Load customer order history
async function loadOrderHistory(searchQuery = '') {
  const container = document.getElementById('orderHistoryList');
  const countText = document.getElementById('orderHistoryCountText');
  container.innerHTML = `
    <div class="py-12 text-center text-stone-400 space-y-2">
      <div class="spinner mx-auto"></div>
      <p class="text-xs">กำลังโหลดประวัติคำสั่งซื้อ...</p>
    </div>
  `;

  try {
    const localIds = getLocalOrderIds();
    const deviceId = getDeviceId();
    const phoneInput = document.getElementById('customerPhone');
    const nameInput = document.getElementById('customerName');
    const savedPhone = (phoneInput && phoneInput.value.trim()) || localStorage.getItem('snack_maew_customer_phone') || '';
    const savedName = (nameInput && nameInput.value.trim()) || localStorage.getItem('snack_maew_customer_name') || '';

    let url = '/api/orders-history';
    const params = new URLSearchParams();

    if (searchQuery && searchQuery.trim()) {
      params.append('query', searchQuery.trim());
    } else {
      if (deviceId) params.append('deviceId', deviceId);
      if (localIds.length > 0) params.append('ids', localIds.join(','));
      if (savedPhone) params.append('phone', savedPhone);
      if (savedName) params.append('name', savedName);
    }
    url += `?${params.toString()}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.success && data.data && data.data.length > 0) {
      // Merge all returned order IDs into local storage so they remain permanently recalled
      data.data.forEach(o => saveOrderToLocalHistory(o.id));
      updateHistoryBadge();

      renderOrderHistoryList(data.data);
      if (countText) countText.innerText = `พบทั้งหมด ${data.data.length} รายการ`;
    } else {
      renderEmptyOrderHistory(searchQuery ? `ไม่พบรายการสั่งซื้อที่ตรงกับ "${searchQuery}"` : null);
      if (countText) countText.innerText = 'มีทั้งหมด 0 รายการ';
    }
  } catch (err) {
    console.error('Failed to load history:', err);
    container.innerHTML = `
      <div class="p-6 text-center text-red-500 text-xs">
        เกิดข้อผิดพลาดในการโหลดข้อมูล กรุณาลองใหม่อีกครั้ง
      </div>
    `;
  }
}

function renderEmptyOrderHistory(customMsg = null) {
  const container = document.getElementById('orderHistoryList');
  container.innerHTML = `
    <div class="py-10 px-4 text-center text-stone-400 space-y-3 bg-stone-50/70 rounded-2xl border border-dashed border-stone-200">
      <div class="w-12 h-12 rounded-full bg-stone-100 text-stone-700 text-xl flex items-center justify-center mx-auto border border-stone-200">
        🐾
      </div>
      <div class="space-y-1">
        <p class="font-medium text-stone-800 text-sm">${customMsg || 'ยังไม่มีประวัติการสั่งซื้อบนอุปกรณ์นี้'}</p>
        <p class="text-xs text-stone-400 max-w-sm mx-auto">
          หากเคยสั่งซื้อไว้ สามารถพิมพ์เบอร์โทรศัพท์ที่เคยใช้ หรือกดปุ่มด้านล่างเพื่อดึงออเดอร์ทั้งหมดได้ครับ
        </p>
      </div>
      <div class="pt-1">
        <button
          type="button"
          onclick="loadOrderHistory('all')"
          class="bg-stone-900 hover:bg-stone-800 text-white text-xs font-medium px-4 py-2 rounded-xl transition shadow-2xs cursor-pointer inline-flex items-center gap-1.5"
        >
          <i data-lucide="list" class="w-3.5 h-3.5"></i>
          <span>ดูรายการสั่งซื้อล่าสุดทั้งหมดของร้าน</span>
        </button>
      </div>
    </div>
  `;
  if (window.lucide) lucide.createIcons();
}

function renderOrderHistoryList(orders) {
  const container = document.getElementById('orderHistoryList');
  container.innerHTML = '';

  orders.forEach(order => {
    const statusInfo = getOrderStatusInfo(order.orderStatus);
    const dateFormatted = new Date(order.createdAt).toLocaleString('th-TH', {
      day: 'numeric',
      month: 'short',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });

    const itemsSummary = (order.items || []).map(i => `${i.name} × ${i.quantity}`).join(', ');

    const card = document.createElement('div');
    card.className = 'bg-white p-4 rounded-xl border border-stone-200 shadow-2xs hover:border-stone-300 transition space-y-3';
    card.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-stone-100 pb-2.5">
        <div>
          <div class="font-mono font-semibold text-stone-900 text-xs flex items-center gap-1.5">
            <span>${order.id}</span>
          </div>
          <div class="text-[11px] text-stone-400">${dateFormatted}</div>
        </div>
        <span class="px-2.5 py-0.5 rounded-full text-xs font-medium border ${statusInfo.badgeClass}">
          ${statusInfo.label}
        </span>
      </div>

      <!-- Items & Price -->
      <div class="flex items-center justify-between text-xs text-stone-700">
        <div class="font-normal text-stone-700 line-clamp-1 pr-2" title="${itemsSummary}">
          🍪 ${itemsSummary || 'รายการขนม'}
        </div>
        <div class="font-semibold text-stone-900 text-sm shrink-0">
          ${order.totalPrice.toLocaleString()} ฿
        </div>
      </div>

      <!-- Mini Stepper Indicator -->
      <div class="bg-stone-50 p-2.5 rounded-xl border border-stone-200/80 text-[11px] space-y-1.5">
        <div class="flex justify-between items-center text-stone-500 font-medium text-[10px]">
          <span class="${statusInfo.step1Active ? 'text-stone-900 font-semibold' : ''}">1. ยืนยันสลิป</span>
          <span class="${statusInfo.step2Active ? 'text-stone-900 font-semibold' : ''}">2. กำลังทำ</span>
          <span class="${statusInfo.step3Active ? 'text-stone-900 font-semibold' : ''}">3. เสร็จแล้ว 🍰</span>
          <span class="${statusInfo.step4Active ? 'text-stone-900 font-semibold' : ''}">4. ส่งมอบ 🚚</span>
        </div>
        <div class="w-full bg-stone-200 h-1 rounded-full overflow-hidden">
          <div class="bg-stone-900 h-full rounded-full transition-all" style="width: ${statusInfo.progressPercent}"></div>
        </div>
        <p class="text-stone-600 text-[11px] font-normal pt-0.5">
          ${statusInfo.detail}
        </p>
      </div>

      <!-- Action Button -->
      <div class="pt-1 flex justify-end">
        <button
          type="button"
          onclick="viewOrderDetailFromHistory('${order.id}')"
          class="bg-stone-50 hover:bg-stone-100 text-stone-700 px-3 py-1.5 rounded-lg text-xs font-medium transition border border-stone-200 flex items-center gap-1 cursor-pointer"
        >
          <i data-lucide="receipt" class="w-3.5 h-3.5 text-stone-500"></i>
          <span>ดูใบเสร็จ & ติดตาม</span>
        </button>
      </div>
    `;

    container.appendChild(card);
  });

  if (window.lucide) lucide.createIcons();
}

function searchOrderHistory() {
  const input = document.getElementById('historySearchInput');
  const query = input ? input.value.trim() : '';
  loadOrderHistory(query);
}

async function viewOrderDetailFromHistory(orderId) {
  try {
    const res = await fetch(`/api/orders/${orderId}`);
    const data = await res.json();
    if (data.success && data.order) {
      closeOrderHistoryModal();
      showReceiptModal(data.order);
    } else {
      Swal.fire({
        icon: 'error',
        title: 'ไม่พบข้อมูลออเดอร์',
        text: 'ไม่สามารถโหลดข้อมูลคำสั่งซื้อนี้ได้'
      });
    }
  } catch (e) {
    console.error('Error viewing order detail:', e);
  }
}

// Reset form after successful order
function resetOrderForm() {
  selectedItems = {};
  removeSlip();
  renderSnacksGrid();
  updateOrderSummary();
}

// =======================================================
// MOBILE UX HELPER FUNCTIONS
// =======================================================

// Download or open PromptPay QR code for mobile bank app upload
function downloadQrCode() {
  const qrImg = document.getElementById('promptpayQrImg');
  if (!qrImg || !qrImg.src) {
    Swal.fire({
      icon: 'info',
      title: 'ไม่พบรูป QR Code',
      text: 'กรุณารอโหลดสักครู่ หรือเลือกรายการขนมก่อนนะจ๊ะ',
      confirmButtonColor: '#f97316'
    });
    return;
  }

  // Create temporary anchor to trigger direct download
  const link = document.createElement('a');
  link.href = qrImg.src;
  link.download = `PromptPay-QR-SnackByMaew-${Date.now()}.png`;
  link.target = '_blank';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  Swal.fire({
    icon: 'success',
    title: 'บันทึกรูป QR แล้ว 📥',
    html: `
      <div class="text-xs text-slate-600 space-y-2 text-left bg-orange-50 p-3.5 rounded-xl border border-orange-200">
        <p class="font-bold text-orange-900 text-sm">ขั้นตอนชำระเงินบนมือถือง่ายๆ:</p>
        <p>1. เปิดแอปธนาคารของคุณ (เช่น K PLUS, SCB EASY, Krungthai NEXT)</p>
        <p>2. กดเมนู <b>"สแกน QR"</b> แล้วเลือก <b>"เลือกรูปจากอัลบั้ม / แกลเลอรี"</b></p>
        <p>3. ตรวจสอบยอดเงิน และกดยืนยันการโอน</p>
        <p>4. สลับกลับมาหน้านี้แล้วแตะ <b>"แนบสลิป"</b> ระบบจะตรวจให้ทันทีจ้า 🐾</p>
      </div>
    `,
    confirmButtonColor: '#f97316',
    confirmButtonText: 'เข้าใจแล้ว'
  });
}

// Copy PromptPay / Bank transfer details to clipboard
function copyBankDetails() {
  const bankAccName = document.getElementById('bankAccNameDisplay') ? document.getElementById('bankAccNameDisplay').innerText : 'พัชญ์ชามญชุ์ กฤติณัฐธนชัย';
  const promptpayId = (shopSettings && shopSettings.promptpayId) ? shopSettings.promptpayId : '140540';
  const qrAmount = document.getElementById('qrAmountDisplay') ? document.getElementById('qrAmountDisplay').innerText : '0.00';

  const textToCopy = `ร้านขนมแม้ว 🐾\nชื่อบัญชี: ${bankAccName}\nพร้อมเพย์: ${promptpayId}\nยอดชำระ: ${qrAmount} บาท`;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(promptpayId || textToCopy).then(() => {
      Swal.fire({
        icon: 'success',
        title: 'คัดลอกสำเร็จ! 📋',
        text: `คัดลอกรหัสพร้อมเพย์ (${promptpayId}) แล้ว นำไปวางในแอปธนาคารได้ทันที`,
        timer: 2200,
        showConfirmButton: false
      });
    }).catch(() => {
      fallbackCopyText(textToCopy);
    });
  } else {
    fallbackCopyText(textToCopy);
  }
}

function fallbackCopyText(text) {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    document.execCommand('copy');
    Swal.fire({
      icon: 'success',
      title: 'คัดลอกสำเร็จ! 📋',
      timer: 1800,
      showConfirmButton: false
    });
  } catch (err) {
    Swal.fire({
      icon: 'info',
      title: 'ข้อมูลสำหรับโอนเงิน',
      text: text
    });
  }
  document.body.removeChild(textArea);
}

// Smooth scroll to payment section on mobile
function scrollToPaymentSection() {
  const paymentSection = document.getElementById('paymentSection');
  if (paymentSection) {
    paymentSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Check if customer name is filled
    const customerName = document.getElementById('customerName');
    if (customerName && !customerName.value.trim()) {
      setTimeout(() => {
        const step1 = document.getElementById('customerInfoSection');
        if (step1) step1.scrollIntoView({ behavior: 'smooth', block: 'center' });
        customerName.focus();
      }, 500);
    }
  }
}

