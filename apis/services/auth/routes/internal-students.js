/**
 * Deliberately small internal directory projection for Analytics. These
 * handlers do not expose a general user lookup: they only attest that a
 * requested principal is a student in a given school, or return the student
 * IDs for one school. Auth keeps its schema and PII private.
 */
function createInternalStudentHandlers(prisma) {
  async function getStudentInSchool(req, res) {
    const studentId = String(req.params.studentId || '').trim();
    const schoolId = String(req.query.schoolId || '').trim();
    if (!studentId || !schoolId) {
      return res.status(400).json({ error: 'studentId and schoolId are required.' });
    }

    try {
      const student = await prisma.user.findUnique({
        where: { id: studentId },
        select: { id: true, schoolId: true, role: true },
      });
      if (!student || student.role !== 'student') return res.status(404).json({ error: 'Student not found.' });
      // Analytics' existing authorization semantics distinguish an unknown
      // student (404) from a real student outside the caller's school (403).
      // No cross-school data is returned in either case.
      if (student.schoolId !== schoolId) return res.status(403).json({ error: 'Forbidden.' });
      return res.status(200).json({ studentId: student.id, schoolId: student.schoolId });
    } catch (err) {
      console.error('[auth] internal student lookup error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  async function listStudentIdsInSchool(req, res) {
    const schoolId = String(req.params.schoolId || '').trim();
    if (!schoolId) return res.status(400).json({ error: 'schoolId is required.' });

    try {
      const students = await prisma.user.findMany({
        where: { schoolId, role: 'student' },
        select: { id: true },
        orderBy: { name: 'asc' },
      });
      return res.status(200).json({ studentIds: students.map(student => student.id) });
    } catch (err) {
      console.error('[auth] internal school student list error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return { getStudentInSchool, listStudentIdsInSchool };
}

module.exports = { createInternalStudentHandlers };
