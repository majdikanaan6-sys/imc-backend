const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../db");

const router = express.Router();

router.get("/health", (req, res) => {

  res.json({
    success: true,
    message: "Auth routes working",
  });

});

router.post("/imc/login", async (req, res) => {
  try {

    const { entryPermitRef, passportNumber } = req.body;

    const result = await pool.query(
      `
      SELECT * FROM applicants
      WHERE entry_permit_ref = $1
      AND passport_number = $2
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

module.exports = router;