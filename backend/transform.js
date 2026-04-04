'use strict';

/** snake_case object → camelCase (deep) */
function toCamel(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
      Array.isArray(v) ? v.map(toCamel) : (v && typeof v === 'object' ? toCamel(v) : v)
    ])
  );
}

/** camelCase object → snake_case (shallow — for DB inserts) */
function toSnake(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k.replace(/([A-Z])/g, '_$1').toLowerCase(),
      v
    ])
  );
}

module.exports = { toCamel, toSnake };
