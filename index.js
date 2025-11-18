const express = require('express');
const { Client } = require('pg');
const multer = require('multer');
const cors = require('cors');
const { Resend } = require('resend');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Resend Email
const resend = new Resend(process.env.RESEND_API_KEY);

// CORS
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer (Memory, no filesystem)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// PostgreSQL Client
const db = new Client({
  user: process.env.MYAPP_DB_USER,
  password: process.env.MYAPP_DB_PASS,
  host: process.env.MYAPP_DB_HOST,
  port: process.env.MYAPP_DB_PORT,
  database: process.env.MYAPP_DB_NAME,
  ssl: { rejectUnauthorized: false },
});

db.connect();

// Create table if not exists
db.query(`
  CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    payment_method TEXT NOT NULL,
    reason TEXT NOT NULL,
    proof_url TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

// S3 / Leapcell Object Storage
const s3 = new S3Client({
  region: process.env.MYAPP_S3_REGION,
  endpoint: process.env.MYAPP_S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.MYAPP_S3_KEY_ID,
    secretAccessKey: process.env.MYAPP_S3_KEY_SECRET,
  },
});

// Upload Payment
app.post('/api/upload-payment', upload.single('proof'), async (req, res) => {
  try {
    const { name, phone_number, payment_method, reason } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Generate S3 filename
    const fileName = `proof_${Date.now()}_${Math.random()
      .toString(36)
      .substring(2)}.${req.file.originalname.split('.').pop()}`;

    // Upload to S3
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.MYAPP_S3_BUCKET,
        Key: fileName,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      })
    );

    const fileUrl = `${process.env.MYAPP_S3_ENDPOINT}/${process.env.MYAPP_S3_BUCKET}/${fileName}`;

    // Insert to PostgreSQL
    const insertQuery = `
      INSERT INTO payments (name, phone_number, payment_method, reason, proof_url)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id;
    `;

    const result = await db.query(insertQuery, [
      name,
      phone_number,
      payment_method,
      reason,
      fileUrl,
    ]);

    const paymentId = result.rows[0].id;

    // Send Email
    try {
      await sendPaymentNotificationEmail({
        id: paymentId,
        name,
        phone_number,
        payment_method,
        reason,
        proofUrl: fileUrl,
      });
    } catch (e) {
      console.log('Email sending failed:', e);
    }

    res.json({
      success: true,
      data: {
        id: paymentId,
        name,
        phone_number,
        payment_method,
        reason,
        proof_url: fileUrl,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

// Email Function
async function sendPaymentNotificationEmail(data) {
  await resend.emails.send({
    from: 'Payment System <onboarding@resend.dev>',
    to: process.env.ADMIN_EMAIL,
    subject: `Pembayaran Baru dari ${data.name} - #${data.id}`,
    html: `
      <h1>Pembayaran Baru</h1>
      <p><b>ID:</b> ${data.id}</p>
      <p><b>Nama:</b> ${data.name}</p>
      <p><b>No WA:</b> ${data.phone_number}</p>
      <p><b>Metode:</b> ${data.payment_method}</p>
      <p><b>Alasan:</b> ${data.reason}</p>
      <p><a href="${data.proofUrl}">Lihat Bukti Pembayaran</a></p>
    `,
  });
}

// Get All Payments
app.get('/api/payments', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM payments ORDER BY created_at DESC'
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
