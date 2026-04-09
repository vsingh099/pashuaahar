'use strict';
const supabase = require('./db');

/**
 * JWT middleware — reads Authorization: Bearer <token>,
 * verifies it with Supabase, attaches req.userId.
 */
module.exports = async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  const token = header.slice(7);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.userId = user.id;
  next();
};
