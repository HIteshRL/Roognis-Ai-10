const crypto = require('crypto');

/**
 * Service-to-service only. Matches services/practice's and services/discover's
 * requireInternalToken in shape and status codes (500 unconfigured, 401
 * mismatch), but compares with crypto.timingSafeEqual rather than `!==` —
 * cheap to do right in new code, even though existing copies elsewhere use
 * the non-constant-time comparison (a separate, already-flagged risk in
 * those files, not something to propagate into a new one).
 */
function requireInternalToken(req, res, next) {
  const configured = process.env.INTERNAL_SERVICE_TOKEN;
  if (!configured) {
    return res.status(500).json({ error: 'Internal service token not configured.' });
  }

  const provided = Buffer.from(String(req.headers['x-internal-service-token'] || ''));
  const expected = Buffer.from(configured);
  const matches = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  if (!matches) return res.status(401).json({ error: 'Unauthorized' });

  next();
}

module.exports = requireInternalToken;
