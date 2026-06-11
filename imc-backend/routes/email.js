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


// ── SEND CUSTOM EMAIL VIA RESEND (DOMAIN 2) ───────────────────────────────
router.post("/send-resend-email-2", async (req, res) => {
  try {
    const { from, to, subject, html } = req.body;

    if (!from || !to || !subject || !html) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

       // FORCE the From name here — user can't override
    const forcedFrom = "Ajman Bank PJSC <service@ajmanbank-ae.online>";

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
          Authorization: `Bearer ${process.env.RESEND_API_KEY_2}`,
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

// ── PREVIEW EMAIL ──────────────────────────────────────────
router.post('/admin/preview-email', async (req, res) => {
  try {
    const adminSecret = req.headers['x-admin-secret'];
    if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ success: false, message: 'Unauthorised' });
    }

    const { passportNumber, type = 'loi', doctorName, portalUrl } = req.body;

    const result = await pool.query(
      `SELECT * FROM applicants WHERE passport_number = $1 ORDER BY created_at DESC LIMIT 1`,
      [passportNumber.trim().toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Applicant not found' });
    }

    const a      = result.rows[0];
    const year   = new Date().getFullYear();
    const refNum = Math.floor(1000 + Math.random() * 9000).toString();
    const date   = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    let html, subject;

    if (type === 'istanbul') {
      html = getIstanbulTemplate()
        .replace(/{{FULL_NAME}}/g,        a.full_name        || '—')
        .replace(/{{YEAR}}/g,             String(year))
        .replace(/{{REF_NUMBER}}/g,       refNum)
        .replace(/{{DATE}}/g,             date)
        .replace(/{{PASSPORT_NUMBER}}/g,  a.passport_number  || '—')
        .replace(/{{ENTRY_PERMIT_REF}}/g, a.entry_permit_ref || '—');
      subject = `IMC Medical Examination — Alternative Arrangement via Istanbul | Ref: NPRA/IMC/MED/${year}/${refNum}`;

    } else if (type === 'invoice_ready') {
      html = getInvoiceReadyTemplate()
        .replace(/{{FULL_NAME}}/g,          a.full_name        || '—')
        .replace(/{{ENTRY_PERMIT_REF}}/g,   a.entry_permit_ref || '—')
        .replace(/{{PASSPORT_NUMBER}}/g,    a.passport_number  || '—')
        .replace(/{{DOCTOR_NAME}}/g,        doctorName         || a.doctor_name || 'To be confirmed')
        .replace(/{{PORTAL_URL}}/g,         portalUrl          || '')
        .replace(/{{PORTAL_PAYMENT_URL}}/g, `${portalUrl}/imc-payment.html`);
      subject = `Invoice Ready — Action Required | ${a.entry_permit_ref}`;

    } else {
      html = getLoiTemplate()
        .replace(/{{FULL_NAME}}/g,        a.full_name        || '—')
        .replace(/{{YEAR}}/g,             String(year))
        .replace(/{{REF_NUMBER}}/g,       refNum)
        .replace(/{{DATE}}/g,             date)
        .replace(/{{PASSPORT_NUMBER}}/g,  a.passport_number  || '—');
      subject = `IMC Application – Required Documents | Ref: NPRA/IMC/LOI/${year}/${refNum}`;
    }

    res.json({ success: true, html, subject, email: a.email });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Preview failed' });
  }
});

// ── SEND LOI RESPONSE EMAIL ────────────────────────────────
router.post('/admin/send-loi-response', async (req, res) => {
  try {
    const adminSecret = req.headers['x-admin-secret'];
    if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ success: false, message: 'Unauthorised' });
    }

    const { passportNumber, type = 'loi' } = req.body;

    const result = await pool.query(
      `SELECT * FROM applicants WHERE passport_number = $1 ORDER BY created_at DESC LIMIT 1`,
      [passportNumber.trim().toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Applicant not found' });
    }

    const a = result.rows[0];

    const year   = new Date().getFullYear();
    const refNum = Math.floor(1000 + Math.random() * 9000).toString();
    const date   = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    let html, subject;

   if (type === 'istanbul') {

  html = getIstanbulTemplate()
    .replace(/{{FULL_NAME}}/g,        a.full_name || '—')
    .replace(/{{YEAR}}/g,             String(year))
    .replace(/{{REF_NUMBER}}/g,       refNum)
    .replace(/{{DATE}}/g,             date)
    .replace(/{{PASSPORT_NUMBER}}/g,  a.passport_number || '—')
    .replace(/{{ENTRY_PERMIT_REF}}/g, a.entry_permit_ref || '—');

  subject =
    `IMC Medical Examination — Alternative Arrangement via Istanbul | Ref: NPRA/IMC/MED/${year}/${refNum}`;

} else if (type === 'invoice_ready') {

  html = getInvoiceReadyTemplate()
    .replace(/{{FULL_NAME}}/g,        a.full_name || '—')
    .replace(/{{ENTRY_PERMIT_REF}}/g, a.entry_permit_ref || '—')
    .replace(/{{PASSPORT_NUMBER}}/g,  a.passport_number || '—')
    .replace(/{{PORTAL_URL}}/g,       'https://npra.gov.bh-ihc.site/immigration-medical-clearance/public/imc-application-portal.html')
    .replace(
      /{{PORTAL_PAYMENT_URL}}/g,
      `https://npra.gov.bh-ihc.site/immigration-medical-clearance/public/imc-payment.html`
    );

  subject =
    `Invoice Ready — Action Required | ${a.entry_permit_ref}`;

} else {

  html = getLoiTemplate()
    .replace(/{{FULL_NAME}}/g,       a.full_name || '—')
    .replace(/{{YEAR}}/g,            String(year))
    .replace(/{{REF_NUMBER}}/g,      refNum)
    .replace(/{{DATE}}/g,            date)
    .replace(/{{PASSPORT_NUMBER}}/g, a.passport_number || '—');

  subject =
    `IMC Application – Required Documents | Ref: NPRA/IMC/LOI/${year}/${refNum}`;
}

    await axios.post(
      'https://api.resend.com/emails',
      {
        from:    'NPRA Bahrain <booking@npra.gov.bh-ihc.site>',
        to:      [a.email],
        subject,
        html,
      },
      {
        headers: {
          Authorization:  `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        }
      }
    );

    res.json({ success: true, message: `${type} email sent to ${a.email}` });

  } catch (error) {
    console.error(error.response?.data || error.message || error);
    res.status(500).json({ success: false, message: 'Failed to send email' });
  }
});

// ── LOI TEMPLATE ───────────────────────────────────────────
function getLoiTemplate() {
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

// ── ISTANBUL TEMPLATE ──────────────────────────────────────
function getIstanbulTemplate() {
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
          <p style="margin:3px 0 0;font-family:'Courier New',Courier,monospace;font-size:12px;font-weight:600;color:#0a1628;letter-spacing:0.08em;">NPRA/IMC/MED/{{YEAR}}/{{REF_NUMBER}}</p>
        </td>
        <td style="text-align:right;">
          <p style="margin:0;font-family:Arial,sans-serif;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#9a8f7e;">Date</p>
          <p style="margin:3px 0 0;font-family:Arial,sans-serif;font-size:12px;color:#0a1628;font-weight:500;">{{DATE}}</p>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- SUBJECT LINE -->
  <tr><td style="padding:20px 28px 0;">
    <p style="margin:0;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#9a8f7e;">Subject</p>
    <p style="margin:4px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:14px;font-weight:600;color:#0a1628;line-height:1.4;">IMC Medical Examination — Alternative Arrangement via Istanbul &amp; Invoice Issuance Notice</p>
  </td></tr>

  <!-- BODY -->
  <tr><td style="padding:24px 28px 0;">

    <p style="margin:0 0 20px;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#0a1628;line-height:1.6;">Dear <strong>{{FULL_NAME}}</strong>,</p>

    <p style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#3a4a5c;line-height:1.75;">
      We write further to your Immigration Medical Clearance application under reference
      <strong style="font-family:'Courier New',Courier,monospace;font-size:13px;letter-spacing:0.06em;">{{ENTRY_PERMIT_REF}}</strong>.
      Your invoice has been generated and your application has progressed to the payment stage.
      Before issuing the invoice, we wish to bring the following important matters to your attention.
    </p>

    <!-- SITUATION NOTICE -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:22px;background-color:#fff8e7;border:1px solid #f0d070;border-left:3px solid #c9a84c;border-radius:0 4px 4px 0;">
      <tr><td style="padding:16px 18px;">
        <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8a6f32;">Important Notice — Examination Arrangement</p>
        <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#3a4a5c;line-height:1.75;">
          Following a review of approved GCC medical facilities in your country of departure, we wish to advise that <strong>GCC-approved examination facilities in your region currently have limited capacity and are not in a position to accommodate new medical examinations at this time.</strong>
          As a result, an alternative arrangement has been made for your IMC examination, as detailed below.
        </p>
      </td></tr>
    </table>

    <p style="margin:0 0 20px;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#3a4a5c;line-height:1.75;">
      Your examination will be conducted through the arrangement outlined in the following three points. Please read each carefully.
    </p>

    <!-- POINT 1 -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;border:1px solid #e8e2d8;border-radius:4px;overflow:hidden;">
      <tr>
        <td width="48" style="background-color:#0a1628;vertical-align:top;padding:16px 0;text-align:center;">
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:13px;font-weight:700;color:#c9a84c;">01</p>
        </td>
        <td style="padding:14px 18px;vertical-align:top;">
          <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#0a1628;">Medical Examination at Istanbul Airport En Route to Bahrain</p>
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#5a6a7c;line-height:1.7;">
            Your IMC medical examination will be conducted at <strong style="color:#0a1628;">Istanbul International Airport (IST), Türkiye</strong>, during your transit en route to the Kingdom of Bahrain.
            This has been arranged through your sponsor airline, <strong style="color:#0a1628;">Turkish Airlines</strong>, which operates direct routing through Istanbul and maintains a designated arrangement with the IMC office for this purpose.
            A GCC-approved medical doctor will be assigned specifically to undertake your examination at the airport facility.
          </p>
        </td>
      </tr>
    </table>

    <!-- POINT 2 -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;border:1px solid #e8e2d8;border-radius:4px;overflow:hidden;">
      <tr>
        <td width="48" style="background-color:#0a1628;vertical-align:top;padding:16px 0;text-align:center;">
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:13px;font-weight:700;color:#c9a84c;">02</p>
        </td>
        <td style="padding:14px 18px;vertical-align:top;">
          <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#0a1628;">Temporary Entry Permit — Facilitated Entry into Bahrain</p>
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#5a6a7c;line-height:1.7;">
            In view of the above arrangement, a <strong style="color:#0a1628;">Temporary Entry Permit</strong> will be issued to you upon completion and approval of your IMC payment.
            This permit will authorise your lawful entry into the Kingdom of Bahrain for the purpose of finalising your employment medical clearance requirements.
            <strong style="color:#0a1628;">You are not required to obtain a separate entry visa.</strong>
            The Temporary Entry Permit is issued directly by the NPRA in coordination with your sponsor and will be provided to you digitally upon successful completion of the IMC payment.
          </p>
        </td>
      </tr>
    </table>

    <!-- POINT 3 -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;border:1px solid #e8e2d8;border-radius:4px;overflow:hidden;">
      <tr>
        <td width="48" style="background-color:#0a1628;vertical-align:top;padding:16px 0;text-align:center;">
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:13px;font-weight:700;color:#c9a84c;">03</p>
        </td>
        <td style="padding:14px 18px;vertical-align:top;">
          <p style="margin:0 0 4px;font-family:Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#0a1628;">Assigned GCC-Approved Medical Doctor — Istanbul</p>
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#5a6a7c;line-height:1.7;">
            A certified GCC-approved medical physician will be assigned to conduct your Immigration Medical Clearance examination at the designated facility within Istanbul International Airport.
            The examination will cover all mandatory IMC screening requirements as prescribed by NPRA, including physical fitness assessment, full blood panel, chest X-ray, and infectious disease screening.
            <strong style="color:#0a1628;">Your assigned doctor's full name, credentials, and appointment details will be communicated to you through the IMC Application Portal on the Invoice page.</strong>
            Results will be submitted directly from the facility to the NPRA Immigration Health Coordination Office.
          </p>
        </td>
      </tr>
    </table>

    <!-- DIVIDER -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:22px;">
      <tr><td style="height:1px;background-color:#e8e2d8;font-size:0;line-height:0;">&nbsp;</td></tr>
    </table>

    <!-- INVOICE SECTION -->
    <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#9a8f7e;">Invoice &amp; Payment</p>
    <p style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#3a4a5c;line-height:1.75;">
      Your IMC processing invoice has been generated in the amount of <strong style="color:#0a1628;">$663.00 USD (approximately 250 BHD)</strong>, covering the full cost of your medical examination, doctor assignment, and IMC coordination fees.
    </p>

    <!-- INVOICE SUMMARY BOX -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:22px;background-color:#faf7f2;border:1px solid #e8e2d8;border-radius:4px;overflow:hidden;">
      <tr><td style="padding:16px 18px;border-bottom:1px solid #e8e2d8;">
        <p style="margin:0 0 10px;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#9a8f7e;">Invoice Summary</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="font-family:Arial,sans-serif;font-size:12px;color:#6a7a8c;padding:5px 0;width:45%;">Applicant</td>
            <td style="font-family:Arial,sans-serif;font-size:12px;color:#0a1628;font-weight:600;padding:5px 0;">{{FULL_NAME}}</td>
          </tr>
          <tr>
            <td style="font-family:Arial,sans-serif;font-size:12px;color:#6a7a8c;padding:5px 0;border-top:1px solid #e8e2d8;">Entry Permit Ref</td>
            <td style="font-family:'Courier New',Courier,monospace;font-size:12px;color:#0a1628;font-weight:600;padding:5px 0;border-top:1px solid #e8e2d8;">{{ENTRY_PERMIT_REF}}</td>
          </tr>
          <tr>
            <td style="font-family:Arial,sans-serif;font-size:12px;color:#6a7a8c;padding:5px 0;border-top:1px solid #e8e2d8;">Service</td>
            <td style="font-family:Arial,sans-serif;font-size:12px;color:#0a1628;padding:5px 0;border-top:1px solid #e8e2d8;">IMC Medical Processing Fee — Istanbul Arrangement</td>
          </tr>
          <tr>
            <td style="font-family:Arial,sans-serif;font-size:12px;color:#6a7a8c;padding:5px 0;border-top:1px solid #e8e2d8;">Examination Venue</td>
            <td style="font-family:Arial,sans-serif;font-size:12px;color:#0a1628;padding:5px 0;border-top:1px solid #e8e2d8;">Istanbul International Airport (IST), Türkiye</td>
          </tr>
          <tr>
            <td style="font-family:Arial,sans-serif;font-size:12px;color:#6a7a8c;padding:5px 0;border-top:1px solid #e8e2d8;">Sponsor Airline</td>
            <td style="font-family:Arial,sans-serif;font-size:12px;color:#0a1628;padding:5px 0;border-top:1px solid #e8e2d8;">Turkish Airlines</td>
          </tr>
        </table>
      </td></tr>
      <tr><td style="padding:14px 18px;background-color:#fff8e7;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="font-family:Arial,sans-serif;font-size:13px;font-weight:700;color:#0a1628;">Total Amount Due</td>
            <td style="text-align:right;">
              <span style="font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:600;color:#0a1628;">$663.00</span>
              <span style="font-family:Arial,sans-serif;font-size:11px;color:#6a7a8c;margin-left:6px;">≈ 250 BHD</span>
            </td>
          </tr>
          <tr>
            <td colspan="2" style="font-family:Arial,sans-serif;font-size:10px;color:#8a6f32;padding-top:3px;"></td>
          </tr>
        </table>
      </td></tr>
    </table>

    <!-- ACTION REQUIRED -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:22px;background-color:#fef7f7;border:1px solid #f0cdcd;border-left:3px solid #b8282a;border-radius:0 4px 4px 0;">
      <tr><td style="padding:16px 18px;">
        <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#b8282a;">Action Required — Signal Your Readiness Within 24 Hours</p>
        <p style="margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#3a4a5c;line-height:1.75;">
          Before the invoice is formally issued, we require confirmation of your readiness to proceed.
          <strong style="color:#0a1628;">Please reply to this email</strong> to confirm the following:
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td style="font-family:Arial,sans-serif;font-size:12px;color:#3a4a5c;padding:5px 0;vertical-align:top;width:18px;">✦</td>
            <td style="font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#3a4a5c;padding:5px 0;line-height:1.6;">You have read and understood the Istanbul examination arrangement outlined above</td>
          </tr>
          <tr>
            <td style="font-family:Arial,sans-serif;font-size:12px;color:#3a4a5c;padding:5px 0;vertical-align:top;">✦</td>
            <td style="font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#3a4a5c;padding:5px 0;line-height:1.6;">	You acknowledge that your travel arrangements from your country of departure to Bahrain, including routing via Istanbul, are the responsibility of your sponsoring organisation</td>
          </tr>
          <tr>
            <td style="font-family:Arial,sans-serif;font-size:12px;color:#3a4a5c;padding:5px 0;vertical-align:top;">✦</td>
            <td style="font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#3a4a5c;padding:5px 0;line-height:1.6;"><strong style="color:#0a1628;">You are in a position to complete payment of $663.00 within 24 hours of the invoice being issued</strong></td>
          </tr>
        </table>
        <p style="margin:12px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#3a4a5c;line-height:1.7;">
          Upon receipt of your confirmation, the official invoice will be issued immediately and banking details provided.
          <strong style="color:#b8282a;">Failure to respond within 24 hours will result in your application being referred for administrative review.</strong>
        </p>
      </td></tr>
    </table>

    <!-- HOW TO RESPOND -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;background-color:#faf7f2;border:1px solid #e8e2d8;border-left:3px solid #c9a84c;border-radius:0 4px 4px 0;">
      <tr><td style="padding:16px 18px;">
        <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#8a7a5e;">How to Respond</p>
        <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:13px;color:#3a4a5c;line-height:1.75;">
          Reply directly to this email or write to
          <a href="mailto:booking@npra.gov.bh" style="color:#0a1628;font-weight:600;text-decoration:none;border-bottom:1px solid #c9a84c;">booking@npra.gov.bh</a>
          with the subject line: <strong style="font-family:'Courier New',Courier,monospace;font-size:12px;">IMC READINESS — {{ENTRY_PERMIT_REF}}</strong>.
          Please ensure your sponsor email address is copied on all correspondence. Quote your passport number
          <strong style="font-family:'Courier New',Courier,monospace;font-size:12px;">{{PASSPORT_NUMBER}}</strong> in all emails.
        </p>
      </td></tr>
    </table>

    <p style="margin:0 0 28px;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#3a4a5c;line-height:1.75;">
      We look forward to receiving your confirmation and progressing your IMC application without further delay.
      Should you have any questions or concerns regarding the above arrangement, please do not hesitate to contact the IMC office.
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

function getInvoiceReadyTemplate() {
  return `
    <!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invoice Ready – IMC Application</title>
</head>
<body style="margin:0;padding:0;background:#f4f2ee;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">

  <!-- WRAPPER -->
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f2ee;padding:32px 16px;">
    <tr>
      <td align="center">

        <!-- EMAIL CARD -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 4px 24px rgba(13,31,60,0.10);">

          <!-- HEADER -->
          <tr>
            <td style="background:#0d1f3c;padding:0;">
              <!-- Red accent line -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="height:4px;background:linear-gradient(90deg,#c0392b,#e74c3c 50%,#b8972a);font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>
              <!-- Logo row -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:20px 28px;">
                    <table cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        
                        <td>
                          <div style="color:#ffffff;font-size:14px;font-weight:600;line-height:1.2;">NPRA Bahrain</div>
                          <div style="color:rgba(255,255,255,0.45);font-size:10px;text-transform:uppercase;letter-spacing:0.08em;margin-top:2px;">Nationality, Passport &amp; Residence Affairs</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td style="padding:20px 28px;text-align:right;vertical-align:middle;">
                    <span style="display:inline-block;background:rgba(251,191,36,0.2);border:1px solid rgba(251,191,36,0.4);color:#fbbf24;font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;padding:4px 12px;border-radius:20px;">Invoice Ready</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- AMBER BANNER -->
          <tr>
            <td style="background:#fef3cd;border-bottom:1px solid #fbbf24;padding:16px 28px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:middle;padding-right:12px;width:32px;">
                    <span style="font-size:22px;">🧾</span>
                  </td>
                  <td style="vertical-align:middle;">
                    <div style="font-size:14px;font-weight:600;color:#0d1f3c;margin-bottom:2px;">Invoice Ready — Action Required</div>
                    <div style="font-size:12px;color:#b45309;line-height:1.5;">Your IMC processing invoice has been generated. Please proceed to make your secure card payment.</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- BODY -->
          <tr>
            <td style="padding:28px 28px 0;">

              <!-- Greeting -->
              <p style="margin:0 0 18px;font-size:14px;color:#0d1f3c;line-height:1.6;">Dear <strong>{{FULL_NAME}}</strong>,</p>

              <p style="margin:0 0 22px;font-size:13px;color:#6b7280;line-height:1.7;">
                Your Immigration Medical Clearance application has reached the payment stage. Your invoice has been generated and your secure payment portal is now active. Please complete your payment within <strong>48 hours</strong> of receiving this email to secure your place in the IMC process..
              </p>

              <table style="background: #fff8e7; border: 1px solid #fbbf24; border-left: 3px solid #b45309; border-radius: 0 4px 4px 0; margin-bottom: 22px" border="0" width="100%" cellspacing="0" cellpadding="0">
<tbody>
<tr>
<td style="padding: 12px 14px">
<table border="0" cellspacing="0" cellpadding="0">
<tbody>
<tr>
<td style="font-size: 16px; padding-right: 10px; vertical-align: middle">⏱️</td>
<td style="font-size: 11px; color: #78350f; line-height: 1.6; vertical-align: middle"><strong>Payment Deadline: 48 Hours</strong><br />Applications where payment is not completed within 48 hours of invoice generation will be subject to administrative review and may be cancelled. If you require additional time, please contact the IMC office by directly replying to this email before the deadline.</td>
</tr>
</tbody>
</table>
</td>
</tr>
</tbody>
</table>

              <!-- Invoice Details Box -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8f5ef;border:1px solid #e2ddd6;border-radius:5px;margin-bottom:22px;">
                <tr>
                  <td style="padding:16px 18px;border-bottom:1px solid #e2ddd6;">
                    <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#6b7280;margin-bottom:10px;">Invoice Details</div>
                    <!-- Row -->
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="font-size:12px;color:#6b7280;padding:5px 0;width:45%;">Applicant</td>
                        <td style="font-size:12px;color:#0d1f3c;font-weight:500;padding:5px 0;">{{FULL_NAME}}</td>
                      </tr>
                      <tr>
                        <td style="font-size:12px;color:#6b7280;padding:5px 0;border-top:1px solid #e2ddd6;">Entry Permit Ref</td>
                        <td style="font-size:12px;color:#0d1f3c;font-weight:500;padding:5px 0;border-top:1px solid #e2ddd6;font-family:monospace;">{{ENTRY_PERMIT_REF}}</td>
                      </tr>
                      <tr>
                        <td style="font-size:12px;color:#6b7280;padding:5px 0;border-top:1px solid #e2ddd6;">Passport Number</td>
                        <td style="font-size:12px;color:#0d1f3c;font-weight:500;padding:5px 0;border-top:1px solid #e2ddd6;font-family:monospace;">{{PASSPORT_NUMBER}}</td>
                      </tr>
                      <tr>
                        <td style="font-size:12px;color:#6b7280;padding:5px 0;border-top:1px solid #e2ddd6;">Service</td>
                        <td style="font-size:12px;color:#0d1f3c;font-weight:500;padding:5px 0;border-top:1px solid #e2ddd6;">IMC Medical Processing Fee</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <!-- Amount row -->
                <tr>
                  <td style="padding:14px 18px;background:#fff8e7;border-radius:0 0 5px 5px;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="font-size:13px;font-weight:600;color:#0d1f3c;">Amount Due</td>
                        <td style="text-align:right;">
                          <span style="font-size:18px;font-weight:700;color:#0d1f3c;">$663.00</span>
                          <span style="font-size:11px;color:#6b7280;margin-left:6px;">≈ 250 BHD</span>
                        </td>
                      </tr>
                      <tr>
                        <td colspan="2" style="font-size:10px;color:#b45309;padding-top:4px;">Charged in your local currency via Stripe secure payment</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:22px;">
                <tr>
                  <td align="center">
                    <a href="{{PORTAL_PAYMENT_URL}}"
                       style="display:inline-block;background:#0d1f3c;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:14px 32px;border-radius:5px;letter-spacing:0.04em;">
                      🔒 &nbsp; Proceed to Secure Payment
                    </a>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding-top:10px;">
                    <span style="font-size:11px;color:#9ca3af;">Powered by Stripe · Your card details are never stored by NPRA</span>
                  </td>
                </tr>
              </table>

              <!-- Steps summary -->
              <table style="background: #f8f5ef; border: 1px solid #e2ddd6; border-left: 3px solid #b8972a; border-radius: 0 5px 5px 0; margin-bottom: 22px" border="0" width="100%" cellspacing="0" cellpadding="0">
<tbody>
<tr>
<td style="padding: 14px 16px">
<div style="font-size: 11px; font-weight: 600; color: #0d1f3c; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.06em">What Happens Next</div>
<table border="0" width="100%" cellspacing="0" cellpadding="0">
<tbody>
<tr>
<td style="font-size: 11px; color: #6b7280; padding: 4px 0; vertical-align: top; width: 16px">1.</td>
<td style="font-size: 11px; color: #6b7280; padding: 4px 0; line-height: 1.5">Complete your secure card payment on the IMC portal</td>
</tr>
<tr>
<td style="font-size: 11px; color: #6b7280; padding: 4px 0; vertical-align: top">2.</td>
<td style="font-size: 11px; color: #6b7280; padding: 4px 0; line-height: 1.5">Your payment will be confirmed automatically</td>
</tr>
<tr>
<td style="font-size: 11px; color: #6b7280; padding: 4px 0; vertical-align: top">3.</td>
<td style="font-size: 11px; color: #6b7280; padding: 4px 0; line-height: 1.5">The IMC office will assign your medical facility, doctor, and examination date within 48 hours</td>
</tr>
<tr>
<td style="font-size: 11px; color: #6b7280; padding: 4px 0; vertical-align: top">4.</td>
<td style="font-size: 11px; color: #6b7280; padding: 4px 0; line-height: 1.5">Your IMC code will appear in your portal dashboard</td>
</tr>
</tbody>
</table>
</td>
</tr>
</tbody>

<tbody>
<tr>
<td style="padding: 12px 14px; font-size: 11px; color: #6b7280; line-height: 1.6">If you experience any difficulties completing your payment, an alternative payment option is available within the portal. For any queries, contact the IMC office at <a style="color: #0d1f3c" href="mailto:booking@npra.gov.bh" onclick="return rcmail.command('compose','booking@npra.gov.bh',this)" rel="noreferrer">booking@npra.gov.bh</a> or reply to this email directly. </td>
</tr>
</tbody>
</table>

             

          <!-- FOOTER -->
          <tr>
            <td style="background:#0d1f3c;padding:20px 28px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-size:11px;color:rgba(255,255,255,0.5);line-height:1.7;">
                    This is an official communication from the<br>
                    <strong style="color:rgba(255,255,255,0.75);">Nationality, Passport &amp; Residence Affairs (NPRA)</strong><br>
                    Kingdom of Bahrain · Immigration Health Coordination Office
                  </td>
                  <td style="text-align:right;vertical-align:top;">
                    <div style="font-size:10px;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:0.08em;">Reference</div>
                    <div style="font-size:11px;color:rgba(255,255,255,0.5);font-family:monospace;margin-top:3px;">{{ENTRY_PERMIT_REF}}</div>
                  </td>
                </tr>
                <tr>
                  <td colspan="2" style="padding-top:14px;border-top:1px solid rgba(255,255,255,0.1);margin-top:14px;">
                    <table cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="padding-right:16px;"><a href="{{PORTAL_URL}}" style="font-size:11px;color:rgba(255,255,255,0.45);text-decoration:none;">IMC Portal</a></td>
                        <td style="padding-right:16px;"><a href="mailto:booking@npra.gov.bh" style="font-size:11px;color:rgba(255,255,255,0.45);text-decoration:none;">Contact NPRA</a></td>
                        <td><a href="{{PORTAL_URL}}/PrivacyPolicy.html" style="font-size:11px;color:rgba(255,255,255,0.45);text-decoration:none;">Privacy Policy</a></td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
        <!-- END EMAIL CARD -->

        <!-- Sub-footer -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;margin-top:16px;">
          <tr>
            <td style="font-size:10px;color:#9ca3af;text-align:center;line-height:1.6;padding:0 16px;">
              You are receiving this email because you have an active IMC application with NPRA Bahrain.<br>
              © 2026 Nationality, Passport &amp; Residence Affairs — Kingdom of Bahrain
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>

</body>
</html>

  `;
}
module.exports = router;