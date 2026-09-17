const crypto = require('crypto');
const jwt = require('jsonwebtoken');

function requireInternalToken(req, res, next) {
  const expected = Buffer.from(process.env.INTERNAL_SERVICE_TOKEN || '');
  const actual = Buffer.from(String(req.headers['x-internal-service-token'] || ''));
  if (!expected.length) return res.status(500).json({ error: 'Internal service token is not configured.' });
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return res.status(401).json({ error: 'Unauthorized' });
  return next();
}

function requireAuth(req, res, next) {
  const token = req.cookies?.jwt;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!payload.userId || !payload.schoolId) throw new Error('Incomplete token');
    req.actor = { principalId: payload.userId, schoolId: payload.schoolId, legacyRole: payload.role || '' };
    return next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function requestHash(value) { return crypto.createHash('sha256').update(stableJson(value)).digest('hex'); }
function isUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function slug(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }

module.exports = { requireInternalToken, requireAuth, requestHash, isUuid, slug };
