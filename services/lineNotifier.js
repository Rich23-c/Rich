const db = require('./database');

/**
 * Send order notification to LINE via LINE Messaging API
 * @param {object} order - The created order object
 * @returns {Promise<boolean>}
 */
async function sendOrderNotification(order) {
  const settings = db.getSettings();
  const token = settings.lineChannelAccessToken;
  const to = settings.lineTargetId; // User ID or Group ID (starts with U... or C...)

  if (!token || !to) {
    console.log('[LINE Notification] Skipped: lineChannelAccessToken or lineTargetId not configured in settings.');
    return false;
  }

  try {
    const itemsText = (order.items || [])
      .map(item => `• ${item.name} x${item.quantity} ${item.unit} (${item.subtotal}฿)`)
      .join('\n');

    const v = order.slipVerification || {};
    const slipStatusText = v.isReadyToSave || v.status === 'VALID_AND_MATCHED' || v.isAmountMatched
      ? `✅ ยอดเงินและวันที่ถูกต้อง (${order.totalPrice}฿)`
      : `⚠️ ตรวจสอบยอด: ${v.detectedAmount || 'รอตรวจ'}`;

    const messageText = `🐾 มีคำสั่งซื้อใหม่! ร้านขนมแม้ว
━━━━━━━━━━━━━━
👤 ลูกค้า: ${order.customerName}
📞 เบอร์ติดต่อ: ${order.customerPhone || 'ไม่ระบุ'}
📦 รายการขนม:
${itemsText}
💰 ยอดรวม: ${order.totalPrice.toLocaleString()} บาท
📄 สลิปโอนเงิน: ${slipStatusText}
⏰ เวลาสั่งซื้อ: ${new Date(order.createdAt).toLocaleString('th-TH')}
━━━━━━━━━━━━━━
🔗 ดูหลังบ้าน: http://localhost:3001`;

    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        to: to,
        messages: [
          {
            type: 'text',
            text: messageText
          }
        ]
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('[LINE Notification] Failed to send push message:', response.status, errBody);
      return false;
    }

    console.log('[LINE Notification] Sent successfully for order:', order.id);
    return true;
  } catch (err) {
    console.error('[LINE Notification] Error sending notification:', err.message);
    return false;
  }
}

/**
 * Send a test notification to verify LINE setup
 */
async function sendTestNotification(token, targetId) {
  if (!token || !targetId) {
    throw new Error('กรุณาระบุ Channel Access Token และ User/Group ID');
  }

  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      to: targetId,
      messages: [
        {
          type: 'text',
          text: `🔔 ทดสอบการแจ้งเตือนจากระบบร้านขนมแม้ว 🐾\nเชื่อมต่อกับ LINE เรียบร้อยแล้ว! เมื่อมีลูกค้าสั่งขนมเข้ามา ระบบจะแจ้งเตือนมาที่นี่ทันทีครับ 🐱✨`
        }
      ]
    })
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`LINE API Error (${response.status}): ${errBody}`);
  }

  return true;
}

module.exports = {
  sendOrderNotification,
  sendTestNotification
};
