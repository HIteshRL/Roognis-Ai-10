const DEMO_PASSWORD = 'demo1234';

function resolveBootstrapConfig(env = process.env) {
  if (env.SEED_DEMO_USERS === 'true') {
    if (!env.DEMO_SCHOOL_ID) throw new Error('DEMO_SCHOOL_ID is required when demo seeding is enabled.');
    return {
      mode: 'demo',
      schoolId: env.DEMO_SCHOOL_ID,
      schoolName: 'Demo School',
    };
  }

  if (env.BOOTSTRAP_ENABLED !== 'true') return { mode: 'disabled' };

  const required = [
    'BOOTSTRAP_SCHOOL_ID',
    'BOOTSTRAP_SCHOOL_NAME',
    'BOOTSTRAP_TEACHER_NAME',
    'BOOTSTRAP_TEACHER_EMAIL',
    'BOOTSTRAP_TEACHER_PASSWORD',
  ];
  const missing = required.filter(key => !String(env[key] || '').trim());
  if (missing.length) throw new Error(`Missing production bootstrap values: ${missing.join(', ')}`);

  const password = String(env.BOOTSTRAP_TEACHER_PASSWORD);
  if (password.length < 12 || password === DEMO_PASSWORD) {
    throw new Error('BOOTSTRAP_TEACHER_PASSWORD must be at least 12 characters and cannot be the demo password.');
  }

  const email = String(env.BOOTSTRAP_TEACHER_EMAIL).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('BOOTSTRAP_TEACHER_EMAIL must be a valid email address.');
  }

  return {
    mode: 'production',
    schoolId: String(env.BOOTSTRAP_SCHOOL_ID).trim(),
    schoolName: String(env.BOOTSTRAP_SCHOOL_NAME).trim(),
    teacherName: String(env.BOOTSTRAP_TEACHER_NAME).trim(),
    teacherEmail: email,
    teacherPassword: password,
  };
}

module.exports = { resolveBootstrapConfig };
