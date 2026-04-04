'use strict';
const express  = require('express');
const supabase = require('../db');
const { toCamel } = require('../transform');
const router   = express.Router();

// GET /api/targets
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('targets')
    .select('*')
    .eq('user_id', req.userId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ? toCamel(data) : { daily: 0, monthly: 0 });
});

// PUT /api/targets  (upsert)
router.put('/', async (req, res) => {
  const { daily, monthly } = req.body;
  const { data, error } = await supabase
    .from('targets')
    .upsert({ user_id: req.userId, daily: daily || 0, monthly: monthly || 0, updated_at: new Date().toISOString() })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(toCamel(data));
});

module.exports = router;
