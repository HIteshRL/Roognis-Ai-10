function validatePassword(password) {
  const value = String(password || '');
  if (value === 'demo1234') throw new Error('The public demo password cannot be used.');
  if (value.length < 10) throw new Error('Password must be at least 10 characters.');
  return value;
}

function normalizeProvisionRequest(body = {}) {
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const role = String(body.role || '').trim().toLowerCase();
  if (name.length < 2 || name.length > 120) throw new Error('Name must be between 2 and 120 characters.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid email address is required.');
  if (!['student', 'parent'].includes(role)) throw new Error('Teachers can provision only student or parent accounts.');
  return { name, email, role, password: validatePassword(body.password) };
}

module.exports = { normalizeProvisionRequest, validatePassword };
