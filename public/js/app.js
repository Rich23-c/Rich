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

  await loadShopSettings();
  await loadSnacks();

  setupDropZone();
  updateHistoryBadge();
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
    card.className = `snack-card bg-white rounded-3xl p-4 sm:p-5 border ${
      !isStoreOpen
        ? 'border-slate-200 bg-slate-50/70 shadow-2xs opacity-80'
        : (!isSnackAvailable
          ? 'border-slate-200 bg-slate-50/70 shadow-2xs opacity-80'
          : (isSelected ? 'border-orange-500 bg-amber-50/50 shadow-md ring-2 ring-orange-500/20' : 'border-slate-200 shadow-xs')
        )
    } flex flex-col justify-between transition-all`;

    // Fallback delicious image if empty
    const imgSrc = snack.image || 'https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=500&auto=format&fit=crop&q=80';

    let overlayBadge = '';
    if (!isStoreOpen) {
      overlayBadge = `
        <div class="absolute inset-0 bg-black/40 backdrop-blur-[1px] flex items-center justify-center rounded-2xl">
          <span class="bg-red-600 text-white text-xs font-bold px-3 py-1.5 rounded-full shadow-md flex items-center gap-1">
            <i data-lucide="lock" class="w-3.5 h-3.5"></i> ปิดรับการสั่งซื้อ
          </span>
        </div>
      `;
    } else if (snack.isAvailable === false) {
      overlayBadge = `
        <div class="absolute inset-0 bg-black/40 backdrop-blur-[1px] flex items-center justify-center rounded-2xl">
          <span class="bg-amber-600 text-white text-xs font-bold px-3 py-1.5 rounded-full shadow-md flex items-center gap-1">
            <i data-lucide="pause-circle" class="w-3.5 h-3.5"></i> สินค้าหมดชั่วคราว
          </span>
        </div>
      `;
    }

    let actionAreaHtml = '';
    if (!isStoreOpen) {
      actionAreaHtml = `
        <div class="pt-3 border-t border-slate-100">
          <div class="flex items-center justify-center gap-2 text-slate-500 bg-slate-100 py-2.5 px-3 rounded-2xl text-xs font-semibold select-none border border-slate-200">
            <span class="w-2 h-2 rounded-full bg-red-500"></span>
            <span>ขณะนี้ร้านปิดรับการสั่งซื้อ</span>
          </div>
        </div>
      `;
    } else if (snack.isAvailable === false) {
      actionAreaHtml = `
        <div class="pt-3 border-t border-slate-100">
          <div class="flex items-center justify-center gap-2 text-amber-700 bg-amber-50 py-2.5 px-3 rounded-2xl text-xs font-semibold select-none border border-amber-200">
            <span class="w-2 h-2 rounded-full bg-amber-500"></span>
            <span>เมนูนี้หมดชั่วคราว</span>
          </div>
        </div>
      `;
    } else {
      actionAreaHtml = `
        <div class="pt-3 border-t border-slate-100 space-y-3">
          <!-- Checkbox Selection (ติ๊กถูกว่าจะเลือกอันไหน) -->
          <label class="flex items-center gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              id="checkbox-${snack.id}"
              class="w-5 h-5 text-orange-600 rounded-lg border-slate-300 focus:ring-orange-500 cursor-pointer accent-orange-600"
              ${isSelected ? 'checked' : ''}
              onchange="toggleSnackSelection('${snack.id}', this.checked)"
            />
            <span class="text-sm font-semibold ${isSelected ? 'text-orange-700' : 'text-slate-700'}">
              ${isSelected ? '✓ เลือกขนมนี้แล้ว' : 'ติ๊กถูกเพื่อเลือกขนมนี้'}
            </span>
          </label>

          <!-- Quantity Controls (เลือกว่าจะเอากี่อัน) -->
          <div id="qty-container-${snack.id}" class="${isSelected ? 'flex' : 'hidden'} items-center justify-between bg-white p-2.5 rounded-2xl border border-orange-200 shadow-xs">
            <span class="text-xs font-semibold text-slate-700 pl-1">จำนวน (${snack.unit || 'ชิ้น'}):</span>
            <div class="flex items-center gap-2">
              <button
                type="button"
                onclick="updateSnackQty('${snack.id}', -1)"
                class="qty-btn w-9 h-9 sm:w-8 sm:h-8 rounded-xl bg-orange-100 hover:bg-orange-200 active:bg-orange-300 text-orange-800 font-extrabold text-base flex items-center justify-center transition active:scale-95 touch-manipulation cursor-pointer shadow-2xs"
                aria-label="ลดจำนวน"
              >-</button>
              <input
                type="number"
                min="1"
                max="999"
                value="${qty}"
                id="qty-input-${snack.id}"
                onchange="setSnackQty('${snack.id}', this.value)"
                class="w-14 text-center text-base sm:text-sm font-bold text-slate-800 focus:outline-none bg-slate-50 rounded-xl py-1.5 border border-slate-200 focus:border-orange-400"
              />
              <button
                type="button"
                onclick="updateSnackQty('${snack.id}', 1)"
                class="qty-btn w-9 h-9 sm:w-8 sm:h-8 rounded-xl bg-orange-100 hover:bg-orange-200 active:bg-orange-300 text-orange-800 font-extrabold text-base flex items-center justify-center transition active:scale-95 touch-manipulation cursor-pointer shadow-2xs"
                aria-label="เพิ่มจำนวน"
              >+</button>
            </div>
          </div>

          <!-- Card Subtotal -->
          <div id="subtotal-${snack.id}" class="${isSelected ? 'flex' : 'hidden'} justify-between items-center text-xs font-semibold text-orange-600 px-1">
            <span>ราคารวมเมนูนี้:</span>
            <span>${subtotal} บาท</span>
          </div>
        </div>
      `;
    }

    card.innerHTML = `
      <div>
        <!-- Snack Image -->
        <div class="relative w-full h-44 rounded-2xl overflow-hidden mb-3.5 bg-slate-100 group">
          <img
            src="${imgSrc}"
            alt="${snack.name}"
            class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            onerror="this.src='https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=500&auto=format&fit=crop&q=80'"
          />
          <div class="absolute top-2.5 right-2.5 bg-white/95 backdrop-blur-md px-3 py-1 rounded-full text-xs font-bold text-orange-600 shadow-sm border border-orange-100">
            ${snack.price} ฿ / ${snack.unit || 'ชิ้น'}
          </div>
          ${overlayBadge}
        </div>

        <!-- Title & Description -->
        <h4 class="font-bold text-slate-900 text-base sm:text-lg leading-snug font-heading mb-1">
          ${snack.name}
        </h4>
        <p class="text-xs text-slate-500 line-clamp-2 mb-3">
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
      card.className = card.className.replace(/border-slate-200|shadow-xs/g, '').trim();
      card.classList.add('border-orange-500', 'bg-amber-50/50', 'shadow-md', 'ring-2', 'ring-orange-500/20');
    }
    if (qtyContainer) qtyContainer.classList.remove('hidden');
    if (subtotalEl) {
      subtotalEl.classList.remove('hidden');
      subtotalEl.innerHTML = `<span>ราคารวมเมนูนี้:</span> <span>${subtotal} บาท</span>`;
    }
  } else {
    if (card) {
      card.classList.remove('border-orange-500', 'bg-amber-50/50', 'shadow-md', 'ring-2', 'ring-orange-500/20');
      card.classList.add('border-slate-200', 'shadow-xs');
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
      <div class="p-8 text-center bg-slate-50 rounded-2xl border border-dashed border-slate-200 text-slate-400 space-y-2">
        <i data-lucide="shopping-cart" class="w-8 h-8 mx-auto text-slate-300"></i>
        <p class="text-sm">ยังไม่ได้เลือกขนม กรุณาติ๊กถูกเลือกขนมที่ต้องการด้านบน</p>
      </div>
    `;
  } else {
    let rowsHtml = items.map(item => `
      <div class="flex items-center justify-between p-3.5 bg-slate-50/80 rounded-2xl border border-slate-200/80 hover:bg-slate-50 transition">
        <div class="flex items-center gap-3">
          <img src="${item.image || 'https://images.unsplash.com/photo-1558961363-fa8fdf82db35?w=200'}" class="w-10 h-10 rounded-xl object-cover border border-slate-200" />
          <div>
            <h5 class="font-bold text-slate-800 text-sm">${item.name}</h5>
            <span class="text-xs text-slate-500">${item.price} บาท × ${item.quantity} ${item.unit}</span>
          </div>
        </div>
        <div class="text-right">
          <span class="font-bold text-orange-600 text-sm">${(item.price * item.quantity).toLocaleString()} บาท</span>
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
  };
  reader.readAsDataURL(file);
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

  // Show saving progress
  Swal.fire({
    title: 'กำลังส่งคำสั่งซื้อ...',
    text: 'กรุณารอสักครู่ ระบบกำลังบันทึกข้อมูลออเดอร์...',
    allowOutsideClick: false,
    didOpen: () => Swal.showLoading()
  });

  const formData = new FormData();
  if (currentSlipFile) {
    formData.append('slip', currentSlipFile);
  }
  if (uploadedSlipUrl) {
    formData.append('existingSlipUrl', uploadedSlipUrl);
  }
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

      // Save to local storage history
      saveOrderToLocalHistory(data.order.id);
      updateHistoryBadge();

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
  const slipInput = document.getElementById('slipInput');
  if (slipInput) slipInput.value = '';
  document.getElementById('slipDropZone').classList.remove('hidden');
  document.getElementById('slipVerificationBox').classList.add('hidden');

  const confirmSection = document.getElementById('customerConfirmSection');
  if (confirmSection) confirmSection.classList.add('hidden');
  const hintBanner = document.getElementById('slipHintBanner');
  if (hintBanner) hintBanner.classList.remove('hidden');
}

// Display verification result card with badges and details
function displayVerificationResult(v, expectedAmount) {
  const card = document.getElementById('verificationResultCard');
  const iconContainer = document.getElementById('statusIconContainer');
  const title = document.getElementById('verificationTitle');
  const summary = document.getElementById('verificationSummary');

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
      detectedQrBox.className = 'col-span-2 flex items-center justify-between bg-slate-50 px-3 py-1.5 rounded-xl border border-slate-200';
      detectedQrText.innerText = 'ไม่พบ QR Code ในรูป (ใช้การอ่านข้อความจาก AI)';
      detectedQrText.className = 'font-medium text-slate-500 text-xs';
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

  if (v.isDuplicateSlip || v.status === 'DUPLICATE_SLIP') {
    // Duplicate slip detected!
    card.classList.add('bg-red-50', 'border-red-300');
    iconContainer.className = 'w-8 h-8 rounded-full bg-red-600 text-white flex items-center justify-center shrink-0 shadow-sm';
    iconContainer.innerHTML = '<i data-lucide="shield-alert" class="w-5 h-5"></i>';
    title.className = 'text-sm font-bold text-red-900';
    title.innerText = '🚫 สลิปนี้ซ้ำ! เคยถูกใช้งานในระบบแล้ว';
    summary.className = 'text-xs text-red-700 font-medium';
    summary.innerText = v.message || 'ตรวจพบว่าสลิปนี้เคยถูกใช้สั่งซื้อไปแล้ว กรุณาใช้สลิปการโอนเงินใหม่';
  } else if (v.status === 'VALID_AND_MATCHED' || v.isReadyToSave) {
    // Exact Match, Valid Date & Valid Shop Receiver!
    card.classList.add('bg-emerald-50', 'border-emerald-200');
    iconContainer.className = 'w-8 h-8 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0 shadow-sm';
    iconContainer.innerHTML = '<i data-lucide="check-circle" class="w-5 h-5"></i>';
    title.className = 'text-sm font-bold text-emerald-900';
    title.innerText = '✅ สลิปถูกต้อง! โอนเข้าบัญชีร้านและยอดเงินตรงกัน';
    summary.className = 'text-xs text-emerald-700';
    summary.innerText = `โอนเข้า: ${v.receiverName} | ยอดเงิน: ${v.detectedAmount?.toFixed(2)} บาท | โอนวันนี้ถูกต้อง${v.hasQrCode ? ' (ตรวจ QR ผ่าน)' : ''}`;
  } else if (v.status === 'RECEIVER_MISMATCHED' || !v.isReceiverMatched) {
    // Receiver Mismatch (Not the shop's account!)
    card.classList.add('bg-red-50', 'border-red-200');
    iconContainer.className = 'w-8 h-8 rounded-full bg-red-500 text-white flex items-center justify-center shrink-0 shadow-sm';
    iconContainer.innerHTML = '<i data-lucide="shield-alert" class="w-5 h-5"></i>';
    title.className = 'text-sm font-bold text-red-900';
    title.innerText = '❌ สลิปนี้ไม่ได้โอนเข้าบัญชีของทางร้าน';
    summary.className = 'text-xs text-red-700';
    summary.innerText = v.message || `ชื่อผู้รับในสลิป (${v.receiverName || 'ไม่ระบุ'}) ไม่ตรงกับบัญชีของร้าน`;
  } else if (v.status === 'AMOUNT_MISMATCHED' || (!v.isAmountMatched && v.detectedAmount !== null)) {
    // Amount Mismatch
    card.classList.add('bg-amber-50', 'border-amber-200');
    iconContainer.className = 'w-8 h-8 rounded-full bg-amber-500 text-white flex items-center justify-center shrink-0 shadow-sm';
    iconContainer.innerHTML = '<i data-lucide="alert-triangle" class="w-5 h-5"></i>';
    title.className = 'text-sm font-bold text-amber-900';
    title.innerText = '⚠️ ยอดเงินในสลิปไม่ตรงกับยอดที่สั่งซื้อ';
    summary.className = 'text-xs text-amber-800';
    const diff = v.amountDifference || 0;
    summary.innerText = `ยอดในสลิปคือ ${v.detectedAmount?.toFixed(2) || 0} บาท แต่มียอดสั่งซื้อ ${expectedAmount.toFixed(2)} บาท (${diff < 0 ? 'ขาด ' + Math.abs(diff).toFixed(2) : 'เกิน +' + diff.toFixed(2)} บาท)`;
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

// Order Status definitions & styles
function getOrderStatusInfo(status) {
  switch (status) {
    case 'preparing':
      return {
        label: '👨‍🍳 กำลังเตรียมขนม',
        step: 2,
        progressPercent: '50%',
        badgeClass: 'bg-orange-100 text-orange-800 border-orange-200',
        detail: '👨‍🍳 ร้านแม้วกำลังอบและจัดเตรียมขนมสดใหม่ตามออเดอร์ของคุณอย่างตั้งใจ',
        step1Active: true,
        step2Active: true,
        step3Active: false
      };
    case 'delivered':
      return {
        label: '🚚 ส่งมอบเรียบร้อย',
        step: 3,
        progressPercent: '100%',
        badgeClass: 'bg-emerald-100 text-emerald-800 border-emerald-200',
        detail: '🚚 ขนมส่งมอบเรียบร้อยแล้ว หรือพร้อมให้คุณรับประทานแล้ว ทานให้อร่อยนะจ๊ะ! 🐾',
        step1Active: true,
        step2Active: true,
        step3Active: true
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
        step3Active: false
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
        step3Active: false
      };
    case 'verified':
      return {
        label: '🟢 ยืนยันสลิปแล้ว',
        step: 1,
        progressPercent: '40%',
        badgeClass: 'bg-emerald-100 text-emerald-800 border-emerald-200',
        detail: '🟢 ร้านแม้วตรวจสอบและยืนยันสลิปเรียบร้อยแล้ว กำลังจัดเตรียมคิวทำขนมสดใหม่ให้คุณครับ 🍰',
        step1Active: true,
        step2Active: false,
        step3Active: false
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
        step3Active: false
      };
  }
}

// Render Status Stepper in Receipt Modal
function renderReceiptStatus(order) {
  const statusInfo = getOrderStatusInfo(order.orderStatus);
  const progressLine = document.getElementById('modalStatusProgressLine');
  const step1Icon = document.getElementById('modalStep1Icon');
  const step2Icon = document.getElementById('modalStep2Icon');
  const step3Icon = document.getElementById('modalStep3Icon');
  const step1Text = document.getElementById('modalStep1Text');
  const step2Text = document.getElementById('modalStep2Text');
  const step3Text = document.getElementById('modalStep3Text');
  const detailBox = document.getElementById('modalStatusDetailBox');

  if (progressLine) progressLine.style.width = statusInfo.progressPercent;

  if (order.orderStatus === 'cancelled') {
    if (step1Icon) step1Icon.className = 'w-8 h-8 rounded-full bg-red-500 text-white flex items-center justify-center text-xs font-bold';
    if (step2Icon) step2Icon.className = 'w-8 h-8 rounded-full bg-slate-200 text-slate-400 flex items-center justify-center text-xs font-bold';
    if (step3Icon) step3Icon.className = 'w-8 h-8 rounded-full bg-slate-200 text-slate-400 flex items-center justify-center text-xs font-bold';
    if (detailBox) {
      detailBox.className = 'bg-red-50 p-2.5 rounded-xl border border-red-200 text-xs text-center font-bold text-red-800';
      detailBox.innerText = statusInfo.detail;
    }
    return;
  }

  // Step 1
  if (step1Icon) {
    step1Icon.className = statusInfo.step1Active
      ? 'w-8 h-8 rounded-full bg-orange-600 text-white flex items-center justify-center text-xs font-bold shadow-sm transition'
      : 'w-8 h-8 rounded-full bg-orange-200 text-orange-700 flex items-center justify-center text-xs font-bold';
    step1Icon.innerHTML = statusInfo.step1Active ? '✓' : '1';
  }
  if (step1Text) {
    step1Text.className = statusInfo.step1Active ? 'text-[10px] font-bold text-orange-900' : 'text-[10px] font-semibold text-slate-500';
  }

  // Step 2
  if (step2Icon) {
    step2Icon.className = statusInfo.step2Active
      ? 'w-8 h-8 rounded-full bg-orange-600 text-white flex items-center justify-center text-xs font-bold shadow-sm transition'
      : 'w-8 h-8 rounded-full bg-orange-200 text-orange-700 flex items-center justify-center text-xs font-bold';
    step2Icon.innerHTML = statusInfo.step2Active ? (statusInfo.step3Active ? '✓' : '👨‍🍳') : '2';
  }
  if (step2Text) {
    step2Text.className = statusInfo.step2Active ? 'text-[10px] font-bold text-orange-900' : 'text-[10px] font-semibold text-slate-500';
  }

  // Step 3
  if (step3Icon) {
    step3Icon.className = statusInfo.step3Active
      ? 'w-8 h-8 rounded-full bg-emerald-600 text-white flex items-center justify-center text-xs font-bold shadow-sm transition'
      : 'w-8 h-8 rounded-full bg-orange-200 text-orange-700 flex items-center justify-center text-xs font-bold';
    step3Icon.innerHTML = statusInfo.step3Active ? '✓' : '3';
  }
  if (step3Text) {
    step3Text.className = statusInfo.step3Active ? 'text-[10px] font-bold text-emerald-800' : 'text-[10px] font-semibold text-slate-500';
  }

  // Detail box
  if (detailBox) {
    detailBox.className = 'bg-white p-2.5 rounded-xl border border-orange-200 text-xs text-center font-semibold text-slate-800 shadow-2xs';
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
  if (order.orderStatus === 'verified' || order.orderStatus === 'preparing' || order.orderStatus === 'delivered') {
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
    <div class="py-12 text-center text-slate-400 space-y-2">
      <div class="spinner mx-auto border-3 w-8 h-8 border-orange-200 border-t-orange-600"></div>
      <p class="text-xs">กำลังโหลดประวัติคำสั่งซื้อ...</p>
    </div>
  `;

  try {
    const localIds = getLocalOrderIds();
    let url = '/api/orders-history';
    if (searchQuery) {
      url += `?query=${encodeURIComponent(searchQuery)}`;
    } else if (localIds.length > 0) {
      url += `?ids=${localIds.join(',')}`;
    } else {
      // Nothing locally yet
      renderEmptyOrderHistory();
      return;
    }

    const res = await fetch(url);
    const data = await res.json();

    if (data.success && data.data && data.data.length > 0) {
      // If search returned orders, also merge their IDs into local storage so the customer keeps them!
      data.data.forEach(o => saveOrderToLocalHistory(o.id));

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
    <div class="py-12 px-4 text-center text-slate-400 space-y-3 bg-slate-50/60 rounded-2xl border border-dashed border-slate-200">
      <div class="w-14 h-14 rounded-full bg-orange-100 text-orange-600 text-2xl flex items-center justify-center mx-auto">
        🐾
      </div>
      <div>
        <p class="font-bold text-slate-700 text-sm">${customMsg || 'ยังไม่มีประวัติการสั่งซื้อบนอุปกรณ์นี้'}</p>
        <p class="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
          หากเคยสั่งซื้อไว้ สามารถพิมพ์เบอร์โทรศัพท์ที่ใช้สั่ง หรือรหัสออเดอร์ (MW-...) ในช่องค้นหาด้านบนเพื่อดึงข้อมูลได้ทันทีครับ
        </p>
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
    card.className = 'bg-white p-4 rounded-2xl border border-slate-200/80 shadow-xs hover:border-orange-300 transition space-y-3';
    card.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
        <div>
          <div class="font-mono font-bold text-orange-600 text-xs flex items-center gap-1.5">
            <span>${order.id}</span>
          </div>
          <div class="text-[11px] text-slate-400">${dateFormatted}</div>
        </div>
        <span class="px-2.5 py-1 rounded-full text-xs font-bold border ${statusInfo.badgeClass}">
          ${statusInfo.label}
        </span>
      </div>

      <!-- Items & Price -->
      <div class="flex items-center justify-between text-xs text-slate-700">
        <div class="font-medium text-slate-800 line-clamp-1 pr-2" title="${itemsSummary}">
          🍪 ${itemsSummary || 'รายการขนม'}
        </div>
        <div class="font-bold text-orange-600 text-sm shrink-0">
          ${order.totalPrice.toLocaleString()} ฿
        </div>
      </div>

      <!-- Mini Stepper Indicator -->
      <div class="bg-slate-50 p-2.5 rounded-xl border border-slate-100 text-[11px] space-y-1.5">
        <div class="flex justify-between items-center text-slate-500 font-semibold text-[10px]">
          <span class="${statusInfo.step1Active ? 'text-orange-600 font-bold' : ''}">1. รับยอดแล้ว</span>
          <span class="${statusInfo.step2Active ? 'text-orange-600 font-bold' : ''}">2. กำลังทำ</span>
          <span class="${statusInfo.step3Active ? 'text-emerald-600 font-bold' : ''}">3. ส่งมอบ</span>
        </div>
        <div class="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
          <div class="bg-orange-500 h-full rounded-full transition-all" style="width: ${statusInfo.progressPercent}"></div>
        </div>
        <p class="text-slate-600 text-[11px] font-medium pt-0.5">
          ${statusInfo.detail}
        </p>
      </div>

      <!-- Action Button -->
      <div class="pt-1 flex justify-end">
        <button
          type="button"
          onclick="viewOrderDetailFromHistory('${order.id}')"
          class="bg-orange-50 hover:bg-orange-100 text-orange-700 px-3.5 py-1.5 rounded-xl text-xs font-bold transition border border-orange-200 flex items-center gap-1 cursor-pointer"
        >
          <i data-lucide="receipt" class="w-3.5 h-3.5"></i>
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

