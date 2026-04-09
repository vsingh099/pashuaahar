'use strict';
const express  = require('express');
const supabase = require('../db');
const { toCamel } = require('../transform');
const router   = express.Router();

// GET /api/payments
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('payments')
    .select('*')
    .eq('user_id', req.userId)
    .order('date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(toCamel));
});

// POST /api/payments
router.post('/', async (req, res) => {
  const { customerId, customerName, amount, date, mode } = req.body;
  if (!customerId || !amount) return res.status(400).json({ error: 'customerId and amount are required' });
  const { data, error } = await supabase
    .from('payments')
    .insert({
      user_id: req.userId,
      customer_id:   customerId,
      customer_name: customerName || '',
      amount,
      date: date || new Date().toISOString().split('T')[0],
      mode: mode || null
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(toCamel(data));
});

// DELETE /api/payments/:id
router.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('payments')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
