const express = require('express');
const Stripe = require('stripe');
const pool = require('../db');
const authenticateToken = require('../middleware/authenticateToken');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// CREATE PAYMENT INTENT
router.post('/imc/create-payment-intent', authenticateToken, async (req,res)=>{

try{

const applicantId=req.user.applicantId;

const result=await pool.query(
`
SELECT *
FROM applicants
WHERE id=$1
`,
[applicantId]
);

if(result.rows.length===0){
return res.status(404).json({
success:false,
message:'Applicant not found'
});
}

const applicant=result.rows[0];

if(applicant.imc_status!=='invoice_requested'){
return res.status(400).json({
success:false,
message:'Payment unavailable for current status'
});
}

const paymentIntent=
await stripe.paymentIntents.create({
amount:66300,
currency:'usd',
automatic_payment_methods:{enabled:true},
metadata:{
applicantId:applicant.id,
entryPermit:applicant.entry_permit_ref
}
});

res.json({
success:true,
clientSecret:paymentIntent.client_secret
});

}catch(error){
console.log(error);
res.status(500).json({
success:false,
message:'Could not create payment intent'
});
}

});

// CONFIRM PAYMENT
router.post('/imc/confirm-payment', authenticateToken, async(req,res)=>{

try{

const {paymentIntentId}=req.body;
const applicantId=req.user.applicantId;

const paymentIntent=
await stripe.paymentIntents.retrieve(paymentIntentId);

if(paymentIntent.status!=='succeeded'){
return res.status(400).json({
success:false,
message:'Payment not completed'
});
}

const result=await pool.query(
`
UPDATE applicants
SET
imc_status='payment_confirmed',
payment_reference=$1,
payment_confirmed_at=NOW()
WHERE id=$2
RETURNING *
`,
[paymentIntentId,applicantId]
);

res.json({
success:true,
applicant:result.rows[0]
});

}catch(error){
console.log(error);
res.status(500).json({
success:false,
message:'Payment confirmation failed'
});
}

});

// MANUAL INVOICE REQUEST
router.post('/imc/invoice-request', authenticateToken, async(req,res)=>{

try{

const applicantId=req.user.applicantId;

const invoiceRef=
'INV-'+Math.floor(100000+Math.random()*900000);

const result=await pool.query(
`
UPDATE applicants
SET
imc_status='payment_pending',
invoice_ref=$1
WHERE id=$2
RETURNING *
`,
[invoiceRef,applicantId]
);

res.json({
success:true,
invoiceRef,
applicant:result.rows[0]
});

}catch(error){
console.log(error);
res.status(500).json({
success:false,
message:'Could not create invoice request'
});
}

});

module.exports=router;
