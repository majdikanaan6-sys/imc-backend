const express = require('express');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

const router = express.Router();

// ── HELPER: bridge JWT (entry_permits.id) → applicants row ────────────────
// JWT contains entry_permits.id — we get applicant via passport_number
async function getApplicant(entryPermitId) {
  const permitResult = await pool.query(
    'SELECT * FROM entry_permits WHERE id = $1',
    [entryPermitId]
  );
  if (permitResult.rows.length === 0) return { permit: null, applicant: null };

  const permit = permitResult.rows[0];

  const applicantResult = await pool.query(
    'SELECT * FROM applicants WHERE passport_number = $1',
    [permit.passport_number]
  );

  return { permit, applicant: applicantResult.rows[0] || null };
}

// ── CREATE PAYMENT INTENT ─────────────────────────────────────────────────
router.post('/imc/create-payment-intent', authenticateToken, async (req, res) => {
  try {
    const Stripe = require('stripe');
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

    const { permit, applicant } = await getApplicant(req.user.applicantId);

    if (!permit)    return res.status(404).json({ success: false, message: 'Permit not found' });
    if (!applicant) return res.status(404).json({ success: false, message: 'Applicant record not found' });

    if (applicant.imc_status !== 'invoice_requested') {
      return res.status(400).json({
        success: false,
        message: `Payment not available at current stage: ${applicant.imc_status}`,
      });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: 66300, // $663.00 USD in cents
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: {
        entry_permit_ref: applicant.entry_permit_ref,
        passport_number:  applicant.passport_number,
        full_name:        permit.full_name,
      },
    });

    res.json({ success: true, clientSecret: paymentIntent.client_secret });

  } catch (error) {
    console.error('Create payment intent error:', error);
    res.status(500).json({ success: false, message: 'Error completing payment' });
  }
});

// ── CONFIRM PAYMENT ───────────────────────────────────────────────────────
router.post('/imc/confirm-payment', authenticateToken, async (req, res) => {
  try {
    const Stripe = require('stripe');
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

    const { paymentIntentId } = req.body;
    const { permit, applicant } = await getApplicant(req.user.applicantId);

    if (!permit)    return res.status(404).json({ success: false, message: 'Permit not found' });
    if (!applicant) return res.status(404).json({ success: false, message: 'Applicant record not found' });

    // Verify with Stripe that payment actually succeeded
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({
        success: false,
        message: 'Payment has not been completed on Stripe.',
      });
    }

    const result = await pool.query(
      `UPDATE applicants
       SET imc_status           = 'payment_confirmed',
           payment_reference    = $1,
           payment_confirmed_at = NOW()
       WHERE passport_number = $2
       RETURNING *`,
      [paymentIntentId, permit.passport_number]
    );

    res.json({ success: true, applicant: result.rows[0] });

  } catch (error) {
    console.error('Confirm payment error:', error);
    res.status(500).json({ success: false, message: 'Payment confirmation failed' });
  }
});

// ── MANUAL INVOICE REQUEST ────────────────────────────────────────────────
router.post('/imc/invoice-request', authenticateToken, async (req, res) => {
  try {
    const { permit, applicant } = await getApplicant(req.user.applicantId);

    if (!permit)    return res.status(404).json({ success: false, message: 'Permit not found' });
    if (!applicant) return res.status(404).json({ success: false, message: 'Applicant record not found' });

    if (applicant.imc_status !== 'invoice_requested') {
      return res.status(400).json({
        success: false,
        message: `Invoice request not available at current stage: ${applicant.imc_status}`,
      });
    }

    const invoiceRef =
      'INV-' + new Date().getFullYear() + '-' +
      (applicant.entry_permit_ref || '').replace('EP-', '').replace(/-/g, '');

    const result = await pool.query(
      `UPDATE applicants
       SET imc_status           = 'payment_pending',
           invoice_ref          = $1,
           invoice_requested_at = NOW()
       WHERE passport_number = $2
       RETURNING *`,
      [invoiceRef, permit.passport_number]
    );

    res.json({
      success: true,
      message: 'Manual invoice request submitted. The NPRA IMC Office will contact you with official bank transfer details within 1 working day.',
      invoiceRef,
      applicant: result.rows[0],
    });

  } catch (error) {
    console.error('Invoice request error:', error);
    res.status(500).json({ success: false, message: 'Could not create invoice request' });
  }
});

module.exports = router;
