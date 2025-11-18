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

// Email Function dengan template HTML yang lebih lengkap
async function sendPaymentNotificationEmail(paymentData) {
  const { name, phone_number, payment_method, reason, proofUrl, id } =
    paymentData;

  const emailContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body {
          font-family: Arial, sans-serif;
          line-height: 1.6;
          color: #333;
          max-width: 600px;
          margin: 0 auto;
          padding: 20px;
        }
        .header {
          background-color: #4f46e5;
          color: white;
          padding: 20px;
          text-align: center;
          border-radius: 5px 5px 0 0;
        }
        .content {
          background-color: #f9fafb;
          padding: 20px;
          border: 1px solid #e5e7eb;
          border-radius: 0 0 5px 5px;
        }
        .detail-row {
          display: flex;
          justify-content: space-between;
          margin-bottom: 10px;
          padding-bottom: 10px;
          border-bottom: 1px solid #e5e7eb;
        }
        .detail-label {
          font-weight: bold;
          color: #4b5563;
        }
        .detail-value {
          color: #1f2937;
        }
        .proof-link {
          display: inline-block;
          background-color: #4f46e5;
          color: white;
          padding: 10px 15px;
          text-decoration: none;
          border-radius: 4px;
          margin-top: 15px;
        }
        .footer {
          margin-top: 20px;
          font-size: 12px;
          color: #6b7280;
          text-align: center;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Pembayaran Baru Diterima</h1>
      </div>
      <div class="content">
        <p>Ada pembayaran baru yang telah diupload oleh pelanggan. Berikut detailnya:</p>

        <div class="detail-row">
          <span class="detail-label">ID Pembayaran:</span>
          <span class="detail-value">#${id}</span>
        </div>

        <div class="detail-row">
          <span class="detail-label">Nama Pelanggan:</span>
          <span class="detail-value">${name}</span>
        </div>

        <div class="detail-row">
          <span class="detail-label">Nomor WhatsApp:</span>
          <span class="detail-value">${phone_number}</span>
        </div>

        <div class="detail-row">
          <span class="detail-label">Metode Pembayaran:</span>
          <span class="detail-value">${payment_method}</span>
        </div>

        <div class="detail-row">
          <span class="detail-label">Alasan Pembayaran:</span>
          <span class="detail-value">${reason}</span>
        </div>

        <div class="detail-row">
          <span class="detail-label">Waktu:</span>
          <span class="detail-value">${new Date().toLocaleString(
            'id-ID'
          )}</span>
        </div>

        <p><strong>Bukti Pembayaran:</strong></p>
        <a href="${proofUrl}" class="proof-link">Lihat Bukti Pembayaran</a>

        <div class="footer">
          <p>Email ini dikirim secara otomatis oleh sistem pembayaran Khairi.</p>
          <p>Harap segera verifikasi pembayaran ini dan hubungi pelanggan jika diperlukan.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  // Send email using Resend
  const { data, error } = await resend.emails.send({
    from: 'Khairi Payment <onboarding@resend.dev>',
    to: [process.env.ADMIN_EMAIL],
    subject: `Pembayaran Baru dari ${name} - #${id}`,
    html: emailContent,
  });

  if (error) {
    throw error;
  }

  console.log('Email sent successfully:', data);
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
