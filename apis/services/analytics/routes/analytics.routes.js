const express = require('express');
const prisma = require('../lib/prisma');
const requireAuth = require('../middleware/auth');
const requireInternalToken = require('../middleware/internal-token');
const {
  KNOWN_EVENT_TYPES,
  isValidUuid,
  parseDateOnly,
  validateEventType,
  validateAttendanceStatus,
  validateScorePair,
  normalizeSubject,
  normalizeOptionalString,
} = require('../lib/validation');
const {
  findStudentUser,
  assertStudentInSchool,
  assertTeacherCanAccessStudent,
  assertParentCanAccessStudent,
  getTeacherAssignedStudentIds,
  getSchoolStudentIds,
} = require('../lib/student-access');
const {
  RECENT_EVENT_LIMIT,
  daysAgo,
  sanitizeEvent,
  buildAttendanceSummary,
  buildScoreSummary,
  buildUsageSummary,
  buildSubjectTrends,
  buildStudentDashboard,
  buildTeacherDashboard,
  buildParentDashboard,
} = require('../lib/dashboard');
const {
  buildInterventionsForStudents,
  groupEventsByStudent,
  evaluateInterventionFlags,
} = require('../lib/interventions');

const router = express.Router();

const teacherOnly = [requireAuth, requireAuth.requireRole('teacher')];
const parentOnly  = [requireAuth, requireAuth.requireRole('parent')];
const studentOnly = [requireAuth, requireAuth.requireRole('student')];

// POST /api/analytics/event — internal fire-and-forget ingestion
router.post('/event', requireInternalToken, async (req, res) => {
  try {
    const { type, studentId, schoolId, subject, sessionId, metadata } = req.body || {};

    const normalizedType = validateEventType(type);
    if (!normalizedType) {
      return res.status(400).json({
        error: `type must be one of: ${KNOWN_EVENT_TYPES.join(', ')}.`,
      });
    }

    if (!isValidUuid(schoolId))
      return res.status(400).json({ error: 'schoolId must be a valid UUID.' });

    if (studentId && !isValidUuid(studentId))
      return res.status(400).json({ error: 'studentId must be a valid UUID.' });

    if (sessionId && !isValidUuid(sessionId))
      return res.status(400).json({ error: 'sessionId must be a valid UUID.' });

    await prisma.event.create({
      data: {
        type: normalizedType,
        studentId: studentId || null,
        schoolId,
        subject: typeof subject === 'string' ? subject.trim() || null : null,
        sessionId: sessionId || null,
        metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {},
      },
    });

    return res.status(202).json({ received: true });
  } catch (err) {
    console.error('[analytics] event error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/analytics/student/activity — student-authenticated active-time tracking
router.post('/student/activity', ...studentOnly, async (req, res) => {
  try {
    const activeSeconds = Number(req.body?.activeSeconds);
    if (!Number.isFinite(activeSeconds) || activeSeconds < 5 || activeSeconds > 600) {
      return res.status(400).json({ error: 'activeSeconds must be between 5 and 600.' });
    }

    const subject = normalizeSubject(req.body?.subject);
    const route = normalizeOptionalString(req.body?.route, 80);

    await prisma.event.create({
      data: {
        type: 'study_time_tracked',
        studentId: req.user.userId,
        schoolId: req.user.schoolId,
        subject,
        metadata: {
          activeSeconds: Math.round(activeSeconds),
          route,
        },
      },
    });

    return res.status(202).json({ received: true });
  } catch (err) {
    console.error('[analytics] student activity error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/analytics/class/assign — assign student to teacher class
router.post('/class/assign', ...teacherOnly, async (req, res) => {
  try {
    const { studentId, className, subject } = req.body || {};
    const normalizedSubject = normalizeSubject(subject);

    const access = await assertStudentInSchool(prisma, studentId, req.user.schoolId);
    if (access.error) return res.status(access.status).json({ error: access.error });

    const assignment = await prisma.classAssignment.upsert({
      where: {
        teacherId_studentId_subject: {
          teacherId: req.user.userId,
          studentId,
          subject: normalizedSubject,
        },
      },
      create: {
        schoolId: req.user.schoolId,
        teacherId: req.user.userId,
        studentId,
        className: normalizeOptionalString(className, 120),
        subject: normalizedSubject,
      },
      update: {
        className: normalizeOptionalString(className, 120),
      },
      select: { id: true },
    });

    return res.status(201).json({ assignmentId: assignment.id });
  } catch (err) {
    console.error('[analytics] class assign error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/analytics/attendance — mark attendance (teacher only)
router.post('/attendance', ...teacherOnly, async (req, res) => {
  try {
    const { studentId, date, status } = req.body || {};

    const access = await assertTeacherCanAccessStudent(prisma, req.user, studentId);
    if (access.error) return res.status(access.status).json({ error: access.error });

    const attendanceDate = parseDateOnly(date);
    if (!attendanceDate)
      return res.status(400).json({ error: 'date must be in YYYY-MM-DD format.' });

    const normalizedStatus = validateAttendanceStatus(status);
    if (!normalizedStatus)
      return res.status(400).json({ error: 'status must be one of: present, absent, late, excused.' });

    const record = await prisma.attendance.upsert({
      where: {
        studentId_date: {
          studentId,
          date: attendanceDate,
        },
      },
      create: {
        studentId,
        schoolId: req.user.schoolId,
        teacherId: req.user.userId,
        date: attendanceDate,
        status: normalizedStatus,
      },
      update: {
        status: normalizedStatus,
        teacherId: req.user.userId,
      },
      select: { id: true },
    });

    return res.status(201).json({ attendanceId: record.id });
  } catch (err) {
    console.error('[analytics] attendance error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/analytics/score — enter test score (teacher only)
router.post('/score', ...teacherOnly, async (req, res) => {
  try {
    const { studentId, subject, testName, score, maxScore, testDate } = req.body || {};

    const access = await assertTeacherCanAccessStudent(prisma, req.user, studentId);
    if (access.error) return res.status(access.status).json({ error: access.error });

    const normalizedSubject = normalizeOptionalString(subject, 80);
    const normalizedTestName = normalizeOptionalString(testName, 120);
    if (!normalizedSubject)
      return res.status(400).json({ error: 'subject is required.' });
    if (!normalizedTestName)
      return res.status(400).json({ error: 'testName is required.' });

    const scoreValidation = validateScorePair(score, maxScore);
    if (scoreValidation.error)
      return res.status(400).json({ error: scoreValidation.error });

    const parsedTestDate = parseDateOnly(testDate);
    if (!parsedTestDate)
      return res.status(400).json({ error: 'testDate must be in YYYY-MM-DD format.' });

    const record = await prisma.score.create({
      data: {
        studentId,
        schoolId: req.user.schoolId,
        teacherId: req.user.userId,
        subject: normalizedSubject,
        testName: normalizedTestName,
        score: scoreValidation.score,
        maxScore: scoreValidation.maxScore,
        testDate: parsedTestDate,
      },
      select: { id: true },
    });

    return res.status(201).json({ scoreId: record.id });
  } catch (err) {
    console.error('[analytics] score error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/analytics/student/dashboard
router.get('/student/dashboard', ...studentOnly, async (req, res) => {
  try {
    const since30d = daysAgo(30);
    const events = await prisma.event.findMany({
      where: {
        studentId: req.user.userId,
        schoolId: req.user.schoolId,
        createdAt: { gte: since30d },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    return res.status(200).json(buildStudentDashboard(events, {
      studentId: req.user.userId,
    }));
  } catch (err) {
    console.error('[analytics] student dashboard error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/analytics/student/:studentId
router.get('/student/:studentId', requireAuth, async (req, res) => {
  try {
    const { studentId } = req.params;

    if (req.user.role === 'teacher') {
      const access = await assertTeacherCanAccessStudent(prisma, req.user, studentId);
      if (access.error) return res.status(access.status).json({ error: access.error });
    } else if (req.user.role === 'parent') {
      const access = await assertParentCanAccessStudent(req.user, studentId);
      if (access.error) return res.status(access.status).json({ error: access.error });
    } else {
      return res.status(403).json({ error: 'Forbidden.' });
    }

    const since7d = daysAgo(7);

    const [attendance, scores, events] = await Promise.all([
      prisma.attendance.findMany({
        where: { studentId, schoolId: req.user.schoolId },
        orderBy: { date: 'desc' },
        take: RECENT_EVENT_LIMIT,
      }),
      prisma.score.findMany({
        where: { studentId, schoolId: req.user.schoolId },
        orderBy: { testDate: 'desc' },
        take: RECENT_EVENT_LIMIT,
      }),
      prisma.event.findMany({
        where: { studentId, schoolId: req.user.schoolId, createdAt: { gte: since7d } },
        orderBy: { createdAt: 'desc' },
        take: RECENT_EVENT_LIMIT,
      }),
    ]);

    const interventionFlags = evaluateInterventionFlags(events);

    return res.status(200).json({
      studentId,
      attendanceSummary: buildAttendanceSummary(attendance),
      scoreSummary: buildScoreSummary(scores),
      usageSummary: buildUsageSummary(events),
      interventionFlags,
      recentEvents: events.map(sanitizeEvent),
    });
  } catch (err) {
    console.error('[analytics] student profile error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/analytics/teacher/dashboard
router.get('/teacher/dashboard', ...teacherOnly, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const since30d = daysAgo(30);
    let studentIds = await getTeacherAssignedStudentIds(prisma, req.user);
    if (studentIds.length === 0) {
      studentIds = await getSchoolStudentIds(prisma, schoolId);
    }

    const events = studentIds.length === 0 ? [] : await prisma.event.findMany({
      where: {
        schoolId,
        studentId: { in: studentIds },
        createdAt: { gte: since30d },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    return res.status(200).json(buildTeacherDashboard(events, studentIds, { schoolId }));
  } catch (err) {
    console.error('[analytics] teacher dashboard error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/analytics/teacher/interventions
router.get('/teacher/interventions', ...teacherOnly, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const since7d = daysAgo(7);
    let assignedStudentIds = await getTeacherAssignedStudentIds(prisma, req.user);
    if (assignedStudentIds.length === 0) {
      assignedStudentIds = await getSchoolStudentIds(prisma, schoolId);
    }

    const events = assignedStudentIds.length === 0 ? [] : await prisma.event.findMany({
      where: {
        schoolId,
        studentId: { in: assignedStudentIds },
        createdAt: { gte: since7d },
      },
      select: {
        studentId: true,
        type: true,
        sessionId: true,
        metadata: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    const eventsByStudent = groupEventsByStudent(events);
    const interventions = buildInterventionsForStudents(assignedStudentIds, eventsByStudent);

    return res.status(200).json({ schoolId, periodDays: 7, interventions });
  } catch (err) {
    console.error('[analytics] interventions error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/analytics/parent/dashboard?studentId=xxx
router.get('/parent/dashboard', ...parentOnly, async (req, res) => {
  try {
    const { studentId } = req.query;

    if (!studentId)
      return res.status(400).json({ error: 'studentId is required.' });

    const access = await assertParentCanAccessStudent(req.user, studentId);
    if (access.error) return res.status(access.status).json({ error: access.error });

    const student = await findStudentUser(prisma, studentId);
    if (!student || student.role !== 'student')
      return res.status(404).json({ error: 'Student not found.' });
    if (student.schoolId !== req.user.schoolId)
      return res.status(403).json({ error: 'Forbidden.' });

    const since30d = daysAgo(30);
    const events = await prisma.event.findMany({
      where: {
        studentId,
        schoolId: req.user.schoolId,
        createdAt: { gte: since30d },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    return res.status(200).json(buildParentDashboard(events, student));
  } catch (err) {
    console.error('[analytics] parent dashboard error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/analytics/queries/trends
router.get('/queries/trends', ...teacherOnly, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const since30d = daysAgo(30);
    let assignedStudentIds = await getTeacherAssignedStudentIds(prisma, req.user);
    if (assignedStudentIds.length === 0) {
      assignedStudentIds = await getSchoolStudentIds(prisma, schoolId);
    }

    const events = assignedStudentIds.length === 0 ? [] : await prisma.event.findMany({
      where: {
        schoolId,
        studentId: { in: assignedStudentIds },
        createdAt: { gte: since30d },
      },
      select: {
        type: true,
        subject: true,
        studentId: true,
        sessionId: true,
        metadata: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    return res.status(200).json({
      schoolId,
      periodDays: 30,
      usageStats: buildUsageSummary(events),
      subjectTrends: buildSubjectTrends(events),
    });
  } catch (err) {
    console.error('[analytics] queries/trends error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
