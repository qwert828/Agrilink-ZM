// src/routes/listings.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { auth, requireRole } = require('../middleware/auth');

// GET /api/listings — public, filterable
router.get('/', async (req, res) => {
  const { crop, category, district, province, min_price, max_price, grade, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  const conditions = ["l.status = 'active'", "l.quantity_available > 0"];
  const params = [];
  let p = 1;

  if (crop) { conditions.push(`l.crop_name ILIKE $${p++}`); params.push(`%${crop}%`); }
  if (category) { conditions.push(`l.category = $${p++}`); params.push(category); }
  if (district) { conditions.push(`l.district ILIKE $${p++}`); params.push(`%${district}%`); }
  if (province) { conditions.push(`l.province ILIKE $${p++}`); params.push(`%${province}%`); }
  if (min_price) { conditions.push(`l.price_per_unit >= $${p++}`); params.push(min_price); }
  if (max_price) { conditions.push(`l.price_per_unit <= $${p++}`); params.push(max_price); }
  if (grade) { conditions.push(`l.grade = $${p++}`); params.push(grade); }

  const where = conditions.join(' AND ');

  try {
    const result = await db.query(`
      SELECT
        l.id, l.crop_name, l.quantity, l.quantity_available, l.unit,
        l.price_per_unit, l.grade, l.district, l.province,
        l.available_from, l.delivery_available, l.notes, l.category,
        l.views, l.created_at,
        u.name AS farmer_name, u.rating AS farmer_rating,
        u.total_deals AS farmer_deals, u.nrc_verified,
        -- Compare to market price
        mp.price_zmw AS market_price
      FROM listings l
      JOIN users u ON l.farmer_id = u.id
      LEFT JOIN market_prices mp ON mp.crop_id = (
        SELECT id FROM crops WHERE name = l.crop_name LIMIT 1
      ) AND mp.recorded_date = (
        SELECT MAX(recorded_date) FROM market_prices WHERE crop_id = mp.crop_id
      )
      WHERE ${where}
      ORDER BY l.created_at DESC
      LIMIT $${p++} OFFSET $${p++}
    `, [...params, limit, offset]);

    const countResult = await db.query(
      `SELECT COUNT(*) FROM listings l WHERE ${where}`,
      params
    );

    // Increment views for returned listings (async, don't await)
    const ids = result.rows.map(r => r.id);
    if (ids.length) {
      db.query(`UPDATE listings SET views = views + 1 WHERE id = ANY($1)`, [ids]).catch(() => {});
    }

    res.json({
      listings: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      pages: Math.ceil(countResult.rows[0].count / limit)
    });
  } catch (err) {
    console.error('Listings fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch listings' });
  }
});

// GET /api/listings/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT l.*, u.name AS farmer_name, u.phone AS farmer_phone,
             u.rating AS farmer_rating, u.total_deals, u.nrc_verified,
             u.preferred_network, u.district AS farmer_district
      FROM listings l
      JOIN users u ON l.farmer_id = u.id
      WHERE l.id = $1
    `, [req.params.id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Listing not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch listing' });
  }
});

// POST /api/listings — farmers only
router.post('/', auth, requireRole('farmer'), async (req, res) => {
  const {
    crop_name, quantity, unit, price_per_unit, grade,
    district, province, gps_lat, gps_lng, available_from,
    available_until, delivery_available, notes, category
  } = req.body;

  if (!crop_name || !quantity || !unit || !price_per_unit || !district) {
    return res.status(400).json({ error: 'crop_name, quantity, unit, price_per_unit, district are required' });
  }

  try {
    const result = await db.query(`
      INSERT INTO listings (
        farmer_id, crop_name, quantity, quantity_available, unit,
        price_per_unit, grade, district, province, gps_lat, gps_lng,
        available_from, available_until, delivery_available, notes, category
      ) VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `, [
      req.user.id, crop_name, quantity, unit, price_per_unit,
      grade || 'Ungraded', district, province, gps_lat, gps_lng,
      available_from || new Date(), available_until, delivery_available || false,
      notes, category
    ]);

    // Notify matching buyers (async)
    notifyMatchingBuyers(result.rows[0]).catch(() => {});

    res.status(201).json({ message: 'Listing posted', listing: result.rows[0] });
  } catch (err) {
    console.error('Listing create error:', err);
    res.status(500).json({ error: 'Failed to post listing' });
  }
});

// PATCH /api/listings/:id — farmer can update own listing
router.patch('/:id', auth, requireRole('farmer'), async (req, res) => {
  try {
    const check = await db.query('SELECT farmer_id FROM listings WHERE id = $1', [req.params.id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Listing not found' });
    if (check.rows[0].farmer_id !== req.user.id) return res.status(403).json({ error: 'Not your listing' });

    const { price_per_unit, quantity_available, notes, status } = req.body;
    const result = await db.query(`
      UPDATE listings SET
        price_per_unit = COALESCE($1, price_per_unit),
        quantity_available = COALESCE($2, quantity_available),
        notes = COALESCE($3, notes),
        status = COALESCE($4, status),
        updated_at = NOW()
      WHERE id = $5 RETURNING *
    `, [price_per_unit, quantity_available, notes, status, req.params.id]);

    res.json({ message: 'Listing updated', listing: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

// DELETE /api/listings/:id
router.delete('/:id', auth, requireRole('farmer', 'admin'), async (req, res) => {
  try {
    await db.query(`UPDATE listings SET status = 'expired' WHERE id = $1 AND farmer_id = $2`, [req.params.id, req.user.id]);
    res.json({ message: 'Listing removed' });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

// GET /api/listings/my/all — farmer's own listings
router.get('/my/all', auth, requireRole('farmer'), async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM listings WHERE farmer_id = $1 ORDER BY created_at DESC
    `, [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch your listings' });
  }
});

// Helper: notify buyers who have matching buy orders
async function notifyMatchingBuyers(listing) {
  const buyers = await db.query(`
    SELECT bo.buyer_id, u.phone, u.name
    FROM buy_orders bo
    JOIN users u ON bo.buyer_id = u.id
    WHERE bo.crop_name ILIKE $1
      AND bo.max_price_per_unit >= $2
      AND bo.status = 'open'
      AND (bo.valid_until IS NULL OR bo.valid_until >= CURRENT_DATE)
  `, [listing.crop_name, listing.price_per_unit]);

  for (const buyer of buyers.rows) {
    await db.query(`
      INSERT INTO notifications (user_id, type, title, body, data)
      VALUES ($1, 'new_listing_match', $2, $3, $4)
    `, [
      buyer.buyer_id,
      `New ${listing.crop_name} available`,
      `${listing.quantity} ${listing.unit} at K${listing.price_per_unit} in ${listing.district}`,
      JSON.stringify({ listing_id: listing.id })
    ]);
  }
}

module.exports = router;
