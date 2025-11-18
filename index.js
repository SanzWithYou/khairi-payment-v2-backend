const express = require('express');
const { Client } = require('pg');
const multer = require('multer');
const cors = require('cors');
const { Resend } = require('resend');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Log environment variables (tanpa password)
console.log('Environment Variables:');
console.log('DB_HOST:', process.env.DB_HOST);
console.log('DB_PORT:', process.env.DB_PORT);
console.log('DB_USER:', process.env.DB_USER);
console.log('DB_NAME:', process.env.DB_NAME);
console.log('DB_SSL:', process.env.DB_SSL);
console.log('S3_BUCKET:', process.env.S3_BUCKET);

// Resend Email
const resend = new Resend(process.env.RESEND_API_KEY);

// CORS - Perbarui untuk mendukung multiple origins
const allowedOrigins = [
  'https://khairi-payment-v2.vercel.app',
  'http://localhost:4321',
  'http://localhost:3000',
];

app.use(
  cors({
    origin: function (origin, callback) {
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

// PostgreSQL Client dengan retry logic
let db;
let dbConnectionRetries = 0;
const maxDbRetries = 5;

async function connectDb() {
  try {
    db = new Client({
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME,
      ssl:
        process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });

    await db.connect();
    console.log('✅ Connected to PostgreSQL database');

    // Create table if not exists
    await db.query(`
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
    console.log('✅ Payments table ready');

    dbConnectionRetries = 0; // Reset counter on successful connection
  } catch (err) {
    console.error('❌ Database connection error:', err.message);
    dbConnectionRetries++;

    if (dbConnectionRetries < maxDbRetries) {
      console.log(
        `Retrying database connection in 5 seconds... (${dbConnectionRetries}/${maxDbRetries})`
      );
      setTimeout(connectDb, 5000);
    } else {
      console.error('❌ Max database connection retries reached. Exiting...');
      process.exit(1);
    }
  }
}

// Initial database connection
connectDb();

// S3 / Leapcell Object Storage
const s3 = new S3Client({
  region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_KEY_ID,
    secretAccessKey: process.env.S3_KEY_SECRET,
  },
  forcePathStyle: true,
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
    console.error('Upload payment error:', err);
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
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Allowed CORS origins: ${allowedOrigins.join(', ')}`);
});
