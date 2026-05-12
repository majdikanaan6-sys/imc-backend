const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../db");

const router = express.Router();



// HEALTH CHECK

router.get("/health", (req, res) => {

  res.json({
    success: true,
    message: "Auth routes working",
  });

});



// LOGIN ROUTE

router.post("/imc/login", async (req, res) => {

  try {

    const { entryPermitRef, passportNumber } = req.body;

    const result = await pool.query(

      `
      SELECT * FROM entry_permits
      WHERE entry_permit_ref = $1
      AND passport_number = $2
      AND permit_status = 'active'
      `,

      [entryPermitRef, passportNumber]

    );

    if (result.rows.length === 0) {

      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });

    }

    const applicant = result.rows[0];

    const token = jwt.sign(

      {
        applicantId: applicant.id,
      },

      process.env.JWT_SECRET,

      {
        expiresIn: "1d",
      }

    );

    res.json({

      success: true,
      token,
      applicant,

    });

  } catch (error) {

    console.log(error);

    res.status(500).json({

      success: false,
      message: "Server error",

    });

  }

});



// ADMIN CREATE APPLICANT

router.post("/admin/create-applicant", async (req, res) => {

  try {

    const {

      full_name,
      nationality,
      date_of_birth,

      passport_number,
      passport_expiry,

      email,
      phone,

      entry_permit_ref,

      sponsor_name,

      imc_code,

      employer,

      role,

      imc_status

    } = req.body;

    const result = await pool.query(

      `
      INSERT INTO applicants (

        full_name,
        nationality,
        date_of_birth,

        passport_number,
        passport_expiry,

        email,
        phone,

        entry_permit_ref,

        sponsor_name,

        imc_code,

        employer,

        role,

        imc_status

      )

      VALUES (

        $1,$2,$3,
        $4,$5,
        $6,$7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13

      )

      RETURNING *;
      `,

      [

        full_name,
        nationality,
        date_of_birth,

        passport_number,
        passport_expiry,

        email,
        phone,

        entry_permit_ref,

        sponsor_name,

        imc_code,

        employer,

        role,

        imc_status

      ]

    );

    res.json({

      success: true,
      applicant: result.rows[0]

    });

  } catch (error) {

    console.log(error);

    res.status(500).json({

      success: false,
      error: error.message

    });

  }

});



// ADMIN CREATE ENTRY PERMIT

router.post("/admin/create-entry-permit", async (req, res) => {

  try {

    const {

      passport_number,
      nationality,

      full_name,

      sponsor_name,
      sponsor_airline,

      permit_issue_date,
      permit_expiry_date

    } = req.body;



    // STEP 1: INSERT WITHOUT REFERENCE

    const insertResult = await pool.query(

      `
      INSERT INTO entry_permits (

        passport_number,
        nationality,

        full_name,

        sponsor_name,
        sponsor_airline,

        permit_issue_date,
        permit_expiry_date

      )

      VALUES (

        $1,$2,
        $3,
        $4,$5,
        $6,$7

      )

      RETURNING *;
      `,

      [

        passport_number,
        nationality,

        full_name,

        sponsor_name,
        sponsor_airline,

        permit_issue_date,
        permit_expiry_date

      ]

    );



    const permit = insertResult.rows[0];



    // STEP 2: GENERATE ENTRY PERMIT REF

    const year = new Date().getFullYear();

const randomNumber = Math.floor(
  10000000 + Math.random() * 90000000
);

const entryPermitRef =
  `EP-${year}-${randomNumber}`;



    // STEP 3: UPDATE RECORD

    const updateResult = await pool.query(

      `
      UPDATE entry_permits
      SET entry_permit_ref = $1
      WHERE id = $2
      RETURNING *;
      `,

      [entryPermitRef, permit.id]

    );



    res.json({

      success: true,
      entryPermit: updateResult.rows[0]

    });

  } catch (error) {

    console.log(error);

    res.status(500).json({

      success: false,
      error: error.message

    });

  }

});


module.exports = router;