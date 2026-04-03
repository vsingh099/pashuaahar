'use strict';
const express  = require('express');
const supabase = require('../db');
const { toCamel } = require('../transform');
const router   = express.Router();

// GET /api/rates
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('rates')
    .select('*')
    .eq('user_id', req.userId)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(toCamel));
});

// POST /api/rates  (create)
router.post('/', async (req, res) => {
  const { name, packSize, pricePerBag } = req.body;
  if (!name || !packSize) return res.status(400).json({ error: 'name and packSize are required' });
  const { data, error } = await supabase
    .from('rates')
    .insert({ user_id: req.userId, name, pack_size: packSize, price_per_bag: pricePerBag || 0 })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(toCamel(data));
});

// PUT /api/rates/bulk  — batch price update (from "Save All Prices" button)
// MUST be before /:id so Express doesn't treat "bulk" as an id
router.put('/bulk', async (req, res) => {
  const updates = req.body; // [{ id, pricePerBag }]
  if (!Array.isArray(updates) || !updates.length) {
    return res.status(400).json({ error: 'Expected an array of { id, pricePerBag }' });
  }
  const results = [];
  for (const { id, pricePerBag } of updates) {
    const { data, error } = await supabase
      .from('rates')
      .update({ price_per_bag: pricePerBag })
      .eq('id', id)
      .eq('user_id', req.userId)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    results.push(toCamel(data));
  }
  res.json(results);
});

// PUT /api/rates/:id  (update single rate)
router.put('/:id', async (req, res) => {
  const { name, packSize, pricePerBag } = req.body;
  const update = {};
  if (name        !== undefined) update.name          = name;
  if (packSize    !== undefined) update.pack_size      = packSize;
  if (pricePerBag !== undefined) update.price_per_bag  = pricePerBag;
  const { data, error } = await supabase
    .from('rates')
    .update(update)
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Not found' });
  res.json(toCamel(data));
});

// DELETE /api/rates/:id
router.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('rates')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
