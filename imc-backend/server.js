require("dotenv").config();

const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const emailRoutes = require("./routes/email");
const paymentRoutes = require("./routes/payment");
const adminRoutes = require("./routes/admin");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "IMC Backend Running",
  });
});

app.use("/api", authRoutes);
app.use("/api/email", emailRoutes);
app.use('/api', paymentRoutes);
app.use('/api', adminRoutes);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});