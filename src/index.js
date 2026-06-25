// src/index.js — AgriLink ZM Backend
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [process.env.APP_URL, 'https://agrilink-zm.up.railway.app']
    : '*',
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const ussdLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 30 });

app.use(limiter);

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // USSD sends form data

// Serve frontend
app.use(express.static(path.join(__dirname, '../public')));

// ============================================================
// ROUTES
// ============================================================
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/listings', require('./routes/listings'));
app.use('/api/deals', require('./routes/deals'));
app.use('/api/market', require('./routes/market'));
app.use('/api/ussd', ussdLimiter, require('./routes/ussd'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'AgriLink ZM',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    powered_by: 'InPay Zambia'
  });
});

// API docs overview
app.get('/api', (req, res) => {
  res.json({
    name: 'AgriLink ZM API',
    description: 'Farm-to-Market platform for Zambia and SADC',
    version: '1.0.0',
    endpoints: {
      auth: {
        'POST /api/auth/register': 'Register farmer or buyer',
        'POST /api/auth/login': 'Login',
        'GET /api/auth/me': 'Get profile (auth required)',
        'PATCH /api/auth/profile': 'Update profile (auth required)'
      },
      listings: {
        'GET /api/listings': 'Browse listings (filters: crop, category, district, province, min_price, max_price, grade)',
        'GET /api/listings/:id': 'Get single listing',
        'POST /api/listings': 'Post produce (farmer only)',
        'PATCH /api/listings/:id': 'Update listing (farmer only)',
        'DELETE /api/listings/:id': 'Remove listing (farmer only)',
        'GET /api/listings/my/all': 'My listings (farmer only)'
      },
      deals: {
        'POST /api/deals': 'Initiate a deal + InPay payment (buyer only)',
        'POST /api/deals/webhook': 'InPay payment webhook',
        'GET /api/deals/my': 'My deals',
        'POST /api/deals/:id/confirm-pickup': 'Confirm pickup + rate farmer (buyer only)'
      },
      market: {
        'GET /api/market/prices': 'Latest crop prices',
        'GET /api/market/crops': 'All crop types',
        'GET /api/market/stats': 'Platform statistics',
        'GET /api/market/buy-orders': 'Buyer demand board',
        'POST /api/market/buy-orders': 'Post buy order (buyer only)',
        'POST /api/market/alerts': 'Set price alert (auth required)',
        'GET /api/market/notifications': 'My notifications (auth required)'
      },
      ussd: {
        'POST /api/ussd': "Africa's Talking USSD webhook — dial *384*5544#"
      }
    },
    payment_rail: 'InPay Zambia — MTN, Airtel, Zamtel, SpeedPay/Zanaco, ZedMobile',
    contact: 'agrilink@inpay.zm'
  });
});

// Frontend catch-all (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════╗
  ║   🌾 AgriLink ZM — Backend       ║
  ║   Port: ${PORT}                      ║
  ║   Powered by InPay Zambia         ║
  ╚═══════════════════════════════════╝
  `);
  console.log(`API docs: http://localhost:${PORT}/api`);
  console.log(`Health:   http://localhost:${PORT}/api/health`);
  console.log(`USSD:     POST http://localhost:${PORT}/api/ussd`);
});

module.exports = app;
