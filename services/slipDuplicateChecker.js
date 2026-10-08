const db = require('./database');

function cleanRef(ref) {
  if (!ref) return '';
  return String(ref)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Check if an uploaded slip has already been used in any previous order.
 * Checks 3 layers of defense:
 * 1. QR Code payload match (exact cryptographic match)
 * 2. Transaction Reference ID match (e.g. 50059166976662, 0142831...)
 * 3. Exact image file hash (SHA-256) match
 * 
 * @param {object} params
 * @param {string} params.fileHash - SHA-256 hash of the slip image file
 * @param {string} params.qrData - Decoded QR code string from the slip
 * @param {string} params.transactionRef - Transaction reference extracted by AI or QR
 * @param {string} [params.excludeOrderId] - Optional order ID to skip (when re-checking same order)
 * @returns {{ isDuplicate: boolean, matchedBy?: string, matchedOrderId?: string, matchedCustomerName?: string, message?: string }}
 */
function checkDuplicateSlip({ fileHash, qrData, transactionRef, excludeOrderId = null }) {
  const orders = db.getOrders();
  const targetRef = cleanRef(transactionRef);
  const targetQr = (qrData || '').trim();

  for (const order of orders) {
    if (excludeOrderId && order.id === excludeOrderId) continue;

    const existingVerification = order.slipVerification || {};
    const existingRef = cleanRef(existingVerification.transactionRef || order.transactionRef);
    const existingQr = (existingVerification.qrData || existingVerification.rawQrData || '').trim();
    const existingHash = order.fileHash || existingVerification.fileHash;

    const thaiOrderDate = new Date(order.createdAt).toLocaleString('th-TH', {
      day: 'numeric',
      month: 'short',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });

    // Check 1: QR Code Match (Most accurate & cryptographic)
    if (targetQr && existingQr && targetQr === existingQr) {
      return {
        isDuplicate: true,
        matchedBy: 'QR_CODE',
        matchedOrderId: order.id,
        matchedCustomerName: order.customerName,
        message: `🚫 สลิปนี้เคยถูกใช้งานแล้ว! ตรวจพบ QR Code ในสลิปตรงกับออเดอร์ #${order.id} (${order.customerName}) ที่สั่งซื้อเมื่อ ${thaiOrderDate} ห้ามนำสลิปเก่ามาใช้ซ้ำ`
      };
    }

    // Check 2: Transaction Reference ID Match
    if (targetRef && existingRef && targetRef.length >= 6 && targetRef === existingRef) {
      return {
        isDuplicate: true,
        matchedBy: 'TRANSACTION_REF',
        matchedOrderId: order.id,
        matchedCustomerName: order.customerName,
        message: `🚫 สลิปนี้เคยถูกใช้งานแล้ว! เลขอ้างอิงธุรกรรม "${transactionRef}" ตรงกับออเดอร์ #${order.id} (${order.customerName}) ที่สั่งซื้อเมื่อ ${thaiOrderDate} ห้ามนำสลิปเก่ามาใช้ซ้ำ`
      };
    }

    // Check 3: File Hash Match (Exact identical image file)
    if (fileHash && existingHash && fileHash === existingHash) {
      return {
        isDuplicate: true,
        matchedBy: 'FILE_HASH',
        matchedOrderId: order.id,
        matchedCustomerName: order.customerName,
        message: `🚫 สลิปนี้เคยถูกส่งมาแล้ว! รูปสลิปนี้ตรงกับออเดอร์ #${order.id} (${order.customerName}) ในระบบ กรุณาใช้สลิปการโอนรอบนี้จริง`
      };
    }
  }

  return { isDuplicate: false };
}

module.exports = {
  checkDuplicateSlip,
  cleanRef
};
