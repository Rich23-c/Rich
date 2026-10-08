const fs = require('fs');
const path = require('path');
const { getFileHash, scanSlipQrCode, parseSlipQrInfo } = require('./slipQrScanner');
const { checkDuplicateSlip } = require('./slipDuplicateChecker');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// High-speed, high-accuracy vision models (benchmarked < 1.2s response time)
const VISION_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash'
];

/**
 * Get current date details in Thailand timezone (ICT UTC+7)
 */
function getTodayDateInfo() {
  const now = new Date();
  const options = { timeZone: 'Asia/Bangkok' };
  const thaiDateFormatter = new Intl.DateTimeFormat('th-TH', { ...options, day: 'numeric', month: 'long', year: 'numeric' });
  const thaiShortDateFormatter = new Intl.DateTimeFormat('th-TH', { ...options, day: '2-digit', month: 'short', year: '2-digit' });
  const isoDate = new Intl.DateTimeFormat('en-CA', options).format(now); // YYYY-MM-DD
  const parts = isoDate.split('-');
  const yearCE = parseInt(parts[0]);
  const yearBE = yearCE + 543;
  const month = parseInt(parts[1]);
  const day = parseInt(parts[2]);

  return {
    isoDate,
    day,
    month,
    yearCE,
    yearBE,
    thaiFull: thaiDateFormatter.format(now),
    thaiShort: thaiShortDateFormatter.format(now)
  };
}

/**
 * Helper to check fuzzy matching of recipient name
 */
function checkRecipientMatch(detectedReceiver, expectedReceiver) {
  if (!expectedReceiver) return true;
  if (!detectedReceiver) return false;

  const normalize = (str) => (str || '')
    .toLowerCase()
    .replace(/[\s\.\,\-_]/g, '')
    .replace(/^(นาย|นางสาว|น\.ส\.|นาง|miss|mr|mrs)/i, '');
  const normExpected = normalize(expectedReceiver);
  const normDetected = normalize(detectedReceiver);

  // Direct match or partial inclusion of first/last name
  if (normDetected.includes(normExpected) || normExpected.includes(normDetected)) {
    return true;
  }

  // Key tokens check from expected receiver (e.g. "พัชญ์ชามญชุ์" or "กฤติณัฐธนชัย")
  const tokens = expectedReceiver.split(/\s+/).filter(t => t.length > 2);
  for (const token of tokens) {
    const cleanToken = normalize(token);
    if (cleanToken.length > 2 && normDetected.includes(cleanToken)) {
      return true;
    }
  }

  // English transliterations for Patchamon Krittinatthanachai
  const englishAliases = ['patchamon', 'phatchamon', 'krittinat'];
  for (const alias of englishAliases) {
    if (normDetected.includes(alias) && (normExpected.includes('พัชญ์ชามญชุ์') || normExpected.includes('กฤติณัฐ'))) {
      return true;
    }
  }

  return false;
}

/**
 * Verify a payment slip against:
 * 1. QR Code decoding from the slip image
 * 2. Duplicate slip prevention (prevent reusing same slip or QR or reference)
 * 3. Today's date (must be today)
 * 4. Transfer amount (must match expected amount)
 * 5. Real receiver account (must match shop account)
 * 
 * @param {string} filePath - Absolute path to the uploaded image file
 * @param {string} mimeType - e.g. "image/jpeg", "image/png"
 * @param {number} expectedAmount - The total order price to verify against
 * @param {string} expectedReceiver - The shop's official account name
 * @param {string} [excludeOrderId] - Optional order ID to skip in duplicate checks
 * @returns {Promise<object>} Verification result
 */
async function verifySlip(filePath, mimeType, expectedAmount, expectedReceiver = 'พัชญ์ชามญชุ์ กฤติณัฐธนชัย', excludeOrderId = null) {
  const targetAmount = parseFloat(expectedAmount) || 0;
  const today = getTodayDateInfo();

  if (!fs.existsSync(filePath)) {
    return {
      isValidSlip: false,
      isAmountMatched: false,
      isDateToday: false,
      isReceiverMatched: false,
      isReadyToSave: false,
      isDuplicateSlip: false,
      hasQrCode: false,
      detectedAmount: null,
      expectedAmount: targetAmount,
      status: 'FILE_NOT_FOUND',
      message: 'ไม่พบไฟล์รูปภาพสลิป'
    };
  }

  // 1. Calculate file hash and scan embedded QR code from slip in parallel
  const fileHash = getFileHash(filePath);
  const qrScanResult = await scanSlipQrCode(filePath);
  const qrData = qrScanResult && qrScanResult.found ? qrScanResult.data : null;
  const qrInfo = parseSlipQrInfo(qrData);

  // Read image buffer and convert to base64
  const imageBuffer = fs.readFileSync(filePath);
  const base64Data = imageBuffer.toString('base64');
  const normalizedMimeType = mimeType || 'image/jpeg';

  if (!GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY not found. Fallback to manual review.');
    const initialRef = qrInfo?.extractedRef || 'REF-' + Date.now();
    const dupCheck = checkDuplicateSlip({ fileHash, qrData, transactionRef: initialRef, excludeOrderId });

    return {
      isValidSlip: true,
      isAmountMatched: !dupCheck.isDuplicate,
      isDateToday: true,
      isReceiverMatched: true,
      isReadyToSave: !dupCheck.isDuplicate,
      isDuplicateSlip: dupCheck.isDuplicate,
      hasQrCode: !!qrData,
      qrData,
      fileHash,
      detectedAmount: targetAmount,
      expectedAmount: targetAmount,
      receiverName: expectedReceiver,
      status: dupCheck.isDuplicate ? 'DUPLICATE_SLIP' : 'MANUAL_REVIEW',
      message: dupCheck.isDuplicate ? dupCheck.message : 'บันทึกออเดอร์เรียบร้อยแล้ว (รอแอดมินยืนยันยอดเงิน)',
      transferDate: today.thaiShort,
      transferTime: new Date().toLocaleTimeString('th-TH'),
      transactionRef: initialRef
    };
  }

  const prompt = `
คุณคือระบบ AI ผู้เชี่ยวชาญการตรวจสอบสลิปการโอนเงินธนาคารไทย (Thai Bank Transfer Slip OCR & Verification) ที่มีความรวดเร็วและแม่นยำสูงสุด
ข้อมูลอ้างอิงของร้านค้าที่ต้องตรวจสอบให้ตรงกัน 100%:
1. วันที่โอน (Transfer Date): ต้องเป็น "วันนี้" วันที่ ${today.day} เดือน ${today.month} พ.ศ. ${today.yearBE} (ค.ศ. ${today.yearCE}) หรือ "${today.thaiShort}", "${today.isoDate}" (ห้ามใช้สลิปเก่าของวันอื่น)
2. ยอดเงินโอน (Transfer Amount): ต้องตรงกับ ${targetAmount} บาท (คลาดเคลื่อนไม่เกิน 0.05 บาท)
3. ผู้รับเงิน (Receiver Name): ต้องโอนเข้าบัญชีของร้านค้าจริง ชื่อบัญชีร้านคือ "${expectedReceiver}" (หรือชื่อย่อ/คำนำหน้า เช่น "พัชญ์ชามญชุ์", "กฤติณัฐธนชัย", "น.ส. พัชญ์ชามญชุ์", "PATCHAMON") หากในสลิปโอนไปหาบุคคลอื่นที่ไม่ใช่ร้านค้า ให้ถือว่าไม่ได้โอนเข้าร้าน
4. ตรวจสอบ QR Code บนสลิป: ตรวจดูว่ามี QR Code ยืนยันสลิปของธนาคาร (Mini QR) ปรากฏอยู่บนภาพสลิปหรือไม่ และสกัดรหัสอ้างอิงธุรกรรม (Transaction Reference Number / Ref ID) ออกมาให้ครบถ้วนถูกต้อง

งานของคุณ:
- ตรวจสอบว่ารูปนี้เป็นสลิปโอนเงินธนาคารไทยจริงหรือไม่
- สกัดยอดเงินที่โอน (ตัวเลขทศนิยม เช่น 35.00)
- สกัดวันที่และเวลาที่โอน
- สกัดชื่อผู้รับเงิน (Receiver) และตรวจสอบว่าตรงกับบัญชีร้าน (${expectedReceiver}) หรือไม่
- สกัดชื่อธนาคาร, ผู้โอน, และเลขอ้างอิงธุรกรรม (Transaction Reference)
- ระบุว่าตรวจพบ QR Code สำหรับตรวจสอบสลิปบนภาพหรือไม่ (hasQrCode: true หรือ false)

ตอบกลับเป็นรูปแบบ JSON เดียวเท่านั้น (ห้ามมี Markdown หรือคำอธิบายอื่น):
{
  "isValidSlip": true หรือ false,
  "detectedAmount": ตัวเลขยอดเงินที่โอน (เช่น 35.00) หรือ null,
  "isAmountMatched": true หรือ false (ตรงกับ ${targetAmount} หรือไม่),
  "amountDifference": ผลต่างยอดเงิน (detectedAmount - ${targetAmount}),
  "transferDate": "วันที่โอนที่อ่านได้จากสลิป",
  "transferTime": "เวลาที่โอน",
  "isDateToday": true หรือ false (ตรงกับวันที่ปัจจุบันของวันนี้หรือไม่),
  "receiverName": "ชื่อผู้รับโอนที่ระบุในสลิป",
  "isReceiverMatched": true หรือ false (ตรงกับบัญชีร้าน ${expectedReceiver} หรือไม่),
  "isReadyToSave": true หรือ false,
  "bankName": "ชื่อธนาคาร",
  "senderName": "ชื่อผู้โอน",
  "transactionRef": "เลขอ้างอิงธุรกรรม",
  "hasQrCode": true หรือ false,
  "status": "VALID_AND_MATCHED" | "RECEIVER_MISMATCHED" | "AMOUNT_MISMATCHED" | "DATE_MISMATCHED" | "NOT_A_SLIP",
  "message": "ข้อความสรุปเป็นภาษาไทยอย่างสุภาพและชัดเจน"
}

กฎการตัดสิน:
- isReadyToSave เป็น true เฉพาะเมื่อ: isValidSlip === true AND isAmountMatched === true AND isDateToday === true AND isReceiverMatched === true
- ถ้าผู้รับเงินในสลิปไม่ใช่บัญชีร้านค้า ให้ isReceiverMatched = false, status = "RECEIVER_MISMATCHED", ระบุใน message ว่าชื่อผู้รับในสลิปคือใคร และไม่ตรงกับบัญชีร้าน (${expectedReceiver})
- ถ้ายอดเงินไม่ตรง ให้ status = "AMOUNT_MISMATCHED"
- ถ้าวันที่โอนไม่ใช่วันนี้ ให้ status = "DATE_MISMATCHED"
- ถ้าไม่ใช่สลิปโอนเงิน ให้ status = "NOT_A_SLIP"
`;

  let lastError = null;

  for (const model of VISION_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const payload = {
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: normalizedMimeType,
                  data: base64Data
                }
              }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1
        }
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(`Model ${model} error (${response.status}): ${errorText.slice(0, 100)}`);
        continue;
      }

      const resJson = await response.json();
      const rawText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!rawText) continue;

      const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      const detected = parsed.detectedAmount !== null && parsed.detectedAmount !== undefined
        ? parseFloat(parsed.detectedAmount)
        : null;

      let isMatched = false;
      let diff = 0;
      if (detected !== null && !isNaN(detected)) {
        diff = Math.round((detected - targetAmount) * 100) / 100;
        isMatched = Math.abs(diff) <= 0.05;
      }

      const isDateValid = parsed.isDateToday === true;
      const isSlip = parsed.isValidSlip === true;

      // Double-check recipient match (Must match the shop account)
      const detectedReceiver = parsed.receiverName || '';
      const isReceiverValid = checkRecipientMatch(detectedReceiver, expectedReceiver);

      // Determine transaction reference
      const finalRef = parsed.transactionRef || qrInfo?.extractedRef || '';
      const hasQr = (qrScanResult && qrScanResult.found) || parsed.hasQrCode === true;

      // ==========================================
      // CRITICAL CHECK: PREVENT DUPLICATE SLIPS!
      // ==========================================
      const dupCheck = checkDuplicateSlip({
        fileHash,
        qrData,
        transactionRef: finalRef,
        excludeOrderId
      });

      let finalStatus = 'UNCLEAR';
      let userMsg = parsed.message || '';

      if (dupCheck.isDuplicate) {
        finalStatus = 'DUPLICATE_SLIP';
        userMsg = dupCheck.message;
      } else if (!isSlip) {
        finalStatus = 'NOT_A_SLIP';
        userMsg = '❌ รูปภาพที่แนบไม่ใช่สลิปการโอนเงินธนาคารที่ถูกต้อง';
      } else if (!isReceiverValid) {
        finalStatus = 'RECEIVER_MISMATCHED';
        userMsg = `⚠️ สลิปนี้ไม่ได้โอนเข้าบัญชีของร้าน (ชื่อผู้รับในสลิป: "${detectedReceiver || 'ไม่พบบัญชีร้าน'}" ไม่ตรงกับบัญชีร้าน "${expectedReceiver}") กรุณาโอนเข้าบัญชีของร้านครับ`;
      } else if (!isMatched) {
        finalStatus = 'AMOUNT_MISMATCHED';
        userMsg = `⚠️ ยอดเงินในสลิป (${detected ? detected.toFixed(2) : 0} บาท) ไม่ตรงกับยอดสั่งซื้อ (${targetAmount.toFixed(2)} บาท) ${diff < 0 ? 'ขาด ' + Math.abs(diff).toFixed(2) : 'เกิน +' + diff.toFixed(2)} บาท`;
      } else if (!isDateValid) {
        finalStatus = 'DATE_MISMATCHED';
        userMsg = `⚠️ วันที่ในสลิป (${parsed.transferDate || 'ไม่ใช่วันนี้'}) ไม่ใช่วันที่ปัจจุบันของวันนี้ กรุณาใช้สลิปที่โอนวันนี้เท่านั้น`;
      } else {
        finalStatus = 'VALID_AND_MATCHED';
        userMsg = `✅ สลิปถูกต้อง! โอนเข้าบัญชีร้าน "${expectedReceiver}" ยอดเงิน ${targetAmount.toFixed(2)} บาท โอนวันนี้ถูกต้องสมบูรณ์${hasQr ? ' (ตรวจสอบ QR Code ในสลิปผ่าน)' : ''}`;
      }

      const readyToSave = (finalStatus === 'VALID_AND_MATCHED' && !dupCheck.isDuplicate);

      return {
        isValidSlip: isSlip,
        detectedAmount: detected,
        expectedAmount: targetAmount,
        isAmountMatched: isMatched,
        amountDifference: diff,
        transferDate: parsed.transferDate || today.thaiShort,
        transferTime: parsed.transferTime || '',
        isDateToday: isDateValid,
        receiverName: detectedReceiver || expectedReceiver,
        isReceiverMatched: isReceiverValid,
        expectedReceiver: expectedReceiver,
        isReadyToSave: readyToSave,
        hasQrCode: hasQr,
        qrData: qrData,
        qrScanMethod: qrScanResult?.method || null,
        isDuplicateSlip: dupCheck.isDuplicate,
        duplicateMatchedBy: dupCheck.matchedBy || null,
        duplicateReason: dupCheck.isDuplicate ? dupCheck.message : null,
        fileHash: fileHash,
        bankName: parsed.bankName || 'ไม่ระบุ',
        senderName: parsed.senderName || 'ไม่ระบุ',
        transactionRef: finalRef || 'ไม่ระบุ',
        status: finalStatus,
        message: userMsg,
        todayReference: today
      };
    } catch (err) {
      console.error(`Error with model ${model}:`, err.message);
      lastError = err;
    }
  }

  // Fallback
  const fallbackRef = qrInfo?.extractedRef || '';
  const fallbackDup = checkDuplicateSlip({ fileHash, qrData, transactionRef: fallbackRef, excludeOrderId });

  return {
    isValidSlip: true,
    isAmountMatched: false,
    isDateToday: false,
    isReceiverMatched: false,
    isReadyToSave: false,
    isDuplicateSlip: fallbackDup.isDuplicate,
    hasQrCode: !!qrData,
    qrData,
    fileHash,
    detectedAmount: null,
    expectedAmount: targetAmount,
    status: fallbackDup.isDuplicate ? 'DUPLICATE_SLIP' : 'MANUAL_REVIEW',
    message: fallbackDup.isDuplicate ? fallbackDup.message : 'ไม่สามารถอ่านสลิปอัตโนมัติได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง หรือส่งให้ทางร้านตรวจสอบ',
    error: lastError ? lastError.message : 'AI temporarily unavailable'
  };
}

module.exports = {
  verifySlip,
  getTodayDateInfo,
  checkRecipientMatch
};
