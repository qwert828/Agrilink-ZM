// src/routes/deals.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const FEE_PERCENT = parseFloat(process.env.TRANSACTION_FEE_PERCENT || '1.78') / 100;

// POST /api/deals — buyer initiates a deal
router.post('/', auth, requireRole('buyer'), async (req, res) => {
  const { listing_id, quantity, payment_network, buyer_phone } = req.body;

  if (!listing_id || !quantity || !payment_network) {
    return res.status(400).json({ error: 'listing_id, quantity, and payment_network are required' });
  }

  try {
    // Fetch listing
    const listingResult = await db.query(`
      SELECT l.*, u.mobile_money_number AS farmer_mobile, u.preferred_network AS farmer_network, u.name AS farmer_name
      FROM listings l
      JOIN users u ON l.farmer_id = u.id
      WHERE l.id = $1 AND l.status = 'active'
    `, [listing_id]);

    if (!listingResult.rows.length) return res.status(404).json({ error: 'Listing not found or no longer available' });
    const listing = listingResult.rows[0];

    if (quantity > listing.quantity_available) {
      return res.status(400).json({ error: `Only ${listing.quantity_available} ${listing.unit} available` });
    }

    // Calculate financials
    const subtotal = parseFloat(listing.price_per_unit) * parseFloat(quantity);
    const inpay_fee = parseFloat((subtotal * FEE_PERCENT).toFixed(2));
    const total_zmw = parseFloat((subtotal + inpay_fee).toFixed(2));

    // Create deal record
    const dealResult = await db.query(`
      INSERT INTO deals (
        listing_id, farmer_id, buyer_id, crop_name, quantity, unit,
        agreed_price_per_unit, subtotal, inpay_fee, total_zmw,
        payment_network, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'payment_pending')
      RETURNING *
    `, [
      listing_id, listing.farmer_id, req.user.id,
      listing.crop_name, quantity, listing.unit,
      listing.price_per_unit, subtotal, inpay_fee, total_zmw,
      payment_network
    ]);

    const deal = dealResult.rows[0];

    // Initiate InPay payment (collect from buyer)
    const inpayResponse = await initiateInPayCollection({
      dealId: deal.id,
      amount: total_zmw,
      phone: buyer_phone,
      network: payment_network,
      description: `AgriLink: ${quantity} ${listing.unit} of ${listing.crop_name} from ${listing.farmer_name}`
    });

    if (!inpayResponse.success) {
      // Mark deal as failed
      await db.query(`UPDATE deals SET status = 'cancelled', payment_status = 'failed' WHERE id = $1`, [deal.id]);
      return res.status(502).json({ error: 'Payment initiation failed', detail: inpayResponse.error });
    }

    // Store InPay reference
    await db.query(`
      UPDATE deals SET payment_reference = $1, payment_status = 'processing', updated_at = NOW()
      WHERE id = $2
    `, [inpayResponse.reference, deal.id]);

    // Notify farmer
    await db.query(`
      INSERT INTO notifications (user_id, type, title, body, data)
      VALUES ($1, 'deal_initiated', $2, $3, $4)
    `, [
      listing.farmer_id,
      `New deal — ${listing.crop_name}`,
      `A buyer wants ${quantity} ${listing.unit} at K${listing.price_per_unit}. Payment processing.`,
      JSON.stringify({ deal_id: deal.id })
    ]);

    res.status(201).json({
      message: 'Deal initiated — payment processing',
      deal: {
        id: deal.id,
        crop_name: deal.crop_name,
        quantity: deal.quantity,
        unit: deal.unit,
        subtotal,
        fee: inpay_fee,
        total: total_zmw,
        payment_reference: inpayResponse.reference,
        status: 'payment_pending'
      }
    });

  } catch (err) {
    console.error('Deal creation error:', err);
    res.status(500).json({ error: 'Deal creation failed' });
  }
});

// POST /api/deals/webhook — InPay payment webhook
router.post('/webhook', async (req, res) => {
  const { reference, status, transaction_id } = req.body;

  try {
    const dealResult = await db.query(`
      SELECT d.*, u.mobile_money_number AS farmer_mobile, u.preferred_network AS farmer_network,
             u.name AS farmer_name, l.quantity_available, l.id AS lid
      FROM deals d
      JOIN users u ON d.farmer_id = u.id
      JOIN listings l ON d.listing_id = l.id
      WHERE d.payment_reference = $1
    `, [reference]);

    if (!dealResult.rows.length) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealResult.rows[0];

    if (status === 'completed') {
      // Payment received — disburse to farmer
      const farmerPayout = deal.subtotal; // farmer gets full subtotal, fee stays with AgriLink

      const payoutResponse = await initiateInPayDisbursement({
        amount: farmerPayout,
        phone: deal.farmer_mobile,
        network: deal.farmer_network,
        description: `AgriLink payout: ${deal.quantity} ${deal.unit} of ${deal.crop_name}`,
        dealId: deal.id
      });

      await db.query(`
        UPDATE deals SET
          payment_status = 'completed',
          farmer_payout_status = $1,
          farmer_payout_reference = $2,
          status = 'paid',
          updated_at = NOW()
        WHERE id = $3
      `, [
        payoutResponse.success ? 'sent' : 'pending',
        payoutResponse.reference || null,
        deal.id
      ]);

      // Decrease listing quantity
      await db.query(`
        UPDATE listings SET
          quantity_available = quantity_available - $1,
          status = CASE WHEN quantity_available - $1 <= 0 THEN 'sold' ELSE status END,
          updated_at = NOW()
        WHERE id = $2
      `, [deal.quantity, deal.lid]);

      // Update farmer stats
      await db.query(`
        UPDATE users SET
          total_deals = total_deals + 1,
          total_volume_zmw = total_volume_zmw + $1,
          updated_at = NOW()
        WHERE id = $2
      `, [deal.subtotal, deal.farmer_id]);

      // Notify farmer of payout
      await db.query(`
        INSERT INTO notifications (user_id, type, title, body, data)
        VALUES ($1, 'payment_received', 'Payment received!', $2, $3)
      `, [
        deal.farmer_id,
        `K${deal.subtotal} sent to your ${deal.farmer_network} wallet for ${deal.quantity} ${deal.unit} of ${deal.crop_name}`,
        JSON.stringify({ deal_id: deal.id, amount: deal.subtotal })
      ]);

      // Notify buyer
      await db.query(`
        INSERT INTO notifications (user_id, type, title, body, data)
        VALUES ($1, 'deal_confirmed', 'Deal confirmed!', $2, $3)
      `, [
        deal.buyer_id,
        `Payment confirmed. Coordinate pickup with farmer for ${deal.crop_name}.`,
        JSON.stringify({ deal_id: deal.id })
      ]);

    } else if (status === 'failed') {
      await db.query(`
        UPDATE deals SET payment_status = 'failed', status = 'cancelled', updated_at = NOW()
        WHERE id = $1
      `, [deal.id]);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// GET /api/deals/my — get user's deals
router.get('/my', auth, async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const field = req.user.role === 'farmer' ? 'farmer_id' : 'buyer_id';
  const offset = (page - 1) * limit;
  const params = [req.user.id];
  let statusClause = '';
  if (status) { statusClause = `AND d.status = $2`; params.push(status); }

  try {
    const result = await db.query(`
      SELECT d.*,
        uf.name AS farmer_name, uf.phone AS farmer_phone, uf.rating AS farmer_rating,
        ub.name AS buyer_name, ub.phone AS buyer_phone
      FROM deals d
      JOIN users uf ON d.farmer_id = uf.id
      JOIN users ub ON d.buyer_id = ub.id
      WHERE d.${field} = $1 ${statusClause}
      ORDER BY d.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `, params);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch deals' });
  }
});

// POST /api/deals/:id/confirm-pickup — buyer confirms they received produce
router.post('/:id/confirm-pickup', auth, requireRole('buyer'), async (req, res) => {
  const { farmer_rating } = req.body;
  try {
    await db.query(`
      UPDATE deals SET
        pickup_confirmed = true,
        farmer_rating = $1,
        status = 'completed',
        updated_at = NOW()
      WHERE id = $2 AND buyer_id = $3
    `, [farmer_rating || null, req.params.id, req.user.id]);

    // Update farmer rating
    if (farmer_rating) {
      await db.query(`
        UPDATE users SET
          rating = (SELECT AVG(farmer_rating) FROM deals WHERE farmer_id = users.id AND farmer_rating IS NOT NULL)
        WHERE id = (SELECT farmer_id FROM deals WHERE id = $1)
      `, [req.params.id]);
    }

    res.json({ message: 'Pickup confirmed — deal complete' });
  } catch (err) {
    res.status(500).json({ error: 'Confirmation failed' });
  }
});

// ============================================================
// INPAY INTEGRATION HELPERS
// ============================================================

async function initiateInPayCollection({ dealId, amount, phone, network, description }) {
  try {
    const response = await axios.post(`${process.env.INPAY_API_URL}/api/payments/collect`, {
      merchant_id: process.env.INPAY_MERCHANT_ID,
      amount,
      phone,
      network,
      reference: `AGRILINK-${dealId}`,
      description,
      callback_url: `${process.env.APP_URL}/api/deals/webhook`
    }, {
      headers: { 'X-API-Key': process.env.INPAY_API_KEY }
    });

    return { success: true, reference: response.data.reference || `AGRILINK-${dealId}` };
  } catch (err) {
    console.error('InPay collection error:', err.response?.data || err.message);
    // In sandbox/dev mode, simulate success
    if (process.env.NODE_ENV !== 'production') {
      return { success: true, reference: `AGRILINK-${dealId}-SANDBOX` };
    }
    return { success: false, error: err.response?.data?.message || 'InPay error' };
  }
}

async function initiateInPayDisbursement({ amount, phone, network, description, dealId }) {
  try {
    const response = await axios.post(`${process.env.INPAY_API_URL}/api/payments/disburse`, {
      merchant_id: process.env.INPAY_MERCHANT_ID,
      amount,
      phone,
      network,
      reference: `AGRILINK-PAYOUT-${dealId}`,
      description
    }, {
      headers: { 'X-API-Key': process.env.INPAY_API_KEY }
    });

    return { success: true, reference: response.data.reference };
  } catch (err) {
    console.error('InPay disburse error:', err.response?.data || err.message);
    if (process.env.NODE_ENV !== 'production') {
      return { success: true, reference: `PAYOUT-${dealId}-SANDBOX` };
    }
    return { success: false };
  }
}

module.exports = router;
