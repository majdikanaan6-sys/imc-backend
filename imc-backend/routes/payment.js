const express = require('express');
const pool = require('../db');
const multer    = require('multer');
const cloudinary = require('cloudinary').v2;
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

// Configure Cloudinary — add these to Railway env vars
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer — memory storage (no disk write)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/png', 'image/jpeg'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Invalid file type'));
  }
});

// ── UPLOAD PAYMENT PROOF ───────────────────────────────────
router.post(
'/imc/upload-payment-proof',
authenticateToken,
upload.single('file'),
async (req, res) => {

try {

console.log('UPLOAD TOKEN:', req.user);

if (!req.file) {
  return res.status(400).json({
    success:false,
    message:'No file uploaded'
  });
}

const permitId = req.user.applicantId;


// Get passport from entry permit
const permit = await pool.query(
`
SELECT
passport_number,
entry_permit_ref
FROM entry_permits
WHERE id=$1
`,
[permitId]
);

if (permit.rows.length === 0) {
  return res.status(404).json({
    success:false,
    message:'Entry permit not found'
  });
}

const {
passport_number,
entry_permit_ref
} = permit.rows[0];

router.post('/imc/upload-otb-proof', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

    const { permit, applicant } = await getApplicant(req.user.applicantId);
    if (!permit)    return res.status(404).json({ success: false, message: 'Permit not found' });
    if (!applicant) return res.status(404).json({ success: false, message: 'Applicant not found' });

    if (!applicant.requires_otb || !applicant.otb_invoice_issued) {
      return res.status(400).json({ success: false, message: 'OTB upload not available.' });
    }

    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: 'imc-otb-proofs',
          public_id: `otb_${applicant.entry_permit_ref}_${Date.now()}`,
          resource_type: 'auto',
        },
        (error, result) => { if (error) reject(error); else resolve(result); }
      );
      stream.end(req.file.buffer);
    });

    await pool.query(
      `UPDATE applicants
       SET otb_payment_proof_url       = $1,
           otb_payment_proof_submitted = true,
           otb_payment_proof_uploaded_at = NOW()
       WHERE passport_number = $2`,
      [uploadResult.secure_url, permit.passport_number]
    );

    res.json({ success: true, message: 'OTB payment receipt submitted.', url: uploadResult.secure_url });

  } catch (error) {
    console.error('OTB upload error:', error);
    res.status(500).json({ success: false, message: 'Upload failed.' });
  }
});


// Get actual applicant
const appl = await pool.query(
`
SELECT id
FROM applicants
WHERE passport_number=$1
`,
[passport_number]
);

if (appl.rows.length===0){
return res.status(404).json({
success:false,
message:'Applicant not found'
});
}

const applicantId=appl.rows[0].id;


// Upload file to Cloudinary
const uploadResult =
await new Promise((resolve,reject)=>{

const stream =
cloudinary.uploader.upload_stream(
{
folder:'imc-payment-proofs',
public_id:`${entry_permit_ref}_${Date.now()}`,
resource_type:'auto',
tags:[
entry_permit_ref,
passport_number
]
},
(error,result)=>{
if(error) reject(error);
else resolve(result);
}
);

stream.end(req.file.buffer);

});


// Save proof URL + flip flag — single query, before res.json()
await pool.query(
  `UPDATE applicants
   SET payment_proof_url       = $1,
       payment_proof_submitted = true,
       payment_proof_uploaded_at = NOW()
   WHERE id = $2`,
  [uploadResult.secure_url, applicantId]
);

res.json({
  success: true,
  message: 'Payment proof uploaded successfully',
  url: uploadResult.secure_url
});
}
catch(error){

console.error(
error.response?.data ||
error.message ||
error
);

res.status(500).json({
success:false,
message:'Upload failed'
});

}

});

module.exports = router;
