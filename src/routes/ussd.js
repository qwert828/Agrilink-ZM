// src/routes/ussd.js
// Africa's Talking USSD Gateway — AgriLink state machine
// Farmers with basic phones dial *384*5544# to access the full platform

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../db');

// POST /api/ussd — Africa's Talking sends POST on every USSD interaction
router.post('/', async (req, res) => {
  const { sessionId, serviceCode, phoneNumber, text } = req.body;
  const phone = normalizePhone(phoneNumber);
  const inputs = text ? text.split('*') : [];
  const lastInput = inputs[inputs.length - 1] || '';

  // Load or create session
  let session = await getSession(sessionId, phone);
  const user = await findUser(phone);

  let response = '';

  try {
    // ============================================================
    // UNREGISTERED USER FLOW
    // ============================================================
    if (!user && session.state !== 'register_name' && session.state !== 'register_role' && session.state !== 'register_pin' && session.state !== 'register_district') {
      await updateSession(sessionId, 'register_name', {});
      response = `CON Welcome to AgriLink ZM 🌾
Zambia's Farm-to-Market Platform

You are not registered yet.
Enter your full name:`;

    } else if (!user && session.state === 'register_name') {
      await updateSession(sessionId, 'register_role', { name: lastInput });
      response = `CON Hello ${lastInput}!
Are you a:
1. Farmer (selling produce)
2. Buyer (buying produce)`;

    } else if (!user && session.state === 'register_role') {
      const role = lastInput === '1' ? 'farmer' : 'buyer';
      await updateSession(sessionId, 'register_district', { ...session.data, role });
      response = `CON Enter your district:
(e.g. Chongwe, Mkushi, Kafue)`;

    } else if (!user && session.state === 'register_district') {
      await updateSession(sessionId, 'register_pin', { ...session.data, district: lastInput });
      response = `CON Create a 4-digit PIN
for your AgriLink account:`;

    } else if (!user && session.state === 'register_pin') {
      if (lastInput.length !== 4 || isNaN(lastInput)) {
        response = `CON PIN must be 4 digits.
Enter your 4-digit PIN:`;
      } else {
        const pin_hash = await bcrypt.hash(lastInput, 10);
        const d = session.data;
        await db.query(`
          INSERT INTO users (phone, name, role, district, ussd_pin, preferred_network)
          VALUES ($1, $2, $3, $4, $5, 'MTN')
        `, [phone, d.name, d.role, d.district, pin_hash]);
        response = `END ✅ Registered successfully!
Name: ${d.name}
Role: ${d.role}
District: ${d.district}

Dial *384*5544# to start using AgriLink!`;
      }

    // ============================================================
    // REGISTERED USER — PIN CHECK (first interaction)
    // ============================================================
    } else if (user && session.state === 'main_menu' && inputs.length === 1 && text === '') {
      await updateSession(sessionId, 'pin_check', {});
      response = `CON AgriLink ZM 🌾
Welcome back, ${user.name.split(' ')[0]}!

Enter your PIN:`;

    } else if (user && session.state === 'pin_check') {
      const validPin = await bcrypt.compare(lastInput, user.ussd_pin || '');
      if (!validPin) {
        response = `END ❌ Incorrect PIN.
Dial *384*5544# to try again.`;
      } else {
        await updateSession(sessionId, 'home', { authenticated: true });
        response = buildMainMenu(user);
      }

    // ============================================================
    // HOME MENU
    // ============================================================
    } else if (session.data.authenticated) {

      if (session.state === 'home') {
        if (lastInput === '1' && user.role === 'farmer') {
          await updateSession(sessionId, 'list_crop', session.data);
          response = `CON POST PRODUCE 📦
Select crop:
1. Maize
2. Soybeans
3. Groundnuts
4. Sunflower
5. Cassava
6. Tomatoes
7. Onions
8. Other`;

        } else if (lastInput === '1' && user.role === 'buyer') {
          // Buyers see listings
          const listings = await getActiveListings();
          if (!listings.length) {
            response = `END No listings available right now.
Check back later.`;
          } else {
            await updateSession(sessionId, 'view_listings', { ...session.data, listings: listings.map(l => l.id) });
            response = `CON AVAILABLE PRODUCE 🌾\n` +
              listings.slice(0, 5).map((l, i) =>
                `${i + 1}. ${l.crop_name} K${l.price_per_unit}/${l.unit}\n   ${l.district} (${l.quantity_available} left)`
              ).join('\n') + `\n\nSelect to buy (1-${Math.min(5, listings.length)})\n0. Back`;
          }

        } else if (lastInput === '2') {
          // Check prices
          const prices = await getMarketPrices();
          response = `END MARKET PRICES 📊\n` +
            prices.map(p => `${p.crop}: K${p.price_zmw}/${p.unit}`).join('\n') +
            `\n\nSource: Soweto/FRA\nUpdated: Today`;

        } else if (lastInput === '3') {
          // My deals/earnings
          const stats = await getUserStats(user.id, user.role);
          response = `END MY ACCOUNT 📊
Name: ${user.name}
Role: ${user.role}
District: ${user.district}
Rating: ${user.rating || 'N/A'}/5

Deals closed: ${stats.deals}
Total ${user.role === 'farmer' ? 'earned' : 'spent'}: K${stats.volume}

Network: ${user.preferred_network || 'Not set'}`;

        } else if (lastInput === '4') {
          // Set price alert
          await updateSession(sessionId, 'alert_crop', session.data);
          response = `CON PRICE ALERT 🔔
Which crop?
1. Maize
2. Soybeans
3. Groundnuts
4. Sunflower
5. Tomatoes`;

        } else if (lastInput === '0') {
          response = `END Thank you for using AgriLink ZM.
Dial *384*5544# to return.
AgriLink — Farm to Market 🌾`;
        }

      // ============================================================
      // FARMER: POST LISTING FLOW
      // ============================================================
      } else if (session.state === 'list_crop') {
        const cropMap = { '1': 'Maize', '2': 'Soybeans', '3': 'Groundnuts', '4': 'Sunflower', '5': 'Cassava', '6': 'Tomatoes', '7': 'Onions' };
        const crop = cropMap[lastInput] || 'Other';
        await updateSession(sessionId, 'list_qty', { ...session.data, crop });
        response = `CON POST: ${crop}
Enter quantity (in 50kg bags):`;

      } else if (session.state === 'list_qty') {
        const qty = parseFloat(lastInput);
        if (isNaN(qty) || qty <= 0) {
          response = `CON Invalid quantity.
Enter quantity (number only):`;
        } else {
          await updateSession(sessionId, 'list_price', { ...session.data, qty });
          response = `CON POST: ${session.data.crop} — ${qty} bags
Enter your price per 50kg bag (ZMW):`;
        }

      } else if (session.state === 'list_price') {
        const price = parseFloat(lastInput);
        if (isNaN(price) || price <= 0) {
          response = `CON Invalid price. Enter ZMW amount:`;
        } else {
          await updateSession(sessionId, 'list_confirm', { ...session.data, price });
          const d = session.data;
          response = `CON CONFIRM LISTING ✅
Crop: ${d.crop}
Qty: ${d.qty} × 50kg bags
Price: K${price}/bag
Total value: K${(d.qty * price).toFixed(0)}
District: ${user.district}

1. Confirm & Post
2. Cancel`;
        }

      } else if (session.state === 'list_confirm') {
        if (lastInput === '1') {
          const d = session.data;
          await db.query(`
            INSERT INTO listings (farmer_id, crop_name, quantity, quantity_available, unit, price_per_unit, grade, district, status, category)
            VALUES ($1, $2, $3, $3, '50kg bags', $4, 'Ungraded', $5, 'active', 'cereals')
          `, [user.id, d.crop, d.qty, d.price, user.district]);

          response = `END ✅ LISTING POSTED!
${d.crop}: ${d.qty} bags at K${d.price}/bag
District: ${user.district}

Buyers can now see your produce.
You'll get an SMS when a deal comes in.

AgriLink ZM 🌾`;
        } else {
          response = `END Listing cancelled.
Dial *384*5544# to start again.`;
        }

      // ============================================================
      // BUYER: VIEW & BUY LISTING
      // ============================================================
      } else if (session.state === 'view_listings') {
        if (lastInput === '0') {
          await updateSession(sessionId, 'home', session.data);
          response = buildMainMenu(user);
        } else {
          const idx = parseInt(lastInput) - 1;
          const listingIds = session.data.listings || [];
          if (idx >= 0 && idx < listingIds.length) {
            const listing = await getListingById(listingIds[idx]);
            if (listing) {
              await updateSession(sessionId, 'buy_confirm', { ...session.data, listing_id: listing.id, listing });
              response = `CON BUY PRODUCE 🛒
${listing.crop_name}
Price: K${listing.price_per_unit}/bag
Available: ${listing.quantity_available} bags
Farmer: ${listing.farmer_name}
District: ${listing.district}

Enter qty to buy (bags):`;
            }
          }
        }

      } else if (session.state === 'buy_confirm') {
        const qty = parseFloat(lastInput);
        const listing = session.data.listing;
        if (isNaN(qty) || qty <= 0 || qty > listing.quantity_available) {
          response = `CON Invalid quantity.
Max available: ${listing.quantity_available} bags
Enter qty:`;
        } else {
          const subtotal = qty * listing.price_per_unit;
          const fee = (subtotal * 0.0178).toFixed(2);
          const total = (subtotal + parseFloat(fee)).toFixed(2);
          await updateSession(sessionId, 'buy_pay', { ...session.data, buy_qty: qty, buy_total: total });
          response = `CON CONFIRM PURCHASE ✅
${listing.crop_name}: ${qty} bags
Amount: K${subtotal}
Fee: K${fee}
TOTAL: K${total}

Pay with:
1. MTN Mobile Money
2. Airtel Money
3. Zamtel Kwacha`;
        }

      } else if (session.state === 'buy_pay') {
        const networkMap = { '1': 'MTN', '2': 'Airtel', '3': 'Zamtel' };
        const network = networkMap[lastInput];
        if (!network) {
          response = `CON Select network:
1. MTN Mobile Money
2. Airtel Money
3. Zamtel Kwacha`;
        } else {
          // Log the deal initiation (full payment via InPay webhook after)
          const d = session.data;
          await db.query(`
            INSERT INTO sms_log (phone, direction, message, status)
            VALUES ($1, 'outbound', $2, 'queued')
          `, [phone, `AgriLink: Confirm payment of K${d.buy_total} via ${network} for ${d.listing?.crop_name}. Reply YES to confirm.`]);

          response = `END ✅ PURCHASE INITIATED
Total: K${d.buy_total}
Network: ${network}

You will receive a ${network} prompt to approve payment.
Farmer will be notified once paid.

AgriLink ZM 🌾`;
        }

      // ============================================================
      // PRICE ALERT FLOW
      // ============================================================
      } else if (session.state === 'alert_crop') {
        const cropMap = { '1': 'Maize', '2': 'Soybeans', '3': 'Groundnuts', '4': 'Sunflower', '5': 'Tomatoes' };
        const alertCrop = cropMap[lastInput];
        if (!alertCrop) {
          response = `CON Invalid. Select crop (1-5):`;
        } else {
          await updateSession(sessionId, 'alert_price', { ...session.data, alertCrop });
          response = `CON PRICE ALERT: ${alertCrop}
Alert me when price is:
1. Above a price
2. Below a price`;
        }

      } else if (session.state === 'alert_price') {
        const type = lastInput === '1' ? 'above' : 'below';
        await updateSession(sessionId, 'alert_threshold', { ...session.data, alertType: type });
        response = `CON Enter threshold price (K per 50kg bag):`;

      } else if (session.state === 'alert_threshold') {
        const price = parseFloat(lastInput);
        if (isNaN(price)) {
          response = `CON Enter a valid price (numbers only):`;
        } else {
          const d = session.data;
          await db.query(`
            INSERT INTO price_alerts (user_id, crop_name, alert_type, threshold_price, unit)
            VALUES ($1, $2, $3, $4, '50kg bags')
          `, [user.id, d.alertCrop, d.alertType, price]);
          response = `END ✅ Alert set!
You'll get an SMS when ${d.alertCrop} goes ${d.alertType} K${price}/bag.

AgriLink ZM 🌾`;
        }

      } else {
        // Fallback
        await updateSession(sessionId, 'home', { authenticated: true });
        response = buildMainMenu(user);
      }

    } else {
      // Session expired or unknown state
      response = `END Session expired.
Dial *384*5544# to start again.`;
    }

  } catch (err) {
    console.error('USSD error:', err);
    response = `END Service temporarily unavailable.
Please try again shortly.
AgriLink ZM 🌾`;
  }

  res.set('Content-Type', 'text/plain');
  res.send(response);
});

// ============================================================
// HELPERS
// ============================================================

function buildMainMenu(user) {
  if (user.role === 'farmer') {
    return `CON AgriLink ZM 🌾 — Farmer Menu
Hi ${user.name.split(' ')[0]}!

1. Post Produce
2. Market Prices
3. My Account
4. Set Price Alert
0. Exit`;
  } else {
    return `CON AgriLink ZM 🌾 — Buyer Menu
Hi ${user.name.split(' ')[0]}!

1. Browse Produce
2. Market Prices
3. My Account
4. Set Price Alert
0. Exit`;
  }
}

function normalizePhone(phone) {
  if (!phone) return '';
  if (phone.startsWith('+')) return phone;
  if (phone.startsWith('260')) return `+${phone}`;
  if (phone.startsWith('0')) return `+260${phone.slice(1)}`;
  return `+260${phone}`;
}

async function getSession(sessionId, phone) {
  const result = await db.query(`
    SELECT * FROM ussd_sessions WHERE id = $1
  `, [sessionId]);

  if (result.rows.length) return result.rows[0];

  // Create new session
  await db.query(`
    INSERT INTO ussd_sessions (id, phone, state, data) VALUES ($1, $2, 'main_menu', '{}')
  `, [sessionId, phone]);
  return { id: sessionId, phone, state: 'main_menu', data: {} };
}

async function updateSession(sessionId, state, data) {
  await db.query(`
    UPDATE ussd_sessions SET state = $1, data = $2, updated_at = NOW() WHERE id = $3
  `, [state, JSON.stringify(data), sessionId]);
}

async function findUser(phone) {
  const result = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
  return result.rows[0] || null;
}

async function getActiveListings() {
  const result = await db.query(`
    SELECT l.id, l.crop_name, l.price_per_unit, l.quantity_available, l.unit, l.district,
           u.name AS farmer_name
    FROM listings l JOIN users u ON l.farmer_id = u.id
    WHERE l.status = 'active' AND l.quantity_available > 0
    ORDER BY l.created_at DESC LIMIT 5
  `);
  return result.rows;
}

async function getListingById(id) {
  const result = await db.query(`
    SELECT l.*, u.name AS farmer_name FROM listings l JOIN users u ON l.farmer_id = u.id WHERE l.id = $1
  `, [id]);
  return result.rows[0] || null;
}

async function getMarketPrices() {
  const result = await db.query(`
    SELECT DISTINCT ON (crop_id) c.name AS crop, price_zmw, unit
    FROM market_prices mp JOIN crops c ON mp.crop_id = c.id
    ORDER BY crop_id, recorded_date DESC LIMIT 8
  `);
  return result.rows;
}

async function getUserStats(userId, role) {
  const field = role === 'farmer' ? 'farmer_id' : 'buyer_id';
  const result = await db.query(`
    SELECT COUNT(*) AS deals, COALESCE(SUM(subtotal), 0) AS volume
    FROM deals WHERE ${field} = $1 AND status = 'completed'
  `, [userId]);
  return { deals: result.rows[0].deals, volume: parseFloat(result.rows[0].volume).toFixed(2) };
}

module.exports = router;
