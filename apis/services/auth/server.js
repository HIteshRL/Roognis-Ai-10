const express      = require('express');
const cookieParser = require('cookie-parser');
const { PrismaClient } = require('@prisma/client');

const authRoutes = require('./routes/auth.routes');
const requireInternalToken = require('./middleware/internal-token');
const { createInternalParentLinkHandler } = require('./routes/internal-parent-link');
const { createInternalStudentHandlers } = require('./routes/internal-students');

const app  = express();
const PORT = process.env.PORT || 3001;
const prisma = new PrismaClient();

app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());

// Health check — no auth, used by Docker healthcheck and Traefik
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', service: 'auth' }));

app.use('/api/auth', authRoutes);

// Internal: resolve an email to a user of a given role in a given school
// (used by services/lms's co-teacher-by-email feature, Sprint 1, and its
// student-invite-by-email feature, Sprint 2). Deliberately narrow: 404s
// unless the user has the requested role AND is in the requested school —
// never confirms an email exists in a school (or role) other than the one
// asked about. `role` defaults to 'teacher' to match every caller before
// Sprint 2 without their needing to change.
const LOOKUP_ROLES = new Set(['teacher', 'student']);
app.get('/api/auth/internal/users/by-email', requireInternalToken, async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  const schoolId = String(req.query.schoolId || '').trim();
  const role = String(req.query.role || 'teacher').trim().toLowerCase();
  if (!email || !schoolId) {
    return res.status(400).json({ error: 'email and schoolId are required.' });
  }
  if (!LOOKUP_ROLES.has(role)) {
    return res.status(400).json({ error: `role must be one of ${[...LOOKUP_ROLES].join(', ')}.` });
  }
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.role !== role || user.schoolId !== schoolId) {
      return res.status(404).json({ error: `No ${role} found with that email in that school.` });
    }
    return res.status(200).json({
      userId: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      schoolId: user.schoolId,
    });
  } catch (err) {
    console.error('[auth] internal user lookup error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Service-to-service parent<->student linking, for the guardian-code redeem
// flow (services/lms's guardians.py::redeem_guardian_code). The public
// POST /api/auth/link-parent requires a teacher JWT, so it cannot represent a
// parent redeeming a code through LMS. LMS has already authenticated the
// parent and verified the code; this route is restricted to internal callers
// and makes Auth's parent_student relation authoritative and idempotent.
app.post(
  '/api/auth/internal/link-parent',
  requireInternalToken,
  createInternalParentLinkHandler(prisma),
);

// A narrow directory projection for Analytics. Keep Auth's schema and user
// PII behind this contract; these are intentionally not general user APIs.
const internalStudents = createInternalStudentHandlers(prisma);
app.get('/api/auth/internal/students/:studentId', requireInternalToken, internalStudents.getStudentInSchool);
app.get('/api/auth/internal/schools/:schoolId/students', requireInternalToken, internalStudents.listStudentIdsInSchool);

// Resolve live guardian links. JWT snapshots are not authoritative after revocation.
app.get('/api/auth/internal/parents/:parentId/students', requireInternalToken, async (req,res) => {
  try {
    const parent=await prisma.user.findFirst({where:{id:req.params.parentId,role:'parent',schoolId:String(req.query.schoolId || '')}});
    if(!parent)return res.status(404).json({error:'Parent not found.'});
    const links=await prisma.parentStudent.findMany({where:{parentId:parent.id,student:{schoolId:parent.schoolId}},select:{studentId:true}});
    res.json({studentIds:links.map(link=>link.studentId)});
  } catch(error) {res.status(503).json({error:'Guardian links are temporarily unavailable.'});}
});

// 404 catch-all
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`[auth] Service running on :${PORT}`);
});

// A stray throw outside the request path would otherwise crash the process
// silently under Node's default behavior, taking down every concurrently
// in-flight request with it — worst at peak load, and this is the front
// door every login goes through. Log with full context and exit so the
// container's `restart: unless-stopped` policy brings it back.
process.on('uncaughtException', err => {
  console.error('[auth] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', reason => {
  console.error('[auth] unhandledRejection:', reason);
  process.exit(1);
});
