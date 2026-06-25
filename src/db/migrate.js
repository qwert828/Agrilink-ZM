// src/db/migrate.js
// Run: node src/db/migrate.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const schema = `

-- ============================================================
-- AGRILINK ZM — DATABASE SCHEMA
-- ============================================================

-- USERS (farmers + buyers share this table, role differentiates)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(15) UNIQUE NOT NULL,        -- +260XXXXXXXXX
  name VARCHAR(100) NOT NULL,
  role VARCHAR(10) NOT NULL CHECK (role IN ('farmer', 'buyer', 'admin')),
  nrc_number VARCHAR(20),                    -- National Registration Card
  nrc_verified BOOLEAN DEFAULT false,
  district VARCHAR(100),
  province VARCHAR(100),
  preferred_network VARCHAR(20)             -- MTN, Airtel, Zamtel, Zanaco
    CHECK (preferred_network IN ('MTN', 'Airtel', 'Zamtel', 'Zanaco', 'ZedMobile')),
  mobile_money_number VARCHAR(15),
  password_hash VARCHAR(255),               -- For web/app login
  ussd_pin VARCHAR(60),                     -- Hashed 4-digit PIN for USSD
  rating DECIMAL(3,2) DEFAULT 0.00,
  total_deals INTEGER DEFAULT 0,
  total_volume_zmw DECIMAL(12,2) DEFAULT 0.00,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- CROPS REFERENCE TABLE
CREATE TABLE IF NOT EXISTS crops (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  category VARCHAR(50) NOT NULL            -- cereals, legumes, vegetables, fruits, oilseeds
    CHECK (category IN ('cereals', 'legumes', 'vegetables', 'fruits', 'oilseeds', 'other')),
  unit_default VARCHAR(30) DEFAULT '50kg bags',
  is_active BOOLEAN DEFAULT true
);

-- MARKET PRICES (daily reference prices, updated manually or via gov API)
CREATE TABLE IF NOT EXISTS market_prices (
  id SERIAL PRIMARY KEY,
  crop_id INTEGER REFERENCES crops(id),
  price_zmw DECIMAL(10,2) NOT NULL,
  unit VARCHAR(30) NOT NULL,
  source VARCHAR(100),                      -- FRA, Soweto Market, Farmer's Market etc
  recorded_date DATE DEFAULT CURRENT_DATE,
  district VARCHAR(100) DEFAULT 'Lusaka',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- LISTINGS (produce posted by farmers)
CREATE TABLE IF NOT EXISTS listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id UUID REFERENCES users(id) ON DELETE CASCADE,
  crop_id INTEGER REFERENCES crops(id),
  crop_name VARCHAR(100) NOT NULL,          -- Denormalized for speed
  quantity DECIMAL(10,2) NOT NULL,
  quantity_available DECIMAL(10,2) NOT NULL, -- Decreases as deals close
  unit VARCHAR(30) NOT NULL,
  price_per_unit DECIMAL(10,2) NOT NULL,
  grade VARCHAR(10) CHECK (grade IN ('A', 'B', 'C', 'Ungraded')),
  district VARCHAR(100) NOT NULL,
  province VARCHAR(100),
  gps_lat DECIMAL(9,6),
  gps_lng DECIMAL(9,6),
  available_from DATE DEFAULT CURRENT_DATE,
  available_until DATE,
  delivery_available BOOLEAN DEFAULT false,
  pickup_only BOOLEAN DEFAULT true,
  notes TEXT,
  images TEXT[],                            -- Array of image URLs (Cloudinary)
  status VARCHAR(20) DEFAULT 'active'
    CHECK (status IN ('active', 'sold', 'expired', 'suspended')),
  views INTEGER DEFAULT 0,
  category VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- BUY ORDERS (posted by buyers — reverse listings)
CREATE TABLE IF NOT EXISTS buy_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id UUID REFERENCES users(id) ON DELETE CASCADE,
  crop_name VARCHAR(100) NOT NULL,
  quantity_needed DECIMAL(10,2) NOT NULL,
  unit VARCHAR(30) NOT NULL,
  max_price_per_unit DECIMAL(10,2) NOT NULL,
  grade_required VARCHAR(10),
  district_preference VARCHAR(100),
  delivery_required BOOLEAN DEFAULT false,
  notes TEXT,
  valid_until DATE,
  status VARCHAR(20) DEFAULT 'open'
    CHECK (status IN ('open', 'fulfilled', 'expired', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- DEALS (matched transactions between farmer and buyer)
CREATE TABLE IF NOT EXISTS deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES listings(id),
  buy_order_id UUID REFERENCES buy_orders(id),
  farmer_id UUID REFERENCES users(id),
  buyer_id UUID REFERENCES users(id),
  crop_name VARCHAR(100) NOT NULL,
  quantity DECIMAL(10,2) NOT NULL,
  unit VARCHAR(30) NOT NULL,
  agreed_price_per_unit DECIMAL(10,2) NOT NULL,
  subtotal DECIMAL(12,2) NOT NULL,
  inpay_fee DECIMAL(10,2) NOT NULL,
  total_zmw DECIMAL(12,2) NOT NULL,
  payment_network VARCHAR(20),
  payment_reference VARCHAR(100),           -- InPay transaction ref
  payment_status VARCHAR(20) DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'processing', 'completed', 'failed', 'refunded')),
  farmer_payout_status VARCHAR(20) DEFAULT 'pending'
    CHECK (farmer_payout_status IN ('pending', 'sent', 'confirmed', 'failed')),
  farmer_payout_reference VARCHAR(100),
  pickup_scheduled DATE,
  pickup_confirmed BOOLEAN DEFAULT false,
  buyer_rating INTEGER CHECK (buyer_rating BETWEEN 1 AND 5),
  farmer_rating INTEGER CHECK (farmer_rating BETWEEN 1 AND 5),
  status VARCHAR(20) DEFAULT 'initiated'
    CHECK (status IN ('initiated', 'payment_pending', 'paid', 'collected', 'completed', 'disputed', 'cancelled')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- USSD SESSIONS (track Africa's Talking USSD state machine)
CREATE TABLE IF NOT EXISTS ussd_sessions (
  id VARCHAR(50) PRIMARY KEY,               -- AT session ID
  phone VARCHAR(15) NOT NULL,
  user_id UUID REFERENCES users(id),
  state VARCHAR(50) DEFAULT 'main_menu',
  data JSONB DEFAULT '{}',                  -- Temp data across USSD steps
  last_input TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- SMS LOG
CREATE TABLE IF NOT EXISTS sms_log (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(15) NOT NULL,
  direction VARCHAR(10) CHECK (direction IN ('inbound', 'outbound')),
  message TEXT NOT NULL,
  status VARCHAR(20),
  at_message_id VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- NOTIFICATIONS
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,                -- new_offer, payment_received, listing_viewed etc
  title VARCHAR(200) NOT NULL,
  body TEXT,
  read BOOLEAN DEFAULT false,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- PRICE ALERTS (farmer/buyer subscribes to crop price alerts)
CREATE TABLE IF NOT EXISTS price_alerts (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  crop_name VARCHAR(100) NOT NULL,
  alert_type VARCHAR(10) CHECK (alert_type IN ('above', 'below')),
  threshold_price DECIMAL(10,2) NOT NULL,
  unit VARCHAR(30) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- INDEXES FOR PERFORMANCE
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_crop ON listings(crop_name);
CREATE INDEX IF NOT EXISTS idx_listings_district ON listings(district);
CREATE INDEX IF NOT EXISTS idx_listings_farmer ON listings(farmer_id);
CREATE INDEX IF NOT EXISTS idx_deals_farmer ON deals(farmer_id);
CREATE INDEX IF NOT EXISTS idx_deals_buyer ON deals(buyer_id);
CREATE INDEX IF NOT EXISTS idx_deals_payment_status ON deals(payment_status);
CREATE INDEX IF NOT EXISTS idx_ussd_phone ON ussd_sessions(phone);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);

`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🌱 Running AgriLink migrations...');
    await client.query(schema);
    console.log('✅ All tables created successfully');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
