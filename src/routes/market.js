// src/routes/market.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { auth, requireRole } = require('../middleware/auth');

// GET /api/market/prices — latest prices per crop
router.get('/prices', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT DISTINCT ON (mp.crop_id)
        c.name AS crop, c.category, mp.price_zmw, mp.unit,
        mp.source, mp.recorded_date, mp.district,
        -- 7-day change
        prev.price_zmw AS prev_price,
        ROUND(((mp.price_zmw - COALESCE(prev.price_zmw, mp.price_zmw)) / COALESCE(prev.price_zmw, mp.price_zmw)) * 100, 1) AS change_pct
      FROM market_prices mp
      JOIN crops c ON mp.crop_id = c.id
      LEFT JOIN market_prices prev ON prev.crop_id = mp.crop_id
        AND prev.recorded_date = mp.recorded_date - INTERVAL '7 days'
      ORDER BY mp.crop_id, mp.recorded_date DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

// GET /api/market/crops — all crop types
router.get('/crops', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM crops WHERE is_active = true ORDER BY category, name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch crops' });
  }
});

// GET /api/market/stats — platform-wide stats
router.get('/stats', async (req, res) => {
  try {
    const [farmers, buyers, listings, volume, deals] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM users WHERE role = 'farmer' AND is_active = true`),
      db.query(`SELECT COUNT(*) FROM users WHERE role = 'buyer' AND is_active = true`),
      db.query(`SELECT COUNT(*) FROM listings WHERE status = 'active'`),
      db.query(`SELECT COALESCE(SUM(subtotal), 0) AS total FROM deals WHERE payment_status = 'completed'`),
      db.query(`SELECT COUNT(*) FROM deals WHERE status = 'completed'`)
    ]);

    res.json({
      farmers: parseInt(farmers.rows[0].count),
      buyers: parseInt(buyers.rows[0].count),
      active_listings: parseInt(listings.rows[0].count),
      total_volume_zmw: parseFloat(volume.rows[0].total),
      completed_deals: parseInt(deals.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// POST /api/market/prices — admin posts new price (e.g. from FRA/Soweto data)
router.post('/prices', auth, requireRole('admin'), async (req, res) => {
  const { crop_id, price_zmw, unit, source, district } = req.body;
  try {
    const result = await db.query(`
      INSERT INTO market_prices (crop_id, price_zmw, unit, source, district)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [crop_id, price_zmw, unit, source, district || 'Lusaka']);

    // Trigger price alerts
    checkPriceAlerts(result.rows[0]).catch(() => {});
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to post price' });
  }
});

// POST /api/market/alerts — subscribe to price alert
router.post('/alerts', auth, async (req, res) => {
  const { crop_name, alert_type, threshold_price, unit } = req.body;
  try {
    await db.query(`
      INSERT INTO price_alerts (user_id, crop_name, alert_type, threshold_price, unit)
      VALUES ($1, $2, $3, $4, $5)
    `, [req.user.id, crop_name, alert_type, threshold_price, unit]);
    res.status(201).json({ message: `Alert set — we'll SMS you when ${crop_name} goes ${alert_type} K${threshold_price}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set alert' });
  }
});

// GET /api/market/buy-orders — buyer demand board
router.get('/buy-orders', async (req, res) => {
  const { crop } = req.query;
  try {
    const result = await db.query(`
      SELECT bo.*, u.name AS buyer_name, u.rating AS buyer_rating, u.nrc_verified
      FROM buy_orders bo
      JOIN users u ON bo.buyer_id = u.id
      WHERE bo.status = 'open'
        AND (bo.valid_until IS NULL OR bo.valid_until >= CURRENT_DATE)
        ${crop ? `AND bo.crop_name ILIKE '%${crop}%'` : ''}
      ORDER BY bo.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch buy orders' });
  }
});

// POST /api/market/buy-orders — buyer posts a demand
router.post('/buy-orders', auth, requireRole('buyer'), async (req, res) => {
  const { crop_name, quantity_needed, unit, max_price_per_unit, grade_required, district_preference, notes, valid_until } = req.body;
  try {
    const result = await db.query(`
      INSERT INTO buy_orders (buyer_id, crop_name, quantity_needed, unit, max_price_per_unit, grade_required, district_preference, notes, valid_until)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [req.user.id, crop_name, quantity_needed, unit, max_price_per_unit, grade_required, district_preference, notes, valid_until]);

    // Notify matching farmers
    notifyMatchingFarmers(result.rows[0]).catch(() => {});
    res.status(201).json({ message: 'Buy order posted', order: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to post buy order' });
  }
});

// GET /api/market/notifications
router.get('/notifications', auth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50
    `, [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// PATCH /api/market/notifications/read
router.patch('/notifications/read', auth, async (req, res) => {
  await db.query(`UPDATE notifications SET read = true WHERE user_id = $1`, [req.user.id]);
  res.json({ message: 'Marked as read' });
});

async function checkPriceAlerts(priceRecord) {
  const alerts = await db.query(`
    SELECT pa.*, u.phone
    FROM price_alerts pa JOIN users u ON pa.user_id = u.id
    WHERE pa.crop_name ILIKE $1 AND pa.is_active = true
      AND ((pa.alert_type = 'above' AND $2 >= pa.threshold_price)
        OR (pa.alert_type = 'below' AND $2 <= pa.threshold_price))
  `, [priceRecord.crop_name || '', priceRecord.price_zmw]);

  for (const alert of alerts.rows) {
    await db.query(`
      INSERT INTO sms_log (phone, direction, message, status)
      VALUES ($1, 'outbound', $2, 'queued')
    `, [
      alert.phone,
      `AgriLink: ${priceRecord.crop_name} is now K${priceRecord.price_zmw}/${priceRecord.unit} — your price alert triggered. Reply SELL to list now.`
    ]);
  }
}

async function notifyMatchingFarmers(order) {
  const farmers = await db.query(`
    SELECT DISTINCT l.farmer_id, u.phone, u.name
    FROM listings l JOIN users u ON l.farmer_id = u.id
    WHERE l.crop_name ILIKE $1 AND l.price_per_unit <= $2 AND l.status = 'active'
  `, [order.crop_name, order.max_price_per_unit]);

  for (const farmer of farmers.rows) {
    await db.query(`
      INSERT INTO notifications (user_id, type, title, body, data)
      VALUES ($1, 'buy_order_match', $2, $3, $4)
    `, [
      farmer.farmer_id,
      `Buyer wants your ${order.crop_name}!`,
      `A verified buyer needs ${order.quantity_needed} ${order.unit} at up to K${order.max_price_per_unit}/${order.unit}`,
      JSON.stringify({ buy_order_id: order.id })
    ]);
  }
}

module.exports = router;
