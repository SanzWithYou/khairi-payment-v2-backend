const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Resend } = require('resend');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Load environment variables
require('dotenv').config();

// Initialize Resend for email notifications
const resend = new Resend(process.env.RESEND_API_KEY);

// Middleware configuration
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:4321',
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `proof_${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and WEBP are allowed.'));
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
});

// Initialize SQLite database
const db = new sqlite3.Database('./payments.db');

// Create payments table if it doesn't exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      reason TEXT NOT NULL,
      proof_url TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// API endpoint: Upload payment proof
app.post('/api/upload-payment', upload.single('proof'), async (req, res) => {
  try {
    const { name, phone_number, payment_method, reason } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    // Generate file URL
    const proofUrl = `${req.protocol}://${req.get('host')}/uploads/${
      req.file.filename
    }`;

    // Save payment data to database
    const stmt = db.prepare(`
      INSERT INTO payments (name, phone_number, payment_method, reason, proof_url)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      [name, phone_number, payment_method, reason, proofUrl],
      async function (err) {
        if (err) {
          console.error(err);
          return res.status(500).json({ error: 'Failed to save data.' });
        }

        // Send email notification
        try {
          await sendPaymentNotificationEmail({
            name,
            phone_number,
            payment_method,
            reason,
            proofUrl,
            id: this.lastID,
          });
        } catch (emailError) {
          console.error('Failed to send email:', emailError);
          // Continue even if email fails
        }

        res.status(200).json({
          success: true,
          data: {
            id: this.lastID,
            name,
            phone_number,
            payment_method,
            reason,
            proof_url: proofUrl,
          },
        });
      }
    );

    stmt.finalize();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Function: Send payment notification email
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

// Serve static files from uploads directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API endpoint: Get all payments
app.get('/api/payments', (req, res) => {
  db.all('SELECT * FROM payments ORDER BY created_at DESC', (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to fetch payments.' });
    }

    res.status(200).json({ success: true, data: rows });
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
