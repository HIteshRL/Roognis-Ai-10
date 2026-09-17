const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const token = req.cookies?.jwt;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (_err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

requireAuth.requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role))
    return res.status(403).json({ error: 'Forbidden' });
  next();
};

module.exports = requireAuth;
