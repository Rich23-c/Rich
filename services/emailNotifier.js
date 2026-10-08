const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const db = require('./database');

/**
 * Create Nodemailer transporter based on settings
 */
function createTransporter(settings) {
  const user = settings.emailSender?.trim();
  const pass = settings.emailAppPassword?.trim()?.replace(/\s+/g, ''); // strip spaces in app password

  if (!user || !pass) return null;

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: user,
      pass: pass
    }
  });
}

/**
 * Send order notification email to shop owner
 * @param {object} order - The created order object
 * @returns {Promise<boolean>}
 */
async function sendOrderEmail(order) {
  const settings = db.getSettings();
  const receiver = settings.emailReceiver?.trim() || settings.emailSender?.trim();

  if (!settings.emailSender || !settings.emailAppPassword || !receiver) {
    console.log('[Email Notification] Skipped: Email settings not fully configured.');
    return false;
  }

  const transporter = createTransporter(settings);
  if (!transporter) return false;

  try {
    const v = order.slipVerification || {};
    const slipStatusBadge = v.isReadyToSave || v.status === 'VALID_AND_MATCHED' || v.isAmountMatched
      ? '<span style="color:#16a34a; font-weight:bold; background:#dcfce7; padding:4px 8px; rounded:6px;">✅ ตรวจสอบแล้ว: ยอดเงินและวันโอนถูกต้อง</span>'
      : '<span style="color:#d97706; font-weight:bold; background:#fef3c7; padding:4px 8px; rounded:6px;">⚠️ รอตรวจสอบสลิปเพิ่มเติม</span>';

    const itemsRows = (order.items || [])
      .map(item => `
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 10px 8px; color: #1e293b; font-size: 14px;">${item.name}</td>
          <td style="padding: 10px 8px; text-align: center; color: #475569; font-size: 14px;">${item.quantity} ${item.unit || 'ชิ้น'}</td>
          <td style="padding: 10px 8px; text-align: right; color: #ea580c; font-weight: bold; font-size: 14px;">${Number(item.subtotal || 0).toLocaleString()} ฿</td>
        </tr>
      `).join('');

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 20px; overflow: hidden; border: 1px solid #fed7aa; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
          .header { background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); padding: 24px 20px; text-align: center; color: white; }
          .body { padding: 24px 20px; }
          .badge { display: inline-block; background: rgba(255,255,255,0.2); padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: bold; margin-bottom: 8px; }
          .card { background: #fff7ed; border: 1px solid #ffedd5; border-radius: 14px; padding: 14px 16px; margin-bottom: 20px; }
          .total-box { background: #f8fafc; border-radius: 14px; padding: 16px; text-align: right; margin-top: 16px; border: 1px solid #e2e8f0; }
          .footer { text-align: center; padding: 18px; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="badge">🐾 ร้านขนมแม้ว (Snack by Maew)</div>
            <h1 style="margin: 0; font-size: 22px;">🎉 มีออเดอร์ใหม่เข้ามาแล้ว!</h1>
            <p style="margin: 6px 0 0; font-size: 13px; opacity: 0.9;">รหัสคำสั่งซื้อ: ${order.id}</p>
          </div>

          <div class="body">
            <!-- Customer Details -->
            <div class="card">
              <div style="font-size: 12px; font-weight: bold; color: #c2410c; margin-bottom: 8px;">👤 ข้อมูลผู้สั่งซื้อ</div>
              <div style="font-size: 15px; font-weight: bold; color: #1e293b;">คุณ ${order.customerName}</div>
              <div style="font-size: 13px; color: #64748b; margin-top: 4px;">📞 เบอร์โทรศัพท์: ${order.customerPhone || 'ไม่ได้ระบุ'}</div>
              <div style="font-size: 13px; color: #64748b; margin-top: 2px;">⏰ เวลาสั่งซื้อ: ${new Date(order.createdAt).toLocaleString('th-TH')}</div>
            </div>

            <!-- Order Items Table -->
            <h3 style="font-size: 15px; color: #1e293b; margin: 0 0 10px;">📦 รายการขนมที่สั่ง:</h3>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 12px;">
              <thead>
                <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                  <th style="padding: 8px; text-align: left; font-size: 12px; color: #64748b;">ขนม</th>
                  <th style="padding: 8px; text-align: center; font-size: 12px; color: #64748b;">จำนวน</th>
                  <th style="padding: 8px; text-align: right; font-size: 12px; color: #64748b;">ราคารวม</th>
                </tr>
              </thead>
              <tbody>
                ${itemsRows}
              </tbody>
            </table>

            <!-- Total Price -->
            <div class="total-box">
              <span style="font-size: 14px; color: #64748b; margin-right: 12px;">ยอดชำระทั้งหมด:</span>
              <span style="font-size: 24px; font-weight: bold; color: #ea580c;">${Number(order.totalPrice || 0).toLocaleString()} บาท</span>
            </div>

            <!-- Slip Status -->
            <div style="margin-top: 20px; padding: 14px; background: #fafafa; border-radius: 12px; border: 1px solid #f1f5f9;">
              <div style="font-size: 13px; font-weight: bold; color: #334155; margin-bottom: 6px;">📄 สถานะการตรวจสอบสลิป:</div>
              <div>${slipStatusBadge}</div>
              ${order.slipImage ? '<div style="margin-top: 8px; font-size: 12px; color: #64748b;">💡 ระบบได้แนบรูปสลิปเงินจริงมาพร้อมกับอีเมลฉบับนี้แล้ว สามารถเปิดดูได้ทันที</div>' : ''}
            </div>

            <!-- Admin Link Button -->
            <div style="text-align: center; margin-top: 24px;">
              <a href="http://localhost:3001" style="display: inline-block; background: #f97316; color: white; text-decoration: none; font-weight: bold; font-size: 14px; padding: 12px 28px; border-radius: 12px; box-shadow: 0 2px 4px rgba(249,115,22,0.3);">
                เข้าสู่ระบบจัดการหลังบ้าน (เว็บแอดมิน)
              </a>
            </div>
          </div>

          <div class="footer">
            ระบบแจ้งเตือนอัตโนมัติ ร้านขนมแม้ว 🐾 (Snack by Maew)<br>
            อีเมลฉบับนี้ส่งไปยัง: ${receiver}
          </div>
        </div>
      </body>
      </html>
    `;

    // Prepare attachments (if slip image exists on disk)
    const attachments = [];
    if (order.slipImage) {
      // Slip image relative url like /uploads/slips/slip-xxx.jpg
      const cleanPath = order.slipImage.startsWith('/') ? order.slipImage.slice(1) : order.slipImage;
      const fullPath = path.join(__dirname, '..', cleanPath);
      if (fs.existsSync(fullPath)) {
        attachments.push({
          filename: `slip-${order.id}.jpg`,
          path: fullPath
        });
      }
    }

    // Send to both receiver and sender so shop owner gets it wherever they check
    const targetRecipients = Array.from(new Set([
      receiver,
      settings.emailSender?.trim()
    ].filter(Boolean))).join(', ');

    const mailOptions = {
      from: `"ร้านขนมแม้ว 🐾" <${settings.emailSender}>`,
      to: targetRecipients,
      subject: `🍞 [ออเดอร์ใหม่] ร้านขนมแม้ว - คุณ ${order.customerName} (ยอด ${Number(order.totalPrice).toLocaleString()} บาท)`,
      html: htmlContent,
      attachments: attachments
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('[Email Notification] Sent successfully to shop:', targetRecipients, info.messageId);

    // Also send confirmation receipt to customer if customer provided email
    if (order.customerEmail && order.customerEmail.includes('@')) {
      sendCustomerReceiptEmail(order, settings, transporter).catch(err => {
        console.warn('[Customer Email] Error sending to customer:', err.message);
      });
    }

    return true;
  } catch (err) {
    console.error('[Email Notification] Failed to send email:', err.message);
    return false;
  }
}

/**
 * Send receipt confirmation email directly to customer
 */
async function sendCustomerReceiptEmail(order, settings, transporter) {
  try {
    const itemsRows = (order.items || [])
      .map(item => `
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 10px 8px; color: #1e293b; font-size: 14px;">${item.name}</td>
          <td style="padding: 10px 8px; text-align: center; color: #475569; font-size: 14px;">${item.quantity} ${item.unit || 'ชิ้น'}</td>
          <td style="padding: 10px 8px; text-align: right; color: #ea580c; font-weight: bold; font-size: 14px;">${Number(item.subtotal || 0).toLocaleString()} ฿</td>
        </tr>
      `).join('');

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #fff7ed; margin: 0; padding: 20px;">
        <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 20px; overflow: hidden; border: 1px solid #fed7aa; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
          <div style="background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); padding: 24px 20px; text-align: center; color: white;">
            <div style="display: inline-block; background: rgba(255,255,255,0.2); padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: bold; margin-bottom: 8px;">🐾 ร้านขนมแม้ว (Snack by Maew)</div>
            <h1 style="margin: 0; font-size: 22px;">🎉 ยืนยันการสั่งซื้อขนมสำเร็จ!</h1>
            <p style="margin: 6px 0 0; font-size: 13px; opacity: 0.9;">รหัสคำสั่งซื้อ: ${order.id}</p>
          </div>

          <div style="padding: 24px 20px;">
            <p style="font-size: 15px; color: #1e293b; margin-top: 0;">
              สวัสดีครับ <b>คุณ ${order.customerName}</b> 🐱<br>
              ทางร้านได้รับรายการสั่งซื้อและตรวจสอบยอดเงินเรียบร้อยแล้วครับ เชฟแม้วกำลังเตรียมจัดทำขนมสดใหม่ให้คุณ!
            </p>

            <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 12px; padding: 12px; margin-bottom: 18px; font-size: 13px; color: #065f46; font-weight: bold;">
              ✅ สถานะ: ตรวจสอบสลิปและยอดเงินผ่านแล้ว (ร้านกำลังเตรียมขนม)
            </div>

            <h3 style="font-size: 14px; color: #1e293b; margin: 0 0 10px;">📦 รายการขนมของคุณ:</h3>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 12px;">
              <thead>
                <tr style="background: #f8fafc; border-bottom: 2px solid #e2e8f0;">
                  <th style="padding: 8px; text-align: left; font-size: 12px; color: #64748b;">ขนม</th>
                  <th style="padding: 8px; text-align: center; font-size: 12px; color: #64748b;">จำนวน</th>
                  <th style="padding: 8px; text-align: right; font-size: 12px; color: #64748b;">ราคารวม</th>
                </tr>
              </thead>
              <tbody>
                ${itemsRows}
              </tbody>
            </table>

            <div style="background: #f8fafc; border-radius: 12px; padding: 14px; text-align: right; margin-top: 14px; border: 1px solid #e2e8f0;">
              <span style="font-size: 13px; color: #64748b; margin-right: 12px;">ยอดชำระทั้งหมด:</span>
              <span style="font-size: 22px; font-weight: bold; color: #ea580c;">${Number(order.totalPrice || 0).toLocaleString()} บาท</span>
            </div>

            <div style="text-align: center; margin-top: 22px;">
              <a href="http://localhost:3000" style="display: inline-block; background: #f97316; color: white; text-decoration: none; font-weight: bold; font-size: 13px; padding: 10px 24px; border-radius: 12px;">
                ดูสถานะออเดอร์บนเว็บไซต์
              </a>
            </div>
          </div>

          <div style="text-align: center; padding: 16px; font-size: 11px; color: #94a3b8; border-top: 1px solid #f1f5f9;">
            ขอบคุณที่อุดหนุนร้านขนมแม้ว 🐾<br>
            โทร: ${settings.contactPhone || '089-123-4567'} &bull; LINE: ${settings.contactLine || '@snackbymaew'}
          </div>
        </div>
      </body>
      </html>
    `;

    await transporter.sendMail({
      from: `"ร้านขนมแม้ว 🐾" <${settings.emailSender}>`,
      to: order.customerEmail.trim(),
      subject: `🎉 ยืนยันการสั่งซื้อขนม ร้านขนมแม้ว (รหัส ${order.id})`,
      html: htmlContent
    });
    console.log('[Customer Email] Sent receipt successfully to customer:', order.customerEmail);
  } catch (err) {
    console.error('[Customer Email] Failed to send to customer:', err.message);
  }
}

/**
 * Send a test email to verify credentials
 */
async function sendTestEmail(receiver, sender, appPassword) {
  const cleanPass = appPassword?.trim()?.replace(/\s+/g, '');
  const cleanSender = sender?.trim();
  const cleanReceiver = receiver?.trim() || cleanSender;

  if (!cleanSender || !cleanPass) {
    throw new Error('กรุณาระบุ Email ผู้ส่ง และ รหัสผ่านแอป (App Password)');
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: cleanSender,
      pass: cleanPass
    }
  });

  const targetRecipients = Array.from(new Set([cleanReceiver, cleanSender].filter(Boolean))).join(', ');

  const mailOptions = {
    from: `"ร้านขนมแม้ว 🐾" <${cleanSender}>`,
    to: targetRecipients,
    subject: `🔔 ทดสอบการแจ้งเตือนอีเมล - ร้านขนมแม้ว 🐾`,
    html: `
      <div style="font-family: sans-serif; padding: 20px; background: #fff7ed; border-radius: 16px; border: 1px solid #fed7aa; max-width: 500px; margin: 0 auto;">
        <h2 style="color: #ea580c; margin-top: 0;">🎉 เชื่อมต่อระบบแจ้งเตือน Email สำเร็จ!</h2>
        <p style="color: #334155; font-size: 14px; line-height: 1.6;">
          ระบบร้านขนมแม้วสามารถส่งอีเมลแจ้งเตือนมายังกล่องข้อความของคุณได้เรียบร้อยแล้ว<br><br>
          เมื่อมีลูกค้าสั่งซื้อขนมและแนบสลิปเข้ามา ระบบจะส่งรายละเอียดออเดอร์ ยอดเงิน และรูปสลิปมาที่อีเมลนี้ทันทีครับ 🐱✨
        </p>
        <div style="font-size: 12px; color: #94a3b8; border-top: 1px solid #fed7aa; padding-top: 10px; margin-top: 15px;">
          ส่งเมื่อ: ${new Date().toLocaleString('th-TH')}
        </div>
      </div>
    `
  };

  const info = await transporter.sendMail(mailOptions);
  return info;
}

module.exports = {
  sendOrderEmail,
  sendTestEmail
};
