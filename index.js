const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const cors = require('cors');
const { Resend } = require('resend');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

// Express
const app = express();
const PORT = process.env.PORT || 3000;

// Resend Email
const resend = new Resend(process.env.RESEND_API_KEY);

// Middleware
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer — Memory Storage (NO FILESYSTEM)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Invalid file format'));
  },
});

// S3 / Leapcell Storage Client
const s3 = new S3Client({
  region: process.env.LEAPCELL_REGION,
  endpoint: process.env.LEAPCELL_ENDPOINT,
  credentials: {
    accessKeyId: process.env.LEAPCELL_ACCESS_KEY,
    secretAccessKey: process.env.LEAPCELL_SECRET_KEY,
  },
});

// SQLite
const db = new sqlite3.Database(process.env.DATABASE_PATH);

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

// Upload Payment
app.post('/api/upload-payment', upload.single('proof'), async (req, res) => {
  try {
    const { name, phone_number, payment_method, reason } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Generate file name
    const fileName = `proof_${Date.now()}_${Math.random()
      .toString(36)
      .substring(2)}.${req.file.originalname.split('.').pop()}`;

    // Upload to Leapcell
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.LEAPCELL_BUCKET,
        Key: fileName,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      })
    );

    const fileUrl = `${process.env.LEAPCELL_ENDPOINT}/${process.env.LEAPCELL_BUCKET}/${fileName}`;

    // Save to DB
    const stmt = db.prepare(
      `INSERT INTO payments (name, phone_number, payment_method, reason, proof_url)
       VALUES (?, ?, ?, ?, ?)`
    );

    stmt.run(
      [name, phone_number, payment_method, reason, fileUrl],
      async function (err) {
        if (err) return res.status(500).json({ error: 'Database error' });

        // Send Email
        try {
          await sendPaymentNotificationEmail({
            id: this.lastID,
            name,
            phone_number,
            payment_method,
            reason,
            proofUrl: fileUrl,
          });
        } catch (e) {
          console.log('Failed to send email:', e);
        }

        res.json({
          success: true,
          data: {
            id: this.lastID,
            name,
            phone_number,
            payment_method,
            reason,
            proof_url: fileUrl,
          },
        });
      }
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// EMAIL FUNCTION
async function sendPaymentNotificationEmail(data) {
  const { id, name, phone_number, payment_method, reason, proofUrl } = data;

  await resend.emails.send({
    from: 'Khairi Payment <onboarding@resend.dev>',
    to: process.env.ADMIN_EMAIL,
    subject: `Pembayaran Baru dari ${name} - #${id}`,
    html: `
      <h1>Pembayaran Baru Diterima</h1>
      <p><b>ID:</b> ${id}</p>
      <p><b>Nama:</b> ${name}</p>
      <p><b>No WA:</b> ${phone_number}</p>
      <p><b>Metode:</b> ${payment_method}</p>
      <p><b>Alasan:</b> ${reason}</p>
      <p><a href="${proofUrl}">Lihat Bukti Pembayaran</a></p>
    `,
  });
}

// Get all payments
app.get('/api/payments', (req, res) => {
  db.all('SELECT * FROM payments ORDER BY created_at DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json({ success: true, data: rows });
  });
});

// Start server
app.listen(PORT, () => console.log('Server running on', PORT));
