const { randomUUID } = require('crypto');

const TEMPLATES = {
  new_school_launch: ['school-created', 'await-auth-admin-provisioning'],
  new_admission: ['directory-recorded', 'await-auth-principal', 'await-lms-roster'],
  guardian_follow_up: ['guardian-reminder-requested'],
  roster_import: ['import-validated', 'await-lms-reconciliation'],
};

function stepsFor(templateKey) {
  const steps = TEMPLATES[templateKey];
  if (!steps) throw new Error('Unsupported workflow template.');
  return steps.map((stepKey, position) => ({ position, stepKey, status: position === 0 ? 'COMPLETED' : 'WAITING_EXTERNAL', output: position === 0 ? { completedAt: new Date().toISOString() } : {} }));
}
function workflowData({ schoolId, templateKey, idempotencyKey, input, actorId, correlationId = randomUUID() }) {
  const steps = stepsFor(templateKey);
  return {
    run: { schoolId, templateKey, status: steps.length === 1 ? 'COMPLETED' : 'WAITING_EXTERNAL', input, correlationId, idempotencyKey, createdBy: actorId || null },
    steps: { create: steps },
  };
}
module.exports = { TEMPLATES, workflowData };
