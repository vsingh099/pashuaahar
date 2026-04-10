'use strict';
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const path      = require('path');
const nodemailer = require('nodemailer');

const authMiddleware = require('./auth');
const { toCamel } = require('./transform');

const app = express();

// ── Security & parsing ──
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '2mb' }));

// ── Nodemailer transporter ──
const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// ── Auth routes ──
app.post('/api/auth/login', async (req, res) => {
  const supabase = require('./db');
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  res.json({ token: data.session.access_token, user: { id: data.user.id, email: data.user.email } });
});

// Owner-only signup — guarded by OWNER_SIGNUP_CODE
app.post('/api/auth/signup', async (req, res) => {
  const supabase = require('./db');
  const { email, password, signupCode } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const OWNER_CODE = process.env.OWNER_SIGNUP_CODE || 'BADRI2024';
  if (!signupCode || signupCode !== OWNER_CODE) {
    return res.status(403).json({ error: 'Invalid owner signup code' });
  }

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  if (!data.session) {
    return res.json({ message: 'Check your email to confirm your account before signing in.' });
  }
  res.json({ token: data.session.access_token, user: { id: data.user.id, email: data.user.email } });
});

// ── Public: product list (landing page) ──
app.get('/api/public/rates', async (req, res) => {
  const supabase = require('./db');
  const ownerId = process.env.OWNER_USER_ID;
  if (!ownerId) return res.json([]);
  const { data, error } = await supabase
    .from('rates')
    .select('id, name, pack_size, retailer_price, dealer_price')
    .eq('user_id', ownerId)
    .eq('is_public', true)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(toCamel));
});

// ── Public: submit order (landing page) ──
app.post('/api/public/order', async (req, res) => {
  const { name, phone, address, items, note } = req.body;
  if (!name || !phone || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'name, phone, and at least one item are required' });
  }

  const ownerEmails = (process.env.OWNER_EMAIL || 'vsmita099@gmail.com,viveksinghjpm6857@gmail.com')
    .split(',').map(e => e.trim()).filter(Boolean);

  const orderTime = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
  });

  const itemsHtml = items.map(it =>
    `<tr style="border-bottom:1px solid #eee">
      <td style="padding:8px 10px;color:#A86000;font-weight:700">${it.product}</td>
      <td style="padding:8px 10px;text-align:center;font-weight:700">${it.quantity}</td>
      <td style="padding:8px 10px;text-align:center;color:#888">bags</td>
    </tr>`
  ).join('');

  const itemsText = items.map(it => `  • ${it.product} × ${it.quantity} bags`).join('\n');

  const summaryLine = items.map(it => `${it.product} × ${it.quantity}`).join(', ');

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;border:1px solid #ddd;border-radius:8px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#A86000,#D08820);padding:20px;text-align:center">
        <h2 style="color:#fff;margin:0;font-size:22px">🛒 New Order — BADRI TRADERS</h2>
        <p style="color:rgba(255,255,255,.85);margin:6px 0 0;font-size:13px">${orderTime}</p>
      </div>
      <div style="padding:20px;background:#fff">
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr style="border-bottom:1px solid #eee">
            <td style="padding:10px 8px;color:#888;width:120px">Customer</td>
            <td style="padding:10px 8px;font-weight:700">${name}</td>
          </tr>
          <tr style="border-bottom:1px solid #eee">
            <td style="padding:10px 8px;color:#888">Phone</td>
            <td style="padding:10px 8px;font-weight:700"><a href="tel:${phone}">${phone}</a></td>
          </tr>
          <tr style="border-bottom:1px solid #eee">
            <td style="padding:10px 8px;color:#888">Address</td>
            <td style="padding:10px 8px">${address || '—'}</td>
          </tr>
        </table>
        <div style="margin-top:16px">
          <div style="font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Order Items</div>
          <table style="width:100%;border-collapse:collapse;font-size:14px;border:1px solid #eee;border-radius:6px;overflow:hidden">
            <thead>
              <tr style="background:#FDF2DC">
                <th style="padding:8px 10px;text-align:left;font-size:12px;color:#9A5E0A">Product</th>
                <th style="padding:8px 10px;text-align:center;font-size:12px;color:#9A5E0A">Qty</th>
                <th style="padding:8px 10px;text-align:center;font-size:12px;color:#9A5E0A">Unit</th>
              </tr>
            </thead>
            <tbody>${itemsHtml}</tbody>
          </table>
        </div>
        ${note ? `<div style="margin-top:14px;padding:10px;background:#f9f9f9;border-radius:6px;font-size:13px;color:#555"><strong>Note:</strong> ${note}</div>` : ''}
      </div>
      <div style="background:#FDF2DC;padding:14px 20px;text-align:center;font-size:12px;color:#9A5E0A">
        Reply to this email or WhatsApp <strong>7080006857</strong> to confirm delivery.
      </div>
    </div>`;

  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      await mailer.sendMail({
        from: `"BADRI TRADERS Orders" <${process.env.SMTP_USER}>`,
        to:   ownerEmails.join(','),
        subject: `New Order from ${name} — ${summaryLine}`,
        html,
        text: `New Order\n\nCustomer: ${name}\nPhone: ${phone}\nAddress: ${address||'—'}\nItems:\n${itemsText}\nNote: ${note||'—'}\nTime: ${orderTime}`
      });
    } catch (err) {
      console.error('Email send error:', err.message);
    }
  } else {
    console.log(`📦 NEW ORDER — ${name} | ${phone} | ${summaryLine}`);
  }
  res.json({ success: true, message: 'Order placed! We will contact you soon.' });
});

// ── Protected API routes ──
app.use('/api/customers', authMiddleware, require('./routes/customers'));
app.use('/api/sales',     authMiddleware, require('./routes/sales'));
app.use('/api/stock',     authMiddleware, require('./routes/stock'));
app.use('/api/rates',     authMiddleware, require('./routes/rates'));
app.use('/api/payments',  authMiddleware, require('./routes/payments'));
app.use('/api/targets',   authMiddleware, require('./routes/targets'));

// ── Page routes ──
// Public landing page at /
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'landing.html'));
});
// Owner dashboard at /app
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// ── Static assets ──
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ── Fallback ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'landing.html'));
});

// ── Error handler ──
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BADRI TRADERS running at http://localhost:${PORT}`));
