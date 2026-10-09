-- ========================================================
-- ร้านขนมแม้ว 🐾 (Snack by Maew)
-- Supabase PostgreSQL Database Schema
-- รันโค้ดนี้ใน Supabase SQL Editor ได้ในคลิกเดียว (ฟรี 100%)
-- ========================================================

-- 1. ตารางรายการขนม (snacks)
CREATE TABLE IF NOT EXISTS snacks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price NUMERIC NOT NULL DEFAULT 0,
  cost NUMERIC NOT NULL DEFAULT 0,
  unit TEXT DEFAULT 'ชิ้น',
  description TEXT DEFAULT '',
  image TEXT DEFAULT '',
  "isAvailable" BOOLEAN DEFAULT true,
  "sortOrder" INTEGER DEFAULT 0,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

-- 2. ตารางคำสั่งซื้อ (orders)
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  "deviceId" TEXT,
  "customerName" TEXT NOT NULL,
  "customerPhone" TEXT DEFAULT '',
  "customerEmail" TEXT DEFAULT '',
  "customerAddress" TEXT DEFAULT '',
  "customerNote" TEXT DEFAULT '',
  items JSONB DEFAULT '[]'::jsonb,
  "totalPrice" NUMERIC NOT NULL DEFAULT 0,
  "totalCost" NUMERIC NOT NULL DEFAULT 0,
  "totalProfit" NUMERIC NOT NULL DEFAULT 0,
  "profitMargin" NUMERIC NOT NULL DEFAULT 0,
  "slipImage" TEXT,
  "slipVerification" JSONB,
  "qrData" TEXT,
  "transactionRef" TEXT,
  "bankName" TEXT,
  "orderStatus" TEXT DEFAULT 'pending',
  "adminNotes" TEXT DEFAULT '',
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

-- 3. ตารางการตั้งค่าร้าน (settings)
CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY DEFAULT 'current',
  data JSONB NOT NULL,
  "updatedAt" TIMESTAMPTZ DEFAULT NOW()
);

-- สร้าง Index เพื่อให้การค้นหาเร็วระดับมิลลิวินาที (รองรับคนเข้าพร้อมกันหลักหมื่น-แสนคน)
CREATE INDEX IF NOT EXISTS idx_orders_device_id ON orders("deviceId");
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders("createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders("orderStatus");
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders("customerPhone");
CREATE INDEX IF NOT EXISTS idx_snacks_sort_order ON snacks("sortOrder");

-- เปิดให้เข้าถึงตารางได้ผ่าน API (Disable RLS เพื่อความสะดวกรวดเร็วในการเชื่อมต่อ)
ALTER TABLE snacks DISABLE ROW LEVEL SECURITY;
ALTER TABLE orders DISABLE ROW LEVEL SECURITY;
ALTER TABLE settings DISABLE ROW LEVEL SECURITY;
