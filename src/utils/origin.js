const { URL } = require('url');

function sanitizeBase(raw) {
  if (!raw) return null;
  const trimmed = raw
    .toString()
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, '')
    .replace(/\/+/g, '/');
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  return withoutTrailingSlash || null;
}

function buildSafeOrigin() {
  const raw = process.env.CHECKOUT_BASE_URL || process.env.VERCEL_URL || '';
  const compact = sanitizeBase(raw);
  if (!compact) throw new Error('Missing CHECKOUT_BASE_URL/VERCEL_URL');
  const origin = compact.startsWith('http') ? compact : `https://${compact}`;
  new URL(origin); // throws if invalid
  return origin;
}

function sanitizeOrigin(raw) {
  const compact = sanitizeBase(raw);
  if (!compact) return null;
  const origin = compact.startsWith('http') ? compact : `https://${compact}`;
  try {
    new URL(origin);
    return origin;
  } catch {
    return null;
  }
}

module.exports = {
  buildSafeOrigin,
  sanitizeOrigin,
};
