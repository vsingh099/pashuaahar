'use strict';
const express  = require('express');
const supabase = require('../db');
const { toCamel } = require('../transform');
const router   = express.Router();

// GET /api/stock
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('stock')
    .select('*')
    .eq('user_id', req.userId)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(toCamel));
});

// POST /api/stock  (create)
router.post('/', async (req, res) => {
  const { rateId, name, packSize, bags, lowAlert, supplier } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (bags === undefined || bags < 0) return res.status(400).json({ error: 'bags is required' });
  const { data, error } = await supabase
    .from('stock')
    .insert({
      user_id: req.userId,
      rate_id: rateId || null,
      name, pack_size: packSize || 0,
      bags, low_alert: lowAlert || 5,
      supplier: supplier || null,
      updated_at: new Date().toISOString().split('T')[0]
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(toCamel(data));
});

// PUT /api/stock/:id  (update bags / alert)
router.put('/:id', async (req, res) => {
  const { rateId, name, packSize, bags, lowAlert, supplier } = req.body;
  const update = { updated_at: new Date().toISOString().split('T')[0] };
  if (rateId    !== undefined) update.rate_id    = rateId || null;
  if (name      !== undefined) update.name       = name;
  if (packSize  !== undefined) update.pack_size  = packSize;
  if (bags      !== undefined) update.bags       = bags;
  if (lowAlert  !== undefined) update.low_alert  = lowAlert;
  if (supplier  !== undefined) update.supplier   = supplier || null;
  const { data, error } = await supabase
    .from('stock')
    .update(update)
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Not found' });
  res.json(toCamel(data));
});

// DELETE /api/stock/:id
router.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('stock')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
