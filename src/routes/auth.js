// src/routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { auth } = require('../middleware/auth');

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { phone, name, role, district, province, preferred_network, mobile_money_number, password, pin } = req.body;

  if (!phone || !name || !role || !password) {
    return res.status(400).json({ error: 'phone, name, role, and password are required' });
  }
  if (!['farmer', 'buyer'].includes(role)) {
    return res.status(400).json({ error: 'role must be farmer or buyer' });
  }

  try {
    const existing = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (existing.rows.length) return res.status(409).json({ error: 'Phone number already registered' });

    const password_hash = await bcrypt.hash(password, 10);
    const ussd_pin = pin ? await bcrypt.hash(pin, 10) : null;

    const result = await db.query(`
      INSERT INTO users (phone, name, role, district, province, preferred_network, mobile_money_number, password_hash, ussd_pin)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, phone, name, role, district, created_at
    `, [phone, name, role, district, province, preferred_network, mobile_money_number, password_hash, ussd_pin]);

    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.status(201).json({ message: 'Account created', user, token });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'phone and password required' });

  try {
    const result = await db.query('SELECT * FROM users WHERE phone = $1 AND is_active = true', [phone]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
    const { password_hash, ussd_pin, ...safeUser } = user;

    res.json({ message: 'Login successful', user: safeUser, token });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, phone, name, role, district, province, preferred_network,
             mobile_money_number, nrc_verified, rating, total_deals,
             total_volume_zmw, created_at
      FROM users WHERE id = $1
    `, [req.user.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// PATCH /api/auth/profile
router.patch('/profile', auth, async (req, res) => {
  const { name, district, province, preferred_network, mobile_money_number } = req.body;
  try {
    const result = await db.query(`
      UPDATE users SET
        name = COALESCE($1, name),
        district = COALESCE($2, district),
        province = COALESCE($3, province),
        preferred_network = COALESCE($4, preferred_network),
        mobile_money_number = COALESCE($5, mobile_money_number),
        updated_at = NOW()
      WHERE id = $6
      RETURNING id, name, district, province, preferred_network, mobile_money_number
    `, [name, district, province, preferred_network, mobile_money_number, req.user.id]);
    res.json({ message: 'Profile updated', user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

module.exports = router;
