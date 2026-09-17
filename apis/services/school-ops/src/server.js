const express = require('express');
const cookieParser = require('cookie-parser');
const { PrismaClient } = require('@prisma/client');
const { randomUUID } = require('crypto');
const { requireAuth, requireInternalToken, requestHash, isUuid, slug } = require('./security');
const { workflowData, TEMPLATES } = require('./workflows');

const prisma = new PrismaClient();
const app = express();
const PORT = Number(process.env.PORT || 3015);
app.set('trust proxy', 1); app.use(express.json({ limit: '1mb' })); app.use(cookieParser());

function correlation(req) { return String(req.headers['x-correlation-id'] || randomUUID()); }
function key(req) { const value = String(req.headers['idempotency-key'] || ''); if (!value || value.length > 255) throw new Error('Idempotency-Key header is required.'); return value; }
async function emit(tx, values) { return tx.outboxEvent.create({ data: { id: randomUUID(), ...values } }); }
async function audit(tx, values) { return tx.auditEvent.create({ data: { id: randomUUID(), ...values } }); }
async function idempotent(req, res, scope, execute) {
  let idempotencyKey; try { idempotencyKey = key(req); } catch (error) { return res.status(400).json({ error: error.message }); }
  const hash = requestHash(req.body || {});
  try { await prisma.idempotencyRecord.create({ data: { id: randomUUID(), scope, key: idempotencyKey, requestHash: hash } }); }
  catch (error) {
    const prior = await prisma.idempotencyRecord.findUnique({ where: { scope_key: { scope, key: idempotencyKey } } });
    if (!prior || prior.requestHash !== hash) return res.status(409).json({ error: 'Idempotency key was already used for a different request.' });
    if (prior.status === 'PROCESSING') return res.status(202).json({ status: 'processing' });
    return res.status(prior.responseCode || 200).json(prior.responseBody);
  }
  try { const result = await execute(idempotencyKey); await prisma.idempotencyRecord.update({ where: { scope_key: { scope, key: idempotencyKey } }, data: { status: 'COMPLETED', responseCode: result.status, responseBody: result.body } }); return res.status(result.status).json(result.body); }
  catch (error) { await prisma.idempotencyRecord.delete({ where: { scope_key: { scope, key: idempotencyKey } } }).catch(() => {}); throw error; }
}
async function admin(req, res, next) {
  const schoolId = String(req.params.schoolId || req.body.schoolId || req.query.schoolId || '');
  if (!isUuid(schoolId) || schoolId !== req.actor.schoolId) return res.status(403).json({ error: 'Forbidden' });
  const membership = await prisma.schoolMembership.findFirst({ where: { schoolId, principalId: req.actor.principalId, status: 'ACTIVE', roles: { some: { role: 'SCHOOL_ADMIN', revokedAt: null } } } });
  if (!membership) return res.status(403).json({ error: 'School administrator role required.' });
  req.membership = membership; return next();
}

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'school-ops', version: '0.1.0' }));
app.get('/health/ready', async (_req, res) => { try { await prisma.$queryRawUnsafe('SELECT 1'); res.json({ status: 'ok', service: 'school-ops' }); } catch { res.status(503).json({ status: 'unavailable' }); } });
app.get('/internal/v1/meta/capabilities', requireInternalToken, (_req, res) => res.json({ version: 'v1', capabilities: ['membership-context', 'authorization-check', 'outbox-v1'] }));
app.get('/internal/v1/memberships/:membershipId/context', requireInternalToken, async (req, res) => { const row = await prisma.schoolMembership.findUnique({ where: { id: req.params.membershipId }, include: { roles: { where: { revokedAt: null } } } }); if (!row) return res.status(404).json({ error: 'Not found' }); return res.json({ membershipId: row.id, schoolId: row.schoolId, principalId: row.principalId, status: row.status, authzVersion: row.authzVersion, roles: row.roles.map(item => item.role) }); });
app.post('/internal/v1/authorization/check', requireInternalToken, async (req, res) => { const { schoolId, principalId, capability } = req.body || {}; const row = await prisma.schoolMembership.findFirst({ where: { schoolId, principalId, status: 'ACTIVE', roles: { some: { role: capability, revokedAt: null } } } }); return res.json({ allowed: Boolean(row), membershipId: row?.id, authzVersion: row?.authzVersion }); });
app.post('/api/school-ops/internal/v1/schools', requireInternalToken, async (req, res, next) => { try { return await idempotent(req, res, 'internal:school-bootstrap', async (idempotencyKey) => { const displayName = String(req.body.displayName || '').trim(); const schoolSlug = slug(req.body.slug); const principalId = req.body.administratorPrincipalId; if (!displayName || !schoolSlug || !isUuid(principalId)) return { status: 400, body: { error: 'displayName, slug, and administratorPrincipalId are required.' } }; const correlationId = correlation(req); const result = await prisma.$transaction(async tx => { const school = await tx.school.create({ data: { id: randomUUID(), displayName, legalName: req.body.legalName || null, slug: schoolSlug, policy: req.body.policy || {} } }); const membership = await tx.schoolMembership.create({ data: { id: randomUUID(), schoolId: school.id, principalId, status: 'ACTIVE', source: 'platform_bootstrap' } }); await tx.roleGrant.create({ data: { id: randomUUID(), membershipId: membership.id, role: 'SCHOOL_ADMIN', grantedBy: principalId } }); await emit(tx, { schoolId: school.id, eventType: 'schoolops.school.created.v1', subjectType: 'school', subjectId: school.id, correlationId, payload: { status: school.status } }); await audit(tx, { schoolId: school.id, actorId: principalId, action: 'school.bootstrap', targetType: 'school', targetId: school.id, outcome: 'success', correlationId }); return { school, membership }; }); return { status: 201, body: { schoolId: result.school.id, membershipId: result.membership.id, status: result.school.status, idempotencyKey } }; }); } catch (error) { return next(error); } });
app.use('/api/school-ops/v1', requireAuth);
app.get('/api/school-ops/v1/schools/:schoolId', admin, async (req, res) => res.json(await prisma.school.findUnique({ where: { id: req.params.schoolId } })));
app.post('/api/school-ops/v1/schools/:schoolId/memberships', admin, async (req, res, next) => { try { return await idempotent(req, res, `membership:${req.params.schoolId}`, async () => { const { principalId, role } = req.body; if (!isUuid(principalId) || !['SCHOOL_ADMIN','TEACHER','STUDENT','GUARDIAN','READ_ONLY'].includes(role)) return { status: 400, body: { error: 'Valid principalId and role are required.' } }; const correlationId = correlation(req); const membership = await prisma.$transaction(async tx => { const member = await tx.schoolMembership.upsert({ where: { schoolId_principalId: { schoolId: req.params.schoolId, principalId } }, create: { id: randomUUID(), schoolId: req.params.schoolId, principalId, status: 'INVITED' }, update: { authzVersion: { increment: 1 } } }); await tx.roleGrant.upsert({ where: { membershipId_role_scopeType_scopeId: { membershipId: member.id, role, scopeType: 'school', scopeId: null } }, create: { id: randomUUID(), membershipId: member.id, role }, update: { revokedAt: null } }); await emit(tx, { schoolId: req.params.schoolId, eventType: 'schoolops.membership.changed.v1', subjectType: 'membership', subjectId: member.id, correlationId, payload: { authzVersion: member.authzVersion, change: 'role-granted' } }); return member; }); return { status: 201, body: { membershipId: membership.id, status: membership.status, authzVersion: membership.authzVersion } }; }); } catch (error) { return next(error); } });
app.get('/api/school-ops/v1/schools/:schoolId/memberships', admin, async (req, res) => res.json(await prisma.schoolMembership.findMany({ where: { schoolId: req.params.schoolId }, include: { roles: { where: { revokedAt: null } } }, orderBy: { createdAt: 'asc' } })));
app.get('/api/school-ops/v1/automations', requireAuth, (_req, res) => res.json({ templates: Object.keys(TEMPLATES) }));
app.use((error, _req, res, _next) => { console.error('[school-ops] request failed:', error); res.status(error.code === 'P2002' ? 409 : 500).json({ error: error.code === 'P2002' ? 'Conflicting record.' : 'Internal server error' }); });
app.listen(PORT, () => console.log(`[school-ops] API listening on :${PORT}`));
