'use strict';
const express  = require('express');
const supabase = require('../db');
const { toCamel } = require('../transform');
const router   = express.Router();
const uid = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 4);

// GET /api/sales  — returns all sales with nested items[]
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('sales')
    .select('*, items:sale_items(*)')
    .eq('user_id', req.userId)
    .order('date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const result = data.map(s => {
    const sale = toCamel(s);
    sale.items = (s.items || []).map(toCamel);
    return sale;
  });
  res.json(result);
});

// POST /api/sales  — creates sale atomically via stored procedure
// customerId is optional — null/omitted means Walk-in / Cash sale
router.post('/', async (req, res) => {
  const {
    customerId, customerName, customerType,
    items, total, paidAmount, payStatus, notes, date
  } = req.body;

  if (!date || !items?.length) {
    return res.status(400).json({ error: 'date and items are required' });
  }

  const saleId = uid();

  const { data, error } = await supabase.rpc('create_sale', {
    p_user_id:       req.userId,
    p_id:            saleId,
    p_customer_id:   customerId  || null,
    p_customer_name: customerName || 'Walk-in / Cash',
    p_customer_type: customerType || '',
    p_total:         total || 0,
    p_paid_amount:   paidAmount || 0,
    p_pay_status:    payStatus || 'paid',
    p_notes:         notes || '',
    p_date:          date,
    p_items:         items
  });

  if (error) return res.status(500).json({ error: error.message });

  const { data: full, error: fetchErr } = await supabase
    .from('sales')
    .select('*, items:sale_items(*)')
    .eq('id', saleId)
    .single();

  if (fetchErr) return res.status(500).json({ error: fetchErr.message });

  const result = toCamel(full);
  result.items = (full.items || []).map(toCamel);
  res.status(201).json(result);
});

// DELETE /api/sales/:id  — deletes sale and restores stock atomically
router.delete('/:id', async (req, res) => {
  const { data, error } = await supabase.rpc('delete_sale', {
    p_sale_id: req.params.id,
    p_user_id: req.userId
  });
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Sale not found' });
  res.json({ success: true });
});

module.exports = router;
