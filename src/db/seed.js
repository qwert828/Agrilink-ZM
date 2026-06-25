// src/db/seed.js
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seed() {
  const client = await pool.connect();
  try {
    console.log('🌱 Seeding AgriLink database...');

    // CROPS
    await client.query(`
      INSERT INTO crops (name, category, unit_default) VALUES
        ('Maize', 'cereals', '50kg bags'),
        ('Soybeans', 'legumes', '50kg bags'),
        ('Groundnuts', 'legumes', '50kg bags'),
        ('Sunflower', 'oilseeds', '50kg bags'),
        ('Cassava', 'cereals', '50kg bags'),
        ('Sweet Potatoes', 'vegetables', '50kg bags'),
        ('Tomatoes', 'vegetables', 'Crates'),
        ('Onions', 'vegetables', '50kg bags'),
        ('Cabbage', 'vegetables', 'Heads'),
        ('Mangoes', 'fruits', 'Crates'),
        ('Bananas', 'fruits', 'Bunches'),
        ('Oranges', 'fruits', 'Crates'),
        ('Wheat', 'cereals', '50kg bags'),
        ('Sorghum', 'cereals', '50kg bags'),
        ('Cotton', 'other', 'Bales'),
        ('Tobacco', 'other', 'Bales'),
        ('Beans', 'legumes', '50kg bags'),
        ('Cowpeas', 'legumes', '50kg bags')
      ON CONFLICT DO NOTHING
    `);
    console.log('✅ Crops seeded');

    // MARKET PRICES (reference prices from FRA / Soweto Market)
    await client.query(`
      INSERT INTO market_prices (crop_id, price_zmw, unit, source, district) VALUES
        (1, 280, '50kg bags', 'FRA Floor Price', 'Lusaka'),
        (2, 420, '50kg bags', 'Soweto Market', 'Lusaka'),
        (3, 650, '50kg bags', 'Soweto Market', 'Lusaka'),
        (4, 310, '50kg bags', 'Soweto Market', 'Lusaka'),
        (5, 180, '50kg bags', 'Soweto Market', 'Lusaka'),
        (7, 95, 'Crates', 'Soweto Market', 'Lusaka'),
        (8, 200, '50kg bags', 'Soweto Market', 'Lusaka'),
        (10, 75, 'Crates', 'Soweto Market', 'Lusaka')
      ON CONFLICT DO NOTHING
    `);
    console.log('✅ Market prices seeded');

    // SAMPLE USERS
    const farmerPin = await bcrypt.hash('1234', 10);
    const buyerPin = await bcrypt.hash('5678', 10);

    await client.query(`
      INSERT INTO users (phone, name, role, district, province, preferred_network, mobile_money_number, ussd_pin, nrc_verified, rating, total_deals) VALUES
        ('+260971234567', 'Bwalya Mwansa', 'farmer', 'Chongwe', 'Lusaka', 'MTN', '0971234567', $1, true, 4.8, 12),
        ('+260977654321', 'Chanda Kapasa', 'farmer', 'Mkushi', 'Central', 'Airtel', '0977654321', $1, true, 4.5, 8),
        ('+260955111222', 'Mutale Nkosi', 'farmer', 'Kafue', 'Lusaka', 'Zamtel', '0955111222', $1, false, 0, 0),
        ('+260962333444', 'Freshco Zambia Ltd', 'buyer', 'Lusaka', 'Lusaka', 'MTN', '0962333444', $2, true, 4.9, 45),
        ('+260964555666', 'Agri-Partners ZM', 'buyer', 'Lusaka', 'Lusaka', 'Airtel', '0964555666', $2, true, 4.6, 23)
      ON CONFLICT (phone) DO NOTHING
    `, [farmerPin, buyerPin]);
    console.log('✅ Sample users seeded');

    // SAMPLE LISTINGS
    const farmerResult = await client.query(`SELECT id FROM users WHERE phone = '+260971234567'`);
    if (farmerResult.rows.length > 0) {
      const farmerId = farmerResult.rows[0].id;
      await client.query(`
        INSERT INTO listings (farmer_id, crop_name, quantity, quantity_available, unit, price_per_unit, grade, district, province, available_from, notes, status, category)
        VALUES
          ($1, 'Maize', 50, 50, '50kg bags', 280, 'A', 'Chongwe', 'Lusaka', CURRENT_DATE, 'Organic, no chemicals. Buyer can inspect.', 'active', 'cereals'),
          ($1, 'Soybeans', 20, 20, '50kg bags', 420, 'A', 'Chongwe', 'Lusaka', CURRENT_DATE + 1, 'Good moisture content, properly dried.', 'active', 'legumes')
        ON CONFLICT DO NOTHING
      `, [farmerId]);
      console.log('✅ Sample listings seeded');
    }

    console.log('\n🎉 Database seeded successfully!');
    console.log('Test farmer: +260971234567 | PIN: 1234');
    console.log('Test buyer:  +260962333444 | PIN: 5678');

  } catch (err) {
    console.error('❌ Seed failed:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
