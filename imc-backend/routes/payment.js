const express = require('express');
const Stripe = require('stripe');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ── CREATE PAYMENT INTENT ──────────────────────────────────────────────────
router.post('/imc/create-payment-intent', authenticateToken, async (req, res) => {

    console.log('TOKEN USER:', req.user);
console.log('LOOKING FOR APPLICANT ID:', req.user.applicantId);
  try {
    const applicantId = req.user.applicantId;

    const result = await pool.query(
      `SELECT * FROM applicants WHERE id = $1`,
      [applicantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Applicant not found' });
    }

    const applicant = result.rows[0];

    if (applicant.imc_status !== 'invoice_requested') {
      return res.status(400).json({ success: false, message: 'Payment unavailable for current status' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: 66300,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: {
        applicantId: applicant.id,
        entryPermit: applicant.entry_permit_ref
      }
    });

    res.json({ success: true, clientSecret: paymentIntent.client_secret });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Could not create payment intent' });
  }
});

// ── CONFIRM PAYMENT ────────────────────────────────────────────────────────
router.post('/imc/confirm-payment', authenticateToken, async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    const applicantId = req.user.applicantId;

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ success: false, message: 'Payment not completed' });
    }

    const result = await pool.query(
      `UPDATE applicants
       SET imc_status = 'payment_confirmed',
           payment_reference = $1,
           payment_confirmed_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [paymentIntentId, applicantId]
    );

    res.json({ success: true, applicant: result.rows[0] });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Payment confirmation failed' });
  }
});

// ── MANUAL INVOICE REQUEST ─────────────────────────────────────────────────
router.post('/imc/invoice-request', authenticateToken, async (req, res) => {
  try {
    const applicantId = req.user.applicantId;
    const invoiceRef = 'INV-' + Math.floor(100000 + Math.random() * 900000);

    const result = await pool.query(
      `UPDATE applicants
       SET imc_status = 'payment_pending',
           invoice_ref = $1
       WHERE id = $2
       RETURNING *`,
      [invoiceRef, applicantId]
    );

    res.json({ success: true, invoiceRef, applicant: result.rows[0] });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Could not create invoice request' });
  }
});

// ── ADMIN: UPDATE STATUS ───────────────────────────────────────────────────
router.post('/admin/update-status', async (req, res) => {
  try {
    // Auth check — must be inside the route handler
    const adminSecret = req.headers['x-admin-secret'];
    if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ success: false, message: 'Unauthorised' });
    }

    const { entryPermitRef, status } = req.body;

    const timestampField = {
      'payment_confirmed':           'payment_confirmed_at',
      'medical_scheduled':           'imc_code_issued_at',
      'medical_completed':           null,
      'personal_number_issued':      'personal_number_issued_at',
      'completed':                   null,
      'entry_permit_verified':       null,
      'medical_reservation_pending': null,
    }[status];

    let query;

    if (timestampField) {
      query = `
        UPDATE applicants
        SET imc_status = $1,
            ${timestampField} = NOW()
        WHERE entry_permit_ref = $2
        RETURNING *
      `;
    } else {
      query = `
        UPDATE applicants
        SET imc_status = $1
        WHERE entry_permit_ref = $2
        RETURNING *
      `;
    }

    const result = await pool.query(query, [status, entryPermitRef]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Applicant not found' });
    }

    res.json({ success: true, applicant: result.rows[0] });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Status update failed' });
  }
});

module.exports = router;