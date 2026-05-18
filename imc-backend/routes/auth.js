const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const axios = require("axios");
const router = express.Router();

// ── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "Unauthorised" });
  }
  try {
    const token = header.split(" ")[1];
    req.applicant = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid token" });
  }
}
 

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
router.get("/health", (req, res) => {
  res.json({ success: true, message: "Auth routes working" });
});

// ── LOGIN ────────────────────────────────────────────────────────────────────
router.post("/imc/login", async (req, res) => {
  try {
    const { entryPermitRef, passportNumber } = req.body;

   const result = await pool.query(
`
SELECT

ep.*,

a.date_of_birth,
a.passport_expiry,
a.employer,
a.role,
a.sponsorship_type,
a.email,
a.phone,
a.imc_status

FROM entry_permits ep

LEFT JOIN applicants a
ON ep.entry_permit_ref = a.entry_permit_ref

WHERE ep.entry_permit_ref = $1
AND ep.passport_number = $2
AND ep.permit_status='active'
`,
[entryPermitRef, passportNumber]
);

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    const permit = result.rows[0];

    // GET APPLICANT WORKFLOW RECORD

    const applicantResult = await pool.query(

      `
      SELECT *
      FROM applicants
      WHERE entry_permit_ref = $1
      `,

      [permit.entry_permit_ref]

    );

    const applicant = applicantResult.rows[0] || {};


    const token = jwt.sign(
      { applicantId: permit.id },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

       // RETURN FULL APPLICANT WORKFLOW DATA

    res.json({

      success: true,

      token,

      applicant: {

        ...applicant,

        // Always trust identity data from entry_permits
        entry_permit_ref: permit.entry_permit_ref,
        passport_number: permit.passport_number,
        full_name: permit.full_name,
        nationality: permit.nationality,
        sponsor_name: permit.sponsor_name,
        sponsor_airline: permit.sponsor_airline,
        permit_status: permit.permit_status

      }

    });

  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET ME (protected) ───────────────────────────────────────────────────────
// JWT id comes from entry_permits — fetch both tables and merge
router.get("/imc/me", authMiddleware, async (req, res) => {
  try {
    // 1. Get identity record from entry_permits using JWT id
    const permitResult = await pool.query(
      "SELECT * FROM entry_permits WHERE id = $1",
      [req.applicant.applicantId]
    );

    if (permitResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Permit record not found" });
    }

    const permit = permitResult.rows[0];

    // 2. Get IMC workflow record from applicants using passport_number as the link
    const applicantResult = await pool.query(
      "SELECT * FROM applicants WHERE passport_number = $1",
      [permit.passport_number]
    );

    const applicant = applicantResult.rows[0] || {};

    // 3. Merge — identity & sponsor data from entry_permits, workflow from applicants
    const merged = {
      ...applicant,
      entry_permit_ref:   permit.entry_permit_ref,
      passport_number:    permit.passport_number,
      full_name:          permit.full_name,
      nationality:        permit.nationality,
      sponsor_name:       permit.sponsor_name,
      sponsor_airline:    permit.sponsor_airline,
      permit_issue_date:  permit.permit_issue_date,
      permit_expiry_date: permit.permit_expiry_date,
    };

    res.json({ success: true, applicant: merged });

  } catch (error) {
    console.error("Me error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── STAGE 1: Letter of Intent ─────────────────────────────────────────────
router.post("/imc/loi", async (req, res) => {
  try {
    const {
      fullName, nationality, dateOfBirth,
      passportNumber, passportExpiry,
      email, phone, employer, role,
      sponsorshipType, loiMessage,
    } = req.body;

    // Required fields check
    if (!fullName || !passportNumber || !email || !loiMessage) {
      return res.status(400).json({
        success: false,
        message: "Full name, passport number, email and message are required.",
      });
    }

    // Block duplicate passport numbers
    const existing = await pool.query(
      "SELECT id FROM applicants WHERE passport_number = $1",
      [passportNumber.trim().toUpperCase()]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "An application with this passport number already exists. Please contact booking@npra.gov.bh if you believe this is an error.",
      });
    }

    const result = await pool.query(
      `INSERT INTO applicants (
        full_name, nationality, date_of_birth,
        passport_number, passport_expiry,
        email, phone, employer, role,
        sponsorship_type, loi_message,
        loi_submitted_at, imc_status
       ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),'letter_submitted'
       ) RETURNING id, full_name, passport_number, imc_status, loi_submitted_at`,
      [
        fullName.trim(),
        nationality?.trim(),
        dateOfBirth,
        passportNumber.trim().toUpperCase(),
        passportExpiry,
        email.trim().toLowerCase(),
        phone?.trim(),
        employer?.trim(),
        role?.trim(),
        sponsorshipType,
        loiMessage.trim(),
      ]
    );
// Send email — isolated, never blocks the response
try {
  await axios.post(
    "https://api.resend.com/emails",
    {
      from: "NPRA Bahrain <booking@npra.gov.bh-ihc.site>",
      to: ["haithamjatal3@gmail.com"],
      subject: `New IMC Letter of Intent – ${fullName}`,
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.7;color:#0d1f3c;padding:24px;">
          <h2>New Immigration Medical Clearance Application</h2>
          <table style="border-collapse:collapse;width:100%;margin-top:20px;">
            <tr><td style="padding:10px;font-weight:bold;">Full Name</td><td style="padding:10px;">${fullName}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Nationality</td><td style="padding:10px;">${nationality}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Date of Birth</td><td style="padding:10px;">${dateOfBirth}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Passport Number</td><td style="padding:10px;">${passportNumber}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Passport Expiry</td><td style="padding:10px;">${passportExpiry}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Employer</td><td style="padding:10px;">${employer}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Position</td><td style="padding:10px;">${role}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Sponsorship Type</td><td style="padding:10px;">${sponsorshipType}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Email</td><td style="padding:10px;">${email}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Phone</td><td style="padding:10px;">${phone}</td></tr>
          </table>
          <div style="margin-top:30px;padding:18px;background:#f8f8f8;border-left:4px solid #c9a84c;">
            <strong>Letter of Intent</strong>
            <p style="margin-top:12px;">${loiMessage}</p>
          </div>
        </div>
      `
    },
    {
      headers: {
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );
} catch (emailError) {
  console.error("Resend email failed:", emailError.response?.data || emailError.message);
}

res.status(201).json({
  success: true,
  message: "Your Letter of Intent has been received. An IMC officer will review your application and contact you within 24 hours.",
  data: result.rows[0],
});

  } catch (error) {
    console.error("LOI error:", error);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ── STAGE 3: APPLICANT CONFIRMS AIRLINE ──────────────────────────────────────
router.post("/imc/confirm", authMiddleware, async (req, res) => {
  try {
    const { sponsorAirline } = req.body;

    if (!sponsorAirline) {
      return res.status(400).json({ success: false, message: "Sponsor airline is required." });
    }

    // Get passport number from entry_permits via JWT id
    const permitResult = await pool.query(
      "SELECT passport_number FROM entry_permits WHERE id = $1",
      [req.applicant.applicantId]
    );

    if (permitResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Permit not found" });
    }

    const { passport_number } = permitResult.rows[0];

    // Check current status
    const current = await pool.query(
      "SELECT imc_status FROM applicants WHERE passport_number = $1",
      [passport_number]
    );

    if (!current.rows[0] || current.rows[0].imc_status !== "entry_permit_verified") {
      return res.status(400).json({
        success: false,
        message: `Action not permitted at current stage: ${current.rows[0]?.imc_status}`,
      });
    }

    const result = await pool.query(
      `UPDATE applicants
       SET sponsor_airline = $1,
           applicant_confirmed_at = NOW(),
           imc_status = 'medical_reservation_pending'
       WHERE passport_number = $2
       RETURNING imc_status, sponsor_airline, applicant_confirmed_at`,
      [sponsorAirline, passport_number]
    );

    res.json({
      success: true,
      message: "Details confirmed. The IMC office will prepare your payment invoice.",
      data: result.rows[0],
    });

  } catch (error) {
    console.error("Confirm error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});



// ── ADMIN: CREATE ENTRY PERMIT ────────────────────────────────────────────────
router.post("/admin/create-entry-permit", async (req, res) => {
  try {
    const {
      passport_number, nationality, full_name,
      sponsor_name, sponsor_airline,
      permit_issue_date, permit_expiry_date,
    } = req.body;

    const insertResult = await pool.query(
      `INSERT INTO entry_permits (
        passport_number, nationality, full_name,
        sponsor_name, sponsor_airline,
        permit_issue_date, permit_expiry_date
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [passport_number, nationality, full_name,
       sponsor_name, sponsor_airline,
       permit_issue_date, permit_expiry_date]
    );

    const permit = insertResult.rows[0];

    const year = new Date().getFullYear();
    const randomNumber = Math.floor(10000000 + Math.random() * 90000000);
    const entryPermitRef = `EP-${year}-${randomNumber}`;

    const updateResult = await pool.query(
      `UPDATE entry_permits
       SET entry_permit_ref = $1, permit_status = 'active'
       WHERE id = $2
       RETURNING *`,
      [entryPermitRef, permit.id]
    );

    // Auto-create the applicants workflow record
    await pool.query(
      `INSERT INTO applicants (
        full_name, nationality, passport_number,
        entry_permit_ref, sponsor_name, sponsor_airline,
        imc_status
       ) VALUES ($1,$2,$3,$4,$5,$6,'entry_permit_issued')
       ON CONFLICT (passport_number) DO NOTHING`,
      [full_name, nationality, passport_number,
       entryPermitRef, sponsor_name, sponsor_airline]
    );

    res.json({ success: true, entryPermit: updateResult.rows[0] });

  } catch (error) {
    console.error("Create permit error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── ADMIN: CREATE APPLICANT (manual) ─────────────────────────────────────────
router.post("/admin/create-applicant", async (req, res) => {
  try {
    const {
      full_name, nationality, date_of_birth,
      passport_number, passport_expiry,
      email, phone, entry_permit_ref,
      sponsor_name, imc_code, employer, role, imc_status,
    } = req.body;

    const result = await pool.query(
      `INSERT INTO applicants (
        full_name, nationality, date_of_birth,
        passport_number, passport_expiry,
        email, phone, entry_permit_ref,
        sponsor_name, imc_code, employer, role, imc_status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [full_name, nationality, date_of_birth,
       passport_number, passport_expiry,
       email, phone, entry_permit_ref,
       sponsor_name, imc_code, employer, role, imc_status]
    );

    res.json({ success: true, applicant: result.rows[0] });

  } catch (error) {
    console.error("Create applicant error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── ADMIN: UPDATE STATUS ──────────────────────────────────────────────────────
router.post("/admin/update-status", async (req, res) => {
  try {
    const { entry_permit_ref, imc_status } = req.body;

    const result = await pool.query(
      `UPDATE applicants
       SET imc_status = $1
       WHERE entry_permit_ref = $2
       RETURNING *`,
      [imc_status, entry_permit_ref]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No applicant found with entry_permit_ref: ${entry_permit_ref}`,
      });
    }

    res.json({ success: true, applicant: result.rows[0] });

  } catch (error) {
    console.error("Update status error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── ADMIN: ISSUE MANUAL INVOICE ────────────────────────────────────────────
router.post('/admin/issue-invoice', async (req, res) => {
  try {
    const { entry_permit_ref } = req.body;

    // Only allow at payment_pending stage
    const current = await pool.query(
      'SELECT imc_status FROM applicants WHERE entry_permit_ref = $1',
      [entry_permit_ref]
    );

    if (current.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Applicant not found' 
      });
    }

    if (current.rows[0].imc_status !== 'payment_pending') {
      return res.status(400).json({
        success: false,
        message: `Invoice can only be issued at payment_pending stage. Current: ${current.rows[0].imc_status}`
      });
    }

    const result = await pool.query(
      `UPDATE applicants
       SET invoice_issued = true,
           invoice_requested_at = NOW()
       WHERE entry_permit_ref = $1
       RETURNING *`,
      [entry_permit_ref]
    );

    res.json({ 
      success: true, 
      message: 'Invoice issued successfully. Applicant can now access and download their invoice from the portal.',
      applicant: result.rows[0] 
    });

  } catch (error) {
    console.error('Issue invoice error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

//ASSIGN DOCTOR
router.post('/admin/assign-doctor', async (req, res) => {
  try {
    const { entry_permit_ref, doctor_name } = req.body;

    if (!doctor_name) {
      return res.status(400).json({ 
        success: false, 
        message: 'doctor_name is required.' 
      });
    }

    const result = await pool.query(
      `UPDATE applicants
       SET doctor_name = $1
       WHERE entry_permit_ref = $2
       RETURNING entry_permit_ref, doctor_name, imc_status`,
      [doctor_name, entry_permit_ref]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Applicant not found.' 
      });
    }

    res.json({ success: true, applicant: result.rows[0] });

  } catch (error) {
    console.error('Assign doctor error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── ADMIN: UPDATE MEDICAL DETAILSS ─────────────────────────────────────────────
router.post("/admin/update-medical", async (req, res) => {
  try {
    const {
      entry_permit_ref, imc_code,
      medical_facility, medical_facility_location,
      exam_date, doctor_name,
    } = req.body;

    const result = await pool.query(
      `UPDATE applicants
       SET imc_code = $1,
           medical_facility = $2,
           medical_facility_location = $3,
           exam_date = $4,
           doctor_name = $5,
           imc_code_issued_at = NOW(),
           imc_status = 'medical_scheduled'
       WHERE entry_permit_ref = $6
       RETURNING *`,
      [imc_code, medical_facility, medical_facility_location,
       exam_date, doctor_name, entry_permit_ref]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Applicant not found" });
    }

    res.json({ success: true, applicant: result.rows[0] });

  } catch (error) {
    console.error("Update medical error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── ADMIN: ISSUE PERSONAL NUMBER ──────────────────────────────────────────────
router.post("/admin/issue-personal-number", async (req, res) => {
  try {
    const { entry_permit_ref, personal_number } = req.body;

    const result = await pool.query(
      `UPDATE applicants
       SET personal_number = $1,
           personal_number_issued_at = NOW(),
           imc_status = 'personal_number_issued'
       WHERE entry_permit_ref = $2
       RETURNING *`,
      [personal_number, entry_permit_ref]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Applicant not found" });
    }

    res.json({ success: true, applicant: result.rows[0] });

  } catch (error) {
    console.error("Issue personal number error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
