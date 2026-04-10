'use strict';
require('dotenv').config();
const express    = require('express');
const path       = require('path');
const crypto     = require('crypto');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const Database   = require('better-sqlite3');

const JWT_SECRET = process.env.JWT_SECRET     || 'local-dev-secret-change-in-prod';
const DB_PATH    = process.env.LOCAL_DB_PATH  || path.join(__dirname, '..', 'local.db');

// ── SQLite setup ──────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS rates (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id),
    name           TEXT NOT NULL,
    pack_size      REAL NOT NULL DEFAULT 0,
    cost_price     REAL NOT NULL DEFAULT 0,
    price_per_bag  REAL NOT NULL DEFAULT 0,
    retailer_price REAL NOT NULL DEFAULT 0,
    dealer_price   REAL NOT NULL DEFAULT 0,
    is_public      INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS customers (
    id      TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name    TEXT NOT NULL,
    phone   TEXT DEFAULT '',
    address TEXT DEFAULT '',
    type    TEXT NOT NULL DEFAULT 'Direct Customer'
  );
  CREATE TABLE IF NOT EXISTS stock (
    id        TEXT    PRIMARY KEY,
    user_id   TEXT    NOT NULL REFERENCES users(id),
    rate_id   TEXT    REFERENCES rates(id),
    name      TEXT    NOT NULL DEFAULT '',
    pack_size REAL    NOT NULL DEFAULT 0,
    bags      REAL    NOT NULL DEFAULT 0,
    low_alert REAL    NOT NULL DEFAULT 5,
    supplier  TEXT    DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS sales (
    id            TEXT    PRIMARY KEY,
    user_id       TEXT    NOT NULL REFERENCES users(id),
    bill_no       INTEGER NOT NULL,
    customer_id   TEXT,
    customer_name TEXT    NOT NULL DEFAULT 'Walk-in / Cash',
    customer_type TEXT    DEFAULT '',
    date          TEXT    NOT NULL,
    total         REAL    NOT NULL DEFAULT 0,
    paid_amount   REAL    NOT NULL DEFAULT 0,
    pay_status    TEXT    NOT NULL DEFAULT 'unpaid',
    notes         TEXT    DEFAULT '',
    created_at    TEXT    DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sale_items (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    sale_id       TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    rate_id       TEXT,
    name          TEXT NOT NULL DEFAULT '',
    pack_size     REAL NOT NULL DEFAULT 0,
    bags          REAL NOT NULL DEFAULT 0,
    price_per_bag REAL NOT NULL DEFAULT 0,
    amount        REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS payments (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id),
    customer_id   TEXT NOT NULL,
    customer_name TEXT NOT NULL DEFAULT '',
    amount        REAL NOT NULL DEFAULT 0,
    date          TEXT NOT NULL,
    mode          TEXT
  );
  CREATE TABLE IF NOT EXISTS targets (
    user_id    TEXT PRIMARY KEY REFERENCES users(id),
    daily      REAL DEFAULT 0,
    monthly    REAL DEFAULT 0,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS bill_seq (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    seq     INTEGER DEFAULT 1000
  );
`);

// ── Migrations (safe — ignore errors if column already exists) ────────────────
const runMigration = sql => { try { db.exec(sql); } catch(_) {} };

// rates
runMigration("ALTER TABLE rates ADD COLUMN retailer_price REAL NOT NULL DEFAULT 0");
runMigration("ALTER TABLE rates ADD COLUMN dealer_price   REAL NOT NULL DEFAULT 0");
runMigration("ALTER TABLE rates ADD COLUMN cost_price     REAL NOT NULL DEFAULT 0");
runMigration("ALTER TABLE rates ADD COLUMN is_public      INTEGER NOT NULL DEFAULT 0");
db.exec('UPDATE rates SET retailer_price = price_per_bag, dealer_price = price_per_bag WHERE retailer_price = 0 AND price_per_bag > 0');

// customers
runMigration("ALTER TABLE customers ADD COLUMN type TEXT NOT NULL DEFAULT 'Direct Customer'");

// stock
runMigration("ALTER TABLE stock ADD COLUMN name      TEXT NOT NULL DEFAULT ''");
runMigration("ALTER TABLE stock ADD COLUMN pack_size REAL NOT NULL DEFAULT 0");
runMigration("ALTER TABLE stock ADD COLUMN supplier  TEXT DEFAULT ''");

// sales — add new columns for existing DBs
runMigration("ALTER TABLE sales ADD COLUMN customer_type TEXT DEFAULT ''");
runMigration("ALTER TABLE sales ADD COLUMN paid_amount   REAL NOT NULL DEFAULT 0");
runMigration("ALTER TABLE sales ADD COLUMN pay_status    TEXT NOT NULL DEFAULT 'unpaid'");
runMigration("ALTER TABLE sales ADD COLUMN notes         TEXT DEFAULT ''");
// Backfill paid_amount from old 'paid' column if it exists
try { db.exec('UPDATE sales SET paid_amount = paid WHERE paid_amount = 0 AND paid > 0'); } catch(_) {}

// sale_items — old table is missing user_id, name, pack_size
runMigration("ALTER TABLE sale_items ADD COLUMN user_id   TEXT NOT NULL DEFAULT ''");
runMigration("ALTER TABLE sale_items ADD COLUMN name      TEXT NOT NULL DEFAULT ''");
runMigration("ALTER TABLE sale_items ADD COLUMN pack_size REAL NOT NULL DEFAULT 0");
// Backfill name from rate_name if it exists
try { db.exec("UPDATE sale_items SET name = rate_name WHERE name = '' AND rate_name != ''"); } catch(_) {}
// Add DEFAULT to rate_name so legacy INSERT without it doesn't fail
runMigration("ALTER TABLE sale_items ADD COLUMN rate_name TEXT NOT NULL DEFAULT ''");

// ── Nodemailer ────────────────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const uid  = () => crypto.randomUUID();
const now  = () => new Date().toISOString();
function toCamel(obj) {
  if (!obj) return obj;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v])
  );
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '2mb' }));

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(h.slice(7), JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, signupCode } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const OWNER_CODE = process.env.OWNER_SIGNUP_CODE || 'BADRI2024';
  if (!signupCode || signupCode !== OWNER_CODE)
    return res.status(403).json({ error: 'Invalid owner signup code' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email))
    return res.status(400).json({ error: 'Email already registered' });
  const hash = await bcrypt.hash(password, 10);
  const id   = uid();
  db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(id, email, hash);
  const token = jwt.sign({ sub: id, email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id, email } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash)))
    return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, email: user.email } });
});

// ── Public: products (landing page) ──────────────────────────────────────────
// Local single-owner mode: return all public rates regardless of user
app.get('/api/public/rates', (req, res) => {
  const rows = db.prepare('SELECT * FROM rates WHERE is_public = 1 ORDER BY name').all();
  res.json(rows.map(toCamel));
});

// ── Public: submit order ──────────────────────────────────────────────────────
app.post('/api/public/order', async (req, res) => {
  const { name, phone, address, items, note } = req.body;
  if (!name || !phone || !Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'name, phone, and at least one item are required' });

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

  const itemsText    = items.map(it => `  • ${it.product} × ${it.quantity} bags`).join('\n');
  const summaryLine  = items.map(it => `${it.product} × ${it.quantity}`).join(', ');

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;border:1px solid #ddd;border-radius:8px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#A86000,#D08820);padding:20px;text-align:center">
        <h2 style="color:#fff;margin:0;font-size:22px">🛒 New Order — BADRI TRADERS</h2>
        <p style="color:rgba(255,255,255,.85);margin:6px 0 0;font-size:13px">${orderTime}</p>
      </div>
      <div style="padding:20px;background:#fff">
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr style="border-bottom:1px solid #eee"><td style="padding:10px 8px;color:#888;width:120px">Customer</td><td style="padding:10px 8px;font-weight:700">${name}</td></tr>
          <tr style="border-bottom:1px solid #eee"><td style="padding:10px 8px;color:#888">Phone</td><td style="padding:10px 8px;font-weight:700"><a href="tel:${phone}">${phone}</a></td></tr>
          <tr style="border-bottom:1px solid #eee"><td style="padding:10px 8px;color:#888">Address</td><td style="padding:10px 8px">${address||'—'}</td></tr>
        </table>
        <div style="margin-top:16px">
          <div style="font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Order Items</div>
          <table style="width:100%;border-collapse:collapse;font-size:14px;border:1px solid #eee;border-radius:6px;overflow:hidden">
            <thead><tr style="background:#FDF2DC">
              <th style="padding:8px 10px;text-align:left;font-size:12px;color:#9A5E0A">Product</th>
              <th style="padding:8px 10px;text-align:center;font-size:12px;color:#9A5E0A">Qty</th>
              <th style="padding:8px 10px;text-align:center;font-size:12px;color:#9A5E0A">Unit</th>
            </tr></thead>
            <tbody>${itemsHtml}</tbody>
          </table>
        </div>
        ${note ? `<div style="margin-top:14px;padding:10px;background:#f9f9f9;border-radius:6px;font-size:13px;color:#555"><strong>Note:</strong> ${note}</div>` : ''}
      </div>
      <div style="background:#FDF2DC;padding:14px 20px;text-align:center;font-size:12px;color:#9A5E0A">
        Reply or WhatsApp <strong>7080006857</strong> to confirm delivery.
      </div>
    </div>`;

  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      await mailer.sendMail({
        from:    `"BADRI TRADERS Orders" <${process.env.SMTP_USER}>`,
        to:      ownerEmails.join(','),
        subject: `New Order from ${name} — ${summaryLine}`,
        html,
        text: `New Order\n\nCustomer: ${name}\nPhone: ${phone}\nAddress: ${address||'—'}\nItems:\n${itemsText}\nNote: ${note||'—'}\nTime: ${orderTime}`
      });
      console.log(`Order email sent to ${ownerEmails.join(', ')}`);
    } catch (err) {
      console.warn('Email failed:', err.message);
    }
  } else {
    console.log(`\n📦 NEW ORDER\n  Customer: ${name} | Phone: ${phone}\n  Items:\n${itemsText}\n  Address: ${address||'—'}\n  Note: ${note||'—'}\n`);
  }
  res.json({ success: true, message: 'Order placed! We will contact you soon.' });
});

// ── Rates ─────────────────────────────────────────────────────────────────────
app.get('/api/rates', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM rates WHERE user_id = ? ORDER BY name').all(req.userId).map(toCamel));
});

app.post('/api/rates', auth, (req, res) => {
  const { name, packSize, costPrice, pricePerBag, retailerPrice, dealerPrice, isPublic } = req.body;
  if (!name || !packSize) return res.status(400).json({ error: 'name and packSize are required' });
  const cp = costPrice ?? 0;
  const rp = retailerPrice ?? pricePerBag ?? 0;
  const dp = dealerPrice ?? rp;
  const id = uid();
  db.prepare('INSERT INTO rates (id, user_id, name, pack_size, cost_price, price_per_bag, retailer_price, dealer_price, is_public) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.userId, name, packSize, cp, rp, rp, dp, isPublic ? 1 : 0);
  res.status(201).json(toCamel(db.prepare('SELECT * FROM rates WHERE id = ?').get(id)));
});

app.put('/api/rates/bulk', auth, (req, res) => {
  const updates = req.body;
  if (!Array.isArray(updates) || !updates.length)
    return res.status(400).json({ error: 'Expected array' });
  const results = db.transaction(() =>
    updates.map(({ id, costPrice, retailerPrice, dealerPrice, pricePerBag, isPublic }) => {
      const cp = costPrice ?? 0;
      const rp = retailerPrice ?? pricePerBag ?? 0;
      const dp = dealerPrice ?? rp;
      db.prepare('UPDATE rates SET cost_price = ?, price_per_bag = ?, retailer_price = ?, dealer_price = ?, is_public = ? WHERE id = ? AND user_id = ?')
        .run(cp, rp, rp, dp, isPublic ? 1 : 0, id, req.userId);
      return toCamel(db.prepare('SELECT * FROM rates WHERE id = ?').get(id));
    })
  )();
  res.json(results);
});

app.put('/api/rates/:id', auth, (req, res) => {
  const { name, packSize, costPrice, pricePerBag, retailerPrice, dealerPrice, isPublic } = req.body;
  const sets = [], vals = [];
  if (name         !== undefined) { sets.push('name = ?');           vals.push(name); }
  if (packSize     !== undefined) { sets.push('pack_size = ?');       vals.push(packSize); }
  if (costPrice    !== undefined) { sets.push('cost_price = ?');      vals.push(costPrice); }
  if (retailerPrice !== undefined){ sets.push('retailer_price = ?');  vals.push(retailerPrice); sets.push('price_per_bag = ?'); vals.push(retailerPrice); }
  else if (pricePerBag !== undefined){ sets.push('price_per_bag = ?'); vals.push(pricePerBag); sets.push('retailer_price = ?'); vals.push(pricePerBag); }
  if (dealerPrice  !== undefined) { sets.push('dealer_price = ?');    vals.push(dealerPrice); }
  if (isPublic     !== undefined) { sets.push('is_public = ?');       vals.push(isPublic ? 1 : 0); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id, req.userId);
  db.prepare(`UPDATE rates SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals);
  res.json(toCamel(db.prepare('SELECT * FROM rates WHERE id = ?').get(req.params.id)));
});

app.delete('/api/rates/:id', auth, (req, res) => {
  db.prepare('DELETE FROM rates WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ success: true });
});

// ── Customers ─────────────────────────────────────────────────────────────────
app.get('/api/customers', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM customers WHERE user_id = ? ORDER BY name').all(req.userId).map(toCamel));
});

app.post('/api/customers', auth, (req, res) => {
  const { name, phone, address, type } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = uid();
  db.prepare('INSERT INTO customers (id, user_id, name, phone, address, type) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.userId, name, phone||'', address||'', type||'Direct Customer');
  res.status(201).json(toCamel(db.prepare('SELECT * FROM customers WHERE id = ?').get(id)));
});

app.put('/api/customers/:id', auth, (req, res) => {
  const { name, phone, address, type } = req.body;
  const sets = [], vals = [];
  if (name    !== undefined) { sets.push('name = ?');    vals.push(name); }
  if (phone   !== undefined) { sets.push('phone = ?');   vals.push(phone); }
  if (address !== undefined) { sets.push('address = ?'); vals.push(address); }
  if (type    !== undefined) { sets.push('type = ?');    vals.push(type); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id, req.userId);
  db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals);
  res.json(toCamel(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id)));
});

app.delete('/api/customers/:id', auth, (req, res) => {
  db.prepare('DELETE FROM customers WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ success: true });
});

// ── Stock ─────────────────────────────────────────────────────────────────────
app.get('/api/stock', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM stock WHERE user_id = ?').all(req.userId).map(toCamel));
});

app.post('/api/stock', auth, (req, res) => {
  const { rateId, name, packSize, bags, lowAlert, supplier } = req.body;
  const id = uid();
  let sname = name, spack = packSize || 0;
  if (rateId && !name) {
    const r = db.prepare('SELECT * FROM rates WHERE id = ?').get(rateId);
    if (r) { sname = r.name; spack = r.pack_size; }
  }
  db.prepare('INSERT INTO stock (id, user_id, rate_id, name, pack_size, bags, low_alert, supplier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.userId, rateId||null, sname||'', spack, bags||0, lowAlert||5, supplier||'');
  res.status(201).json(toCamel(db.prepare('SELECT * FROM stock WHERE id = ?').get(id)));
});

app.put('/api/stock/:id', auth, (req, res) => {
  const { rateId, name, packSize, bags, lowAlert, supplier } = req.body;
  const sets = [], vals = [];
  if (rateId   !== undefined) { sets.push('rate_id = ?');   vals.push(rateId); }
  if (name     !== undefined) { sets.push('name = ?');      vals.push(name); }
  if (packSize !== undefined) { sets.push('pack_size = ?'); vals.push(packSize); }
  if (bags     !== undefined) { sets.push('bags = ?');      vals.push(bags); }
  if (lowAlert !== undefined) { sets.push('low_alert = ?'); vals.push(lowAlert); }
  if (supplier !== undefined) { sets.push('supplier = ?');  vals.push(supplier); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id, req.userId);
  db.prepare(`UPDATE stock SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals);
  res.json(toCamel(db.prepare('SELECT * FROM stock WHERE id = ?').get(req.params.id)));
});

app.delete('/api/stock/:id', auth, (req, res) => {
  db.prepare('DELETE FROM stock WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ success: true });
});

// ── Sales ─────────────────────────────────────────────────────────────────────
app.get('/api/sales', auth, (req, res) => {
  const sales = db.prepare('SELECT * FROM sales WHERE user_id = ? ORDER BY created_at DESC').all(req.userId);
  const itemsStmt = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?');
  res.json(sales.map(s => ({ ...toCamel(s), items: itemsStmt.all(s.id).map(toCamel) })));
});

// customerId is optional — null/omitted means Walk-in / Cash
app.post('/api/sales', auth, (req, res) => {
  const { customerId, customerName, customerType, date, total, paidAmount, payStatus, notes, items } = req.body;
  if (!date || !items?.length) return res.status(400).json({ error: 'date and items are required' });
  const saleId = db.transaction(() => {
    db.prepare('INSERT INTO bill_seq (user_id, seq) VALUES (?, 1001) ON CONFLICT(user_id) DO UPDATE SET seq = seq + 1')
      .run(req.userId);
    const { seq } = db.prepare('SELECT seq FROM bill_seq WHERE user_id = ?').get(req.userId);
    const id = uid();
    // Use '' instead of null for walk-in — old local.db may have customer_id NOT NULL
    db.prepare('INSERT INTO sales (id, user_id, bill_no, customer_id, customer_name, customer_type, date, total, paid_amount, pay_status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, req.userId, seq, customerId||'', customerName||'Walk-in / Cash', customerType||'', date, total||0, paidAmount||0, payStatus||'unpaid', notes||'');
    // Include rate_name for backwards-compat with old local.db (rate_name NOT NULL)
    const itemStmt = db.prepare('INSERT INTO sale_items (id, user_id, sale_id, rate_id, name, rate_name, pack_size, bags, price_per_bag, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const it of (items||[])) {
      itemStmt.run(uid(), req.userId, id, it.rateId||null, it.name||'', it.name||'', it.packSize||0, it.bags||0, it.pricePerBag||0, it.amount||0);
      if (it.rateId) {
        db.prepare('UPDATE stock SET bags = MAX(0, bags - ?) WHERE rate_id = ? AND user_id = ?')
          .run(it.bags||0, it.rateId, req.userId);
      }
    }
    return id;
  })();
  const sale      = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  const saleItems = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
  res.status(201).json({ ...toCamel(sale), items: saleItems.map(toCamel) });
});

app.delete('/api/sales/:id', auth, (req, res) => {
  db.transaction(() => {
    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(req.params.id);
    for (const it of items) {
      if (it.rate_id)
        db.prepare('UPDATE stock SET bags = bags + ? WHERE rate_id = ? AND user_id = ?')
          .run(it.bags, it.rate_id, req.userId);
    }
    db.prepare('DELETE FROM sales WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  })();
  res.json({ success: true });
});

// ── Payments ──────────────────────────────────────────────────────────────────
app.get('/api/payments', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY date DESC').all(req.userId).map(toCamel));
});

app.post('/api/payments', auth, (req, res) => {
  const { customerId, customerName, amount, date, mode } = req.body;
  if (!customerId || !amount) return res.status(400).json({ error: 'customerId and amount are required' });
  const id = uid();
  db.prepare('INSERT INTO payments (id, user_id, customer_id, customer_name, amount, date, mode) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.userId, customerId, customerName||'', amount, date||new Date().toISOString().split('T')[0], mode||null);
  res.status(201).json(toCamel(db.prepare('SELECT * FROM payments WHERE id = ?').get(id)));
});

app.delete('/api/payments/:id', auth, (req, res) => {
  db.prepare('DELETE FROM payments WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ success: true });
});

// ── Targets ───────────────────────────────────────────────────────────────────
app.get('/api/targets', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM targets WHERE user_id = ?').get(req.userId);
  res.json(row ? toCamel(row) : { daily: 0, monthly: 0 });
});

app.put('/api/targets', auth, (req, res) => {
  const { daily, monthly } = req.body;
  db.prepare('INSERT INTO targets (user_id, daily, monthly, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET daily = excluded.daily, monthly = excluded.monthly, updated_at = excluded.updated_at')
    .run(req.userId, daily||0, monthly||0, now());
  res.json(toCamel(db.prepare('SELECT * FROM targets WHERE user_id = ?').get(req.userId)));
});

// ── Page routes (before static so / isn't hijacked by index.html default) ────
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'frontend', 'landing.html'))
);
app.get('/app', (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'))
);
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'frontend', 'landing.html'))
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BADRI TRADERS (local/SQLite) → http://localhost:${PORT}`);
  console.log(`Dashboard → http://localhost:${PORT}/app`);
  console.log(`Database: ${DB_PATH}`);
  if (!process.env.SMTP_USER) console.warn('⚠️  SMTP not configured — order emails will not send');
});
