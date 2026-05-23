const express = require('express');
const pool = require('../db');
const axios = require('axios');

const router = express.Router();

// ───────────────────────────────────────────────────────
// ADMIN AUTH MIDDLEWARE
// ───────────────────────────────────────────────────────

function verifyAdmin(req, res, next) {

  const adminSecret = req.headers['x-admin-secret'];

  if (adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorised'
    });
  }

  next();
}

// ───────────────────────────────────────────────────────
// FIND APPLICANT
// ───────────────────────────────────────────────────────

router.get('/admin/find-applicant/:value', verifyAdmin, async (req, res) => {

  try {

    const value = req.params.value.trim();

    const result = await pool.query(
      `
      SELECT *
      FROM applicants
      WHERE entry_permit_ref = $1
      OR passport_number = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [value]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Applicant not found'
      });
    }

    res.json({
      success: true,
      applicant: result.rows[0]
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      message: 'Unable to find applicant'
    });
  }
});

// ───────────────────────────────────────────────────────
// UPDATE APPLICANT STATUS
// ───────────────────────────────────────────────────────

router.post('/admin/update-status', verifyAdmin, async (req, res) => {

  try {

    const {
      entry_permit_ref,
      status
    } = req.body;

    if (!entry_permit_ref || !status) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    const result = await pool.query(
      `
      UPDATE applicants
      SET imc_status = $1
      WHERE entry_permit_ref = $2
      RETURNING *
      `,
      [status, entry_permit_ref]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Applicant not found'
      });
    }

    res.json({
      success: true,
      message: 'Status updated successfully',
      applicant: result.rows[0]
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      message: 'Unable to update applicant status'
    });
  }
});

// ───────────────────────────────────────────────────────
// ISSUE INVOICE
// ───────────────────────────────────────────────────────

router.post('/admin/issue-invoice', verifyAdmin, async (req, res) => {

  try {

    const {
      entry_permit_ref
    } = req.body;

    if (!entry_permit_ref) {
      return res.status(400).json({
        success: false,
        message: 'Entry permit reference is required'
      });
    }

    const invoiceRef =
      'INV-' +
      new Date().getFullYear() +
      '-' +
      Math.floor(100000 + Math.random() * 900000);

    const result = await pool.query(
      `
      UPDATE applicants
      SET
        invoice_ref = $1,
        invoice_requested_at = NOW(),
        imc_status = 'payment_pending'
      WHERE entry_permit_ref = $2
      RETURNING *
      `,
      [
        invoiceRef,
        entry_permit_ref
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Applicant not found'
      });
    }

    res.json({
      success: true,
      message: 'Invoice issued successfully',
      applicant: result.rows[0]
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      message: 'Unable to issue invoice'
    });
  }
});

// ───────────────────────────────────────────────────────
// REVOKE INVOICE
// ───────────────────────────────────────────────────────

router.post('/admin/revoke-invoice', verifyAdmin, async (req, res) => {

  try {

    const {
      entry_permit_ref
    } = req.body;

    const result = await pool.query(
      `
      UPDATE applicants
      SET
        invoice_ref = NULL,
        invoice_requested_at = NULL,
        payment_confirmed_at = NULL,
        imc_status = 'medical_reservation_pending'
      WHERE entry_permit_ref = $1
      RETURNING *
      `,
      [entry_permit_ref]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Applicant not found'
      });
    }

    res.json({
      success: true,
      message: 'Invoice revoked successfully',
      applicant: result.rows[0]
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      message: 'Unable to revoke invoice'
    });
  }
});

// ───────────────────────────────────────────────────────
// CONFIRM PAYMENT
// ───────────────────────────────────────────────────────

router.post('/admin/confirm-payment', verifyAdmin, async (req, res) => {

  try {

    const {
      entry_permit_ref
    } = req.body;

    const result = await pool.query(
      `
      UPDATE applicants
      SET
        payment_confirmed_at = NOW(),
        imc_status = 'payment_confirmed'
      WHERE entry_permit_ref = $1
      RETURNING *
      `,
      [entry_permit_ref]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Applicant not found'
      });
    }

    res.json({
      success: true,
      message: 'Payment confirmed successfully',
      applicant: result.rows[0]
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      message: 'Unable to confirm payment'
    });
  }
});

// ───────────────────────────────────────────────────────
// SEND EMAIL NOTIFICATION
// ───────────────────────────────────────────────────────

router.post('/admin/send-loi-response', verifyAdmin, async (req, res) => {

  try {

    const {
      passportNumber,
      type = 'loi'
    } = req.body;

    if (!passportNumber) {
      return res.status(400).json({
        success: false,
        message: 'Passport number required'
      });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM applicants
      WHERE passport_number = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [passportNumber.trim().toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Applicant not found'
      });
    }

    const a = result.rows[0];

    let subject = '';
    let html = '';

    // SIMPLE TEMPLATE SWITCHING

    if (type === 'invoice_ready') {

      subject =
        `Invoice Ready — ${a.entry_permit_ref}`;

      html = `
        <div style="font-family:Arial;padding:30px;">
          <h2>Invoice Ready</h2>

          <p>
            Dear ${a.full_name},
          </p>

          <p>
            Your IMC invoice has been generated successfully.
          </p>

          <p>
            Invoice Reference:
            <strong>${a.invoice_ref || 'Pending'}</strong>
          </p>

          <p>
            Please login to your dashboard to continue.
          </p>
        </div>
      `;

    } else if (type === 'istanbul') {

      subject =
        'IMC Medical Examination — Istanbul Arrangement';

      html = `
        <div style="font-family:Arial;padding:30px;">
          <h2>Istanbul Medical Arrangement</h2>

          <p>
            Dear ${a.full_name},
          </p>

          <p>
            Your IMC medical examination will be coordinated
            through Istanbul due to facility availability.
          </p>
        </div>
      `;

    } else {

      subject =
        'IMC Application – Required Documents';

      html = `
        <div style="font-family:Arial;padding:30px;">
          <h2>Required Documents</h2>

          <p>
            Dear ${a.full_name},
          </p>

          <p>
            Additional information is required
            to continue your IMC application.
          </p>
        </div>
      `;
    }

    await axios.post(
      'https://api.resend.com/emails',
      {
        from:
          'NPRA Bahrain <booking@npra.gov.bh-ihc.site>',

        to: [a.email],

        subject,

        html
      },
      {
        headers: {
          Authorization:
            `Bearer ${process.env.RESEND_API_KEY}`,

          'Content-Type':
            'application/json'
        }
      }
    );

    res.json({
      success: true,
      message: 'Email sent successfully'
    });

  } catch (error) {

    console.error(
      error.response?.data ||
      error.message ||
      error
    );

    res.status(500).json({
      success: false,
      message: 'Unable to send email'
    });
  }
});

// SEARCH APPLICANT
router.get('/admin/search', async (req,res)=>{
  try{

    const adminSecret=req.headers['x-admin-secret'];

    if(adminSecret!==process.env.ADMIN_SECRET){
      return res.status(401).json({
        success:false,
        message:'Unauthorised'
      });
    }

    const q=(req.query.q || '').trim().toUpperCase();

    const result=await pool.query(`
      SELECT *
      FROM applicants
      WHERE
      UPPER(entry_permit_ref)=UPPER($1)
      OR
      UPPER(passport_number)=UPPER($1)
      ORDER BY created_at DESC
      LIMIT 1
    `,[q]);

    if(result.rows.length===0){
      return res.json({
        success:false,
        message:'Applicant not found'
      });
    }

    res.json({
      success:true,
      applicant:result.rows[0]
    });

  }catch(err){

    console.log(err);

    res.status(500).json({
      success:false,
      message:'Search failed'
    });

  }
});


// GET ALL APPLICANTS
router.get('/admin/applicants', async(req,res)=>{

  try{

    const adminSecret=req.headers['x-admin-secret'];

    if(adminSecret!==process.env.ADMIN_SECRET){
      return res.status(401).json({
        success:false,
        message:'Unauthorised'
      });
    }

    const result=await pool.query(`
      SELECT *
      FROM applicants
      ORDER BY created_at DESC
    `);

    res.json({
      success:true,
      applicants:result.rows
    });

  }catch(err){

    console.log(err);

    res.status(500).json({
      success:false,
      message:'Failed to load applicants'
    });

  }

});

router.post('/admin/set-payment-method', async (req, res) => {
  try {
    const { entry_permit_ref, payment_method } = req.body;

    if (!['bank_transfer', 'wu_mg'].includes(payment_method)) {
      return res.status(400).json({ 
        success: false, 
        message: 'payment_method must be bank_transfer or wu_mg' 
      });
    }

    const result = await pool.query(
      `UPDATE applicants 
       SET payment_method = $1 
       WHERE entry_permit_ref = $2 
       RETURNING entry_permit_ref, payment_method, imc_status`,
      [payment_method, entry_permit_ref]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Applicant not found' });
    }

    res.json({ success: true, applicant: result.rows[0] });

  } catch (error) {
    console.error('Set payment method error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;