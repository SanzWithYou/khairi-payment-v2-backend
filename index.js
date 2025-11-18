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

// CORS - Perbarui untuk mendukung multiple origins
const allowedOrigins = [
  process.env.CORS_ORIGIN || 'https://khairi-payment-v2.vercel.app',
  'http://localhost:4321', // Untuk development lokal
  'http://localhost:3000', // Untuk development lokal
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);

      if (allowedOrigins.indexOf(origin) !== -1) {
        return callback(null, true);
      } else {
        console.log('CORS blocked origin:', origin);
        return callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

db.connect()
  .then(() => console.log('Connected to PostgreSQL database'))
  .catch((err) => console.error('Connection error', err.stack));

// Create table if not exists
db.query(
  `
  CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    payment_method TEXT NOT NULL,
    reason TEXT NOT NULL,
    proof_url TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`
)
  .then(() => console.log('Payments table ready'))
  .catch((err) => console.error('Table creation error', err.stack));

// S3 / Leapcell Object Storage
const s3 = new S3Client({
  region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_KEY_ID,
    secretAccessKey: process.env.S3_KEY_SECRET,
  },
  forcePathStyle: true, // Penting untuk Leapcell
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
        Bucket: process.env.S3_BUCKET,
        Key: fileName,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      })
    );

    const fileUrl = `${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}/${fileName}`;

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
    console.error('Database error:', err);
    res.status(500).json({ error: 'DB error', detail: err.message });
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Check database
    await db.query('SELECT NOW()');

    // Check S3 connection
    await s3.config.credentials();

    res.json({
      status: 'OK',
      database: 'Connected',
      storage: 'Connected',
    });
  } catch (error) {
    res.status(500).json({
      status: 'Error',
      error: error.message,
    });
  }
});

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
