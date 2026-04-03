'use strict';
require('dotenv').config();
const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const Database = require('better-sqlite3');

const JWT_SECRET = process.env.JWT_SECRET || 'local-dev-secret-change-in-prod';
const DB_PATH    = process.env.LOCAL_DB_PATH || path.join(__dirname, '..', 'local.db');

// ── SQLite setup ──────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    email        TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS rates (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id),
    name           TEXT NOT NULL,
    pack_size      REAL NOT NULL DEFAULT 0,
    price_per_bag  REAL NOT NULL DEFAULT 0,
    retailer_price REAL NOT NULL DEFAULT 0,
    dealer_price   REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS customers (
    id      TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name    TEXT NOT NULL,
    phone   TEXT DEFAULT '',
    address TEXT DEFAULT '',
    balance REAL DEFAULT 0,
    type    TEXT NOT NULL DEFAULT 'Direct Customer'
  );
  CREATE TABLE IF NOT EXISTS stock (
    id        TEXT PRIMARY KEY,
    user_id   TEXT NOT NULL REFERENCES users(id),
    rate_id   TEXT NOT NULL REFERENCES rates(id),
    bags      REAL NOT NULL DEFAULT 0,
    low_alert REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sales (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id),
    bill_no       INTEGER NOT NULL,
    customer_id   TEXT NOT NULL,
    customer_name TEXT NOT NULL DEFAULT '',
    date          TEXT NOT NULL,
    total         REAL NOT NULL DEFAULT 0,
    paid          REAL NOT NULL DEFAULT 0,
    balance       REAL NOT NULL DEFAULT 0,
    note          TEXT DEFAULT '',
    created_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sale_items (
    id            TEXT PRIMARY KEY,
    sale_id       TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    rate_id       TEXT,
    rate_name     TEXT NOT NULL,
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
    seq     INTEGER DEFAULT 0
  );
`);

// ── Migrations ────────────────────────────────────────────────────────────────
try { db.exec('ALTER TABLE rates ADD COLUMN retailer_price REAL NOT NULL DEFAULT 0'); } catch(_) {}
try { db.exec('ALTER TABLE rates ADD COLUMN dealer_price REAL NOT NULL DEFAULT 0'); } catch(_) {}
// Copy existing price_per_bag into retailer_price/dealer_price for legacy rows
db.exec('UPDATE rates SET retailer_price = price_per_bag, dealer_price = price_per_bag WHERE retailer_price = 0 AND price_per_bag > 0');
try { db.exec('ALTER TABLE customers ADD COLUMN type TEXT NOT NULL DEFAULT \'Direct Customer\''); } catch(_) {}

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
app.use(express.static(path.join(__dirname, '..', 'public')));

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
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email))
    return res.status(400).json({ error: 'Email already registered' });
  const hash = await bcrypt.hash(password, 10);
  const id = uid();
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

// ── Rates ─────────────────────────────────────────────────────────────────────
app.get('/api/rates', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM rates WHERE user_id = ? ORDER BY name').all(req.userId).map(toCamel));
});

app.post('/api/rates', auth, (req, res) => {
  const { name, packSize, pricePerBag, retailerPrice, dealerPrice } = req.body;
  if (!name || !packSize) return res.status(400).json({ error: 'name and packSize are required' });
  const rp = retailerPrice ?? pricePerBag ?? 0;
  const dp = dealerPrice ?? rp;
  const id = uid();
  db.prepare('INSERT INTO rates (id, user_id, name, pack_size, price_per_bag, retailer_price, dealer_price) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.userId, name, packSize, rp, rp, dp);
  res.status(201).json(toCamel(db.prepare('SELECT * FROM rates WHERE id = ?').get(id)));
});

app.put('/api/rates/bulk', auth, (req, res) => {
  const updates = req.body;
  if (!Array.isArray(updates) || !updates.length)
    return res.status(400).json({ error: 'Expected array of { id, retailerPrice, dealerPrice }' });
  const stmt = db.prepare('UPDATE rates SET price_per_bag = ?, retailer_price = ?, dealer_price = ? WHERE id = ? AND user_id = ?');
  const results = db.transaction(() =>
    updates.map(({ id, retailerPrice, dealerPrice, pricePerBag }) => {
      const rp = retailerPrice ?? pricePerBag ?? 0;
      const dp = dealerPrice ?? rp;
      stmt.run(rp, rp, dp, id, req.userId);
      return toCamel(db.prepare('SELECT * FROM rates WHERE id = ?').get(id));
    })
  )();
  res.json(results);
});

app.put('/api/rates/:id', auth, (req, res) => {
  const { name, packSize, pricePerBag, retailerPrice, dealerPrice } = req.body;
  const sets = [], vals = [];
  if (name           !== undefined) { sets.push('name = ?');           vals.push(name); }
  if (packSize       !== undefined) { sets.push('pack_size = ?');       vals.push(packSize); }
  if (retailerPrice  !== undefined) { sets.push('retailer_price = ?');  vals.push(retailerPrice); sets.push('price_per_bag = ?'); vals.push(retailerPrice); }
  else if (pricePerBag !== undefined) { sets.push('price_per_bag = ?'); vals.push(pricePerBag); sets.push('retailer_price = ?'); vals.push(pricePerBag); }
  if (dealerPrice    !== undefined) { sets.push('dealer_price = ?');    vals.push(dealerPrice); }
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
  const { name, phone, address, balance } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = uid();
  db.prepare('INSERT INTO customers (id, user_id, name, phone, address, balance) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.userId, name, phone || '', address || '', balance || 0);
  res.status(201).json(toCamel(db.prepare('SELECT * FROM customers WHERE id = ?').get(id)));
});

app.put('/api/customers/:id', auth, (req, res) => {
  const { name, phone, address, balance } = req.body;
  const sets = [], vals = [];
  if (name    !== undefined) { sets.push('name = ?');    vals.push(name); }
  if (phone   !== undefined) { sets.push('phone = ?');   vals.push(phone); }
  if (address !== undefined) { sets.push('address = ?'); vals.push(address); }
  if (balance !== undefined) { sets.push('balance = ?'); vals.push(balance); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id, req.userId);
  db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals);
  res.json(toCamel(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id)));
});

app.delete('/api/customers/:id', auth, (req, res) => {
  if (db.prepare('SELECT 1 FROM sales WHERE customer_id = ? AND user_id = ?').get(req.params.id, req.userId))
    return res.status(409).json({ error: 'Customer has existing bills. Delete them first.' });
  db.prepare('DELETE FROM customers WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ success: true });
});

// ── Stock ─────────────────────────────────────────────────────────────────────
app.get('/api/stock', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM stock WHERE user_id = ?').all(req.userId).map(toCamel));
});

app.post('/api/stock', auth, (req, res) => {
  const { rateId, bags, lowAlert } = req.body;
  if (!rateId) return res.status(400).json({ error: 'rateId is required' });
  const id = uid();
  db.prepare('INSERT INTO stock (id, user_id, rate_id, bags, low_alert) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.userId, rateId, bags || 0, lowAlert || 0);
  res.status(201).json(toCamel(db.prepare('SELECT * FROM stock WHERE id = ?').get(id)));
});

app.put('/api/stock/:id', auth, (req, res) => {
  const { rateId, bags, lowAlert } = req.body;
  const sets = [], vals = [];
  if (rateId   !== undefined) { sets.push('rate_id = ?');   vals.push(rateId); }
  if (bags     !== undefined) { sets.push('bags = ?');      vals.push(bags); }
  if (lowAlert !== undefined) { sets.push('low_alert = ?'); vals.push(lowAlert); }
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

app.post('/api/sales', auth, (req, res) => {
  const { customerId, customerName, date, total, paid, balance, note, items } = req.body;
  const saleId = db.transaction(() => {
    db.prepare(
      'INSERT INTO bill_seq (user_id, seq) VALUES (?, 1) ON CONFLICT(user_id) DO UPDATE SET seq = seq + 1'
    ).run(req.userId);
    const { seq } = db.prepare('SELECT seq FROM bill_seq WHERE user_id = ?').get(req.userId);
    const id = uid();
    db.prepare(
      'INSERT INTO sales (id, user_id, bill_no, customer_id, customer_name, date, total, paid, balance, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, req.userId, seq, customerId, customerName || '', date, total || 0, paid || 0, balance || 0, note || '');
    const itemStmt = db.prepare(
      'INSERT INTO sale_items (id, sale_id, rate_id, rate_name, bags, price_per_bag, amount) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const it of (items || [])) {
      itemStmt.run(uid(), id, it.rateId || null, it.rateName || '', it.bags || 0, it.pricePerBag || 0, it.amount || 0);
      if (it.rateId) {
        db.prepare('UPDATE stock SET bags = MAX(0, bags - ?) WHERE rate_id = ? AND user_id = ?')
          .run(it.bags || 0, it.rateId, req.userId);
      }
    }
    return id;
  })();
  const sale  = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
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
    .run(id, req.userId, customerId, customerName || '', amount, date || new Date().toISOString().split('T')[0], mode || null);
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
  db.prepare(
    'INSERT INTO targets (user_id, daily, monthly, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET daily = excluded.daily, monthly = excluded.monthly, updated_at = excluded.updated_at'
  ).run(req.userId, daily || 0, monthly || 0, now());
  res.json(toCamel(db.prepare('SELECT * FROM targets WHERE user_id = ?').get(req.userId)));
});

// ── Catch-all ─────────────────────────────────────────────────────────────────
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'))
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PashuFeed Pro (local/SQLite) running at http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
