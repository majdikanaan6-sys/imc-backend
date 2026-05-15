const express = require("express");
const axios = require("axios");
const pool = require("../db");

const router = express.Router();


// ======================================================
// SEND EMAIL VERIFICATION CODE
// ======================================================

router.post("/send-verification-code", async (req, res) => {

  try {

    const { email } = req.body;

    // VALIDATE EMAIL

    if (!email) {

      return res.status(400).json({

        success: false,
        message: "Email address is required"

      });

    }

    const normalizedEmail =
      email.trim().toLowerCase();

    // GENERATE 6-DIGIT CODE

    const verificationCode =
      Math.floor(
        100000 + Math.random() * 900000
      ).toString();

    // STORE / UPDATE CODE

    await pool.query(

      `
      INSERT INTO email_verifications (

        email,
        verification_code,
        created_at

      )

      VALUES (

        $1,
        $2,
        NOW()

      )

      ON CONFLICT (email)

      DO UPDATE SET

        verification_code =
          EXCLUDED.verification_code,

        created_at = NOW()
      `,

      [
        normalizedEmail,
        verificationCode
      ]

    );

    // SEND EMAIL VIA RESEND

    await axios.post(

      "https://api.resend.com/emails",

      {

        from:
          "NPRA Bahrain <booking@npra.gov.bh-ihc.site>",

        to: [
          normalizedEmail
        ],

        subject:
          "Bahrain IMC Portal – Email Verification Code",

        html: `

          <div style="
            font-family: Arial, sans-serif;
            padding: 24px;
            line-height: 1.7;
            color: #0d1f3c;
          ">

            <h2 style="
              margin-bottom: 18px;
              color: #0d1f3c;
            ">
              Bahrain Immigration Medical Clearance
            </h2>

            <p>
              Dear Applicant,
            </p>

            <p>
              Your email verification code is:
            </p>

            <div style="
              font-size: 34px;
              font-weight: bold;
              letter-spacing: 5px;
              margin: 22px 0;
              color: #0d1f3c;
            ">
              ${verificationCode}
            </div>

            <p>
              This verification code
              will expire in 10 minutes.
            </p>

            <p>
              If you did not request this verification,
              you may safely ignore this email.
            </p>

            <br>

            <p style="
              font-size: 14px;
              color: #666;
            ">
              Nationality, Passport & Residence Affairs<br>
              Kingdom of Bahrain
            </p>

          </div>

        `

      },

      {

        headers: {

          Authorization:
            `Bearer ${process.env.RESEND_API_KEY}`,

          "Content-Type":
            "application/json"

        }

      }

    );

    // SUCCESS RESPONSE

    res.json({

      success: true,
      message:
        "Verification code sent successfully"

    });

  } catch (error) {

    console.log(

      error.response?.data ||
      error.message ||
      error

    );

    res.status(500).json({

      success: false,
      message:
        "Unable to send verification code"

    });

  }

});


// ======================================================
// VERIFY EMAIL CODE
// ======================================================

router.post("/verify-code", async (req, res) => {

  try {

    const {

      email,
      code

    } = req.body;

    // VALIDATION

    if (!email || !code) {

      return res.status(400).json({

        success: false,
        message:
          "Email and code are required"

      });

    }

    const normalizedEmail =
      email.trim().toLowerCase();

    // CHECK CODE + EXPIRY

    const result = await pool.query(

      `
      SELECT *

      FROM email_verifications

      WHERE email = $1

      AND verification_code = $2

      AND created_at >
      NOW() - INTERVAL '10 minutes'
      `,

      [
        normalizedEmail,
        code
      ]

    );

    // INVALID CODE

    if (result.rows.length === 0) {

      return res.status(401).json({

        success: false,
        message:
          "Invalid or expired verification code"

      });

    }

    // SUCCESS

    res.json({

      success: true,
      message:
        "Email verified successfully"

    });

  } catch (error) {

    console.log(error);

    res.status(500).json({

      success: false,
      message:
        "Verification failed"

    });

  }

});

module.exports = router;