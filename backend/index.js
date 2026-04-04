'use strict';
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const path    = require('path');

const authMiddleware = require('./auth');

const app = express();

// ── Security & parsing ──
app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled for single-file HTML with inline scripts
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '2mb' }));

// ── Auth routes (no JWT needed — they return the JWT) ──
app.post('/api/auth/login', async (req, res) => {
  const supabase = require('./db');
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  res.json({ token: data.session.access_token, user: { id: data.user.id, email: data.user.email } });
});

app.post('/api/auth/signup', async (req, res) => {
  const supabase = require('./db');
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  // On signup, Supabase may require email confirmation depending on project settings.
  // If email confirmation is disabled, session is available immediately.
  if (!data.session) {
    return res.json({ message: 'Check your email to confirm your account before signing in.' });
  }
  res.json({ token: data.session.access_token, user: { id: data.user.id, email: data.user.email } });
});

// ── Protected API routes ──
app.use('/api/customers', authMiddleware, require('./routes/customers'));
app.use('/api/sales',     authMiddleware, require('./routes/sales'));
app.use('/api/stock',     authMiddleware, require('./routes/stock'));
app.use('/api/rates',     authMiddleware, require('./routes/rates'));
app.use('/api/payments',  authMiddleware, require('./routes/payments'));
app.use('/api/targets',   authMiddleware, require('./routes/targets'));

// ── Serve frontend ──
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// ── Error handler ──
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PashuFeed Pro running at http://localhost:${PORT}`));
