const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../db");

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
      `SELECT * FROM entry_permits
       WHERE entry_permit_ref = $1
       AND passport_number = $2
       AND permit_status = 'active'`,
      [entryPermitRef, passportNumber]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    const permit = result.rows[0];

    const token = jwt.sign(
      { applicantId: permit.id },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({
      success: true,
      token,
      applicant: permit,
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

// ── STAGE 5: INVOICE REQUEST ─────────────────────────────────────────────────
router.post("/imc/invoice-request", authMiddleware, async (req, res) => {
  try {
    // Get passport number from entry_permits via JWT id
    const permitResult = await pool.query(
      "SELECT passport_number, entry_permit_ref FROM entry_permits WHERE id = $1",
      [req.applicant.applicantId]
    );

    if (permitResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Permit not found" });
    }

    const { passport_number, entry_permit_ref } = permitResult.rows[0];

    const current = await pool.query(
      "SELECT imc_status FROM applicants WHERE passport_number = $1",
      [passport_number]
    );

    if (!current.rows[0] || current.rows[0].imc_status !== "invoice_requested") {
      return res.status(400).json({
        success: false,
        message: `Invoice not available at current stage: ${current.rows[0]?.imc_status}`,
      });
    }

    const invoiceRef =
      "INV-" + new Date().getFullYear() + "-" +
      entry_permit_ref.replace("EP-", "").replace(/-/g, "");

    const result = await pool.query(
      `UPDATE applicants
       SET invoice_ref = $1,
           invoice_requested_at = NOW(),
           imc_status = 'payment_pending'
       WHERE passport_number = $2
       RETURNING imc_status, invoice_ref, invoice_requested_at`,
      [invoiceRef, passport_number]
    );

    res.json({
      success: true,
      message: "Invoice request submitted. You will receive payment instructions within 1 working day. Do not make any payment until you receive official banking details from NPRA.",
      data: result.rows[0],
    });

  } catch (error) {
    console.error("Invoice error:", error);
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

// ── ADMIN: UPDATE MEDICAL DETAILS ─────────────────────────────────────────────
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
