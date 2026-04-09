'use strict';
const express  = require('express');
const supabase = require('../db');
const { toCamel, toSnake } = require('../transform');
const router   = express.Router();

// GET /api/customers
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('user_id', req.userId)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(toCamel));
});

// POST /api/customers  (create)
router.post('/', async (req, res) => {
  const { name, phone, address, type } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { data, error } = await supabase
    .from('customers')
    .insert({ user_id: req.userId, name, phone: phone || null, address: address || null, type: type || 'Direct Customer' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(toCamel(data));
});

// PUT /api/customers/:id  (update)
router.put('/:id', async (req, res) => {
  const { name, phone, address, type } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { data, error } = await supabase
    .from('customers')
    .update({ name, phone: phone || null, address: address || null, type })
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Not found' });
  res.json(toCamel(data));
});

// DELETE /api/customers/:id
router.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('customers')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.userId);
  // Postgres RESTRICT will raise a foreign-key error if bills exist
  if (error) {
    const msg = error.code === '23503'
      ? 'Cannot delete customer who has existing bills or payments'
      : error.message;
    return res.status(error.code === '23503' ? 409 : 500).json({ error: msg });
  }
  res.json({ success: true });
});

module.exports = router;
