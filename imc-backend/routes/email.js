const express = require("express");
const axios = require("axios");
const pool = require("../db");

const router = express.Router();

// ── SEND EMAIL VERIFICATION CODE ───────────────────────────────────────────
router.post("/send-verification-code", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: "Email address is required" });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    await pool.query(
      `INSERT INTO email_verifications (email, verification_code, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (email)
       DO UPDATE SET verification_code = EXCLUDED.verification_code, created_at = NOW()`,
      [normalizedEmail, verificationCode]
    );

    await axios.post(
      "https://api.resend.com/emails",
      {
        from: "NPRA Bahrain <booking@npra.gov.bh-ihc.site>",
        to: [normalizedEmail],
        subject: "Bahrain IMC Portal – Email Verification Code",
        html: `
          <div style="font-family:Arial,sans-serif;padding:24px;line-height:1.7;color:#0d1f3c;">
            <h2 style="margin-bottom:18px;color:#0d1f3c;">Bahrain Immigration Medical Clearance</h2>
            <p>Dear Applicant,</p>
            <p>Your email verification code is:</p>
            <div style="font-size:34px;font-weight:bold;letter-spacing:5px;margin:22px 0;color:#0d1f3c;">
              ${verificationCode}
            </div>
            <p>This verification code will expire in 10 minutes.</p>
            <p>If you did not request this verification, you may safely ignore this email.</p>
            <br>
            <p style="font-size:14px;color:#666;">
              Nationality, Passport &amp; Residence Affairs<br>
              Kingdom of Bahrain
            </p>
          </div>
        `
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({ success: true, message: "Verification code sent successfully" });

  } catch (error) {
    console.error(error.response?.data || error.message || error);
    res.status(500).json({ success: false, message: "Unable to send verification code" });
  }
});

// ── VERIFY EMAIL CODE ──────────────────────────────────────────────────────
router.post("/verify-code", async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ success: false, message: "Email and code are required" });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const result = await pool.query(
      `SELECT *
       FROM email_verifications
       WHERE email = $1
       AND verification_code = $2
       AND created_at > NOW() - INTERVAL '10 minutes'`,
      [normalizedEmail, code]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: "Invalid or expired verification code" });
    }

    res.json({ success: true, message: "Email verified successfully" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Verification failed" });
  }
});

// ── SEND CUSTOM EMAIL VIA RESEND ───────────────────────────────────────────
router.post("/send-resend-email", async (req, res) => {
  try {
    const { from, to, subject, html } = req.body;

    if (!from || !to || !subject || !html) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const response = await axios.post(
      "https://api.resend.com/emails",
      {
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        html
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({ success: true, id: response.data.id });

  } catch (error) {
    console.error(error.response?.data || error.message || error);
    res.status(500).json({ success: false, message: "Failed to send email" });
  }
});

// ── SEND LOI RESPONSE EMAIL ────────────────────────────────
router.post('/admin/send-loi-response', async (req, res) => {
  try {
    // Admin auth check
    const adminSecret = req.headers['x-admin-secret'];
    if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ success: false, message: 'Unauthorised' });
    }

    const { entryPermitRef } = req.body;

    // Fetch applicant from DB
    const result = await pool.query(
      `SELECT * FROM applicants WHERE entry_permit_ref = $1`,
      [entryPermitRef]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Applicant not found' });
    }

    const a = result.rows[0];

    // Generate reference number
    const year    = new Date().getFullYear();
    const refNum = Math.floor(1000 + Math.random() * 9000).toString();
    const date    = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    // Build HTML — replace placeholders dynamically
    const html = getEmailTemplate()
      .replace(/{{FULL_NAME}}/g,       a.full_name        || '—')
      .replace(/{{YEAR}}/g,            String(year))
      .replace(/{{REF_NUMBER}}/g,      refNum)
      .replace(/{{DATE}}/g,            date)
      .replace(/{{PASSPORT_NUMBER}}/g, a.passport_number  || '—');

    // Send via Resend good
    await axios.post(
      'https://api.resend.com/emails',
      {
        from:    'NPRA Bahrain <booking@npra.gov.bh-ihc.site>',
        to:      [a.email],
        subject: `IMC Application – Required Documents | Ref: NPRA/IMC/LOI/${year}/${refNum}`,
        html,
      },
      {
        headers: {
          Authorization:  `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        }
      }
    );

    res.json({ success: true, message: `Email sent to ${a.email}` });

  } catch (error) {
    console.error(error.response?.data || error.message || error);
    res.status(500).json({ success: false, message: 'Failed to send email' });
  }
});

// ── EMAIL TEMPLATE ─────────────────────────────────────────
function getEmailTemplate() {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f4f1eb;font-family:Georgia,'Times New Roman',serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f1eb;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid #ddd8ce;border-radius:4px;overflow:hidden;">

  <!-- HEADER -->
  <tr><td style="background-color:#0a1628;padding:0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td style="padding:6px 28px;border-bottom:1px solid rgba(201,168,76,0.2);">
        <p style="margin:0;font-family:Arial,sans-serif;font-size:9px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:rgba(255,255,255,0.45);">Kingdom of Bahrain &nbsp;·&nbsp; Official Government Communication</p>
      </td></tr>
      <tr><td style="padding:28px 28px 24px;">
        <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:600;color:#ffffff;line-height:1.2;">Nationality, Passport &amp;<br>Residence Affairs</h1>
        <p style="margin:5px 0 0;font-family:Arial,sans-serif;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.38);">Immigration Medical Clearance — Official Correspondence</p>
      </td></tr>
      <tr><td style="height:3px;background:linear-gradient(90deg,transparent,#c9a84c,#e8d49a,#c9a84c,transparent);font-size:0;line-height:0;">&nbsp;</td></tr>
    </table>
  </td></tr>

  <!-- REFERENCE ROW -->
  <tr><td style="background-color:#faf7f2;border-bottom:1px solid #e8e2d8;padding:12px 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td>
          <p style="margin:0;font-family:Arial,sans-serif;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#9a8f7e;">Reference</p>
          <p style="margin:3px 0 0;font-family:'Courier New',Courier,monospace;font-size:12px;font-weight:600;color:#0a1628;letter-spacing:0.08em;">NPRA/IMC/LOI/{{YEAR}}/{{REF_NUMBER}}</p>
        </td>
        <td style="text-align:right;">
          <p style="margin:0;font-family:Arial,sans-serif;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#9a8f7e;">Date</p>
          <p style="margin:3px 0 0;font-family:Arial,sans-serif;font-size:12px;color:#0a1628;font-weight:500;">{{DATE}}</p>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- BODY -->
  <tr><td style="padding:32px 28px 0;">

    <p style="margin:0 0 20px;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#0a1628;line-height:1.6;">Dear <strong>{{FULL_NAME}}</strong>,</p>

    <p style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#3a4a5c;line-height:1.75;">
      Thank you for submitting your Letter of Intent to the Immigration Health Coordination Office of the Nationality, Passport &amp; Residence Affairs (NPRA), Kingdom of Bahrain.
    </p>
    <p style="margin:0 0 28px;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#3a4a5c;line-height:1.75;">
      Your application has been received and is currently under review. To proceed with the reservation of your medical examination, we require the following information and documents. <strong>Please arrange to provide these at your earliest convenience.</strong>
    </p>

    <!-- REQUIREMENT 1 -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;border:1px solid #e8e2d8;border-radius:4px;overflow:hidden;">
      <tr>
        <td width="48" style="background-color:#0a1628;vertical-align:top;padding:16px 0;text-align:center;">
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:13px;font-weight:700;color:#c9a84c;">01</p>
        </td>
        <td style="padding:14px 18px;vertical-align:top;">
          <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#0a1628;">Entry Permit Reference Number (EPR Number)</p>
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#5a6a7c;line-height:1.6;">
            Please provide your Entry Permit Reference Number as issued by the Bahrain immigration system. <strong>If you do not already have this number, kindly request it from your sponsor or employer</strong> — they are required to enrol your Entry Permit through the official NPRA channels to obtain this reference.
          </p>
        </td>
      </tr>
    </table>

    <!-- REQUIREMENT 2 -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;border:1px solid #e8e2d8;border-radius:4px;overflow:hidden;">
      <tr>
        <td width="48" style="background-color:#0a1628;vertical-align:top;padding:16px 0;text-align:center;">
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:13px;font-weight:700;color:#c9a84c;">02</p>
        </td>
        <td style="padding:14px 18px;vertical-align:top;">
          <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#0a1628;">Passport Copy (Bio-data Page)</p>
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#5a6a7c;line-height:1.6;">
            Please submit a clear, high-resolution scan of the bio-data page of your valid travel document. Ensure all four corners are visible and the image is not obscured or cropped.
          </p>
        </td>
      </tr>
    </table>

    <!-- REQUIREMENT 3 -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;border:1px solid #e8e2d8;border-radius:4px;overflow:hidden;">
      <tr>
        <td width="48" style="background-color:#0a1628;vertical-align:top;padding:16px 0;text-align:center;">
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:13px;font-weight:700;color:#c9a84c;">03</p>
        </td>
        <td style="padding:14px 18px;vertical-align:top;">
          <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#0a1628;">Country of Departure / Country of Medical Examination</p>
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#5a6a7c;line-height:1.6;">
            Please confirm the country from which you will be departing to Bahrain. This is required to identify and assign your nearest NPRA-approved medical examination facility. Your IMC examination will be conducted in this country prior to your travel.
          </p>
        </td>
      </tr>
    </table>

    <!-- REQUIREMENT 4 -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;border:1px solid #e8e2d8;border-radius:4px;overflow:hidden;">
      <tr>
        <td width="48" style="background-color:#0a1628;vertical-align:top;padding:16px 0;text-align:center;">
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:13px;font-weight:700;color:#c9a84c;">04</p>
        </td>
        <td style="padding:14px 18px;vertical-align:top;">
          <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#0a1628;">Sponsor Airline</p>
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#5a6a7c;line-height:1.6;">
            Please provide the name of your sponsor airline. <strong>This is particularly important where no NPRA-approved medical facility is available in your country of departure</strong> — alternative arrangements will be coordinated through your sponsor airline.
          </p>
        </td>
      </tr>
    </table>

    <!-- REQUIREMENT 5 -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;border:1px solid #e8e2d8;border-radius:4px;overflow:hidden;">
      <tr>
        <td width="48" style="background-color:#0a1628;vertical-align:top;padding:16px 0;text-align:center;">
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:13px;font-weight:700;color:#c9a84c;">05</p>
        </td>
        <td style="padding:14px 18px;vertical-align:top;">
          <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#0a1628;">Employer / Sponsor Confirmation Letter</p>
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#5a6a7c;line-height:1.6;">
            A signed letter on official letterhead from your employer or sponsoring organisation in Bahrain, confirming your role and authorising your IMC application.
          </p>
        </td>
      </tr>
    </table>

    <!-- HOW TO RESPOND -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;background-color:#faf7f2;border:1px solid #e8e2d8;border-left:3px solid #c9a84c;border-radius:0 4px 4px 0;">
      <tr><td style="padding:16px 18px;">
        <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8a7a5e;">How to Submit</p>
        <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#3a4a5c;line-height:1.7;">
          Please reply to this email with the above information and attach all relevant documents. Alternatively, send to
          <a href="mailto:booking@npra.gov.bh" style="color:#0a1628;font-weight:600;text-decoration:none;border-bottom:1px solid #c9a84c;">booking@npra.gov.bh</a>.
          Please quote your passport number <strong>{{PASSPORT_NUMBER}}</strong> in the subject line of all correspondence and ensure that your sponsor email address is correctly placed in cc.
        </p>
      </td></tr>
    </table>

    <p style="margin:0 0 28px;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#3a4a5c;line-height:1.75;">
      Once we receive all required information, we will commence the reservation process of your <strong>Medical Examination</strong> promptly within <strong>24 hours</strong>.
    </p>

    <p style="margin:0 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#3a4a5c;">Yours sincerely,</p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:32px;">
      <tr><td style="border-left:3px solid #c9a84c;padding-left:16px;">
        <p style="margin:0 0 2px;font-family:Georgia,'Times New Roman',serif;font-size:14px;font-weight:600;color:#0a1628;">Immigration Health Coordination Office</p>
        <p style="margin:0 0 2px;font-family:Arial,sans-serif;font-size:11px;color:#6a7a8c;">Nationality, Passport &amp; Residence Affairs (NPRA)</p>
        <p style="margin:0 0 2px;font-family:Arial,sans-serif;font-size:11px;color:#6a7a8c;">Kingdom of Bahrain</p>
        <p style="margin:6px 0 0;"><a href="mailto:booking@npra.gov.bh" style="font-family:Arial,sans-serif;font-size:11px;color:#0a1628;text-decoration:none;font-weight:500;">booking@npra.gov.bh</a></p>
      </td></tr>
    </table>

  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background-color:#0a1628;padding:18px 28px;">
    <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:9px;color:rgba(255,255,255,0.28);line-height:1.6;">© Kingdom of Bahrain · Nationality, Passport &amp; Residence Affairs (NPRA)</p>
    <p style="margin:0;font-family:Arial,sans-serif;font-size:9px;color:rgba(255,255,255,0.2);line-height:1.6;">This is an official government communication. All correspondence should be directed to <a href="mailto:booking@npra.gov.bh" style="color:rgba(255,255,255,0.35);text-decoration:none;">booking@npra.gov.bh</a>.</p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

module.exports = router;