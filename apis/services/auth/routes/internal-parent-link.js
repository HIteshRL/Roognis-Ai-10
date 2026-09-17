/**
 * Build the service-to-service handler used by LMS after it has validated a
 * guardian-code redemption. Auth remains the authority for parent/student
 * authorization: LMS must never write auth_db.parent_student itself.
 */
function createInternalParentLinkHandler(prisma) {
  return async function internalParentLink(req, res) {
    try {
      const { parentId, studentId, schoolId } = req.body || {};
      if (!parentId || !studentId || !schoolId) {
        return res.status(400).json({ error: 'parentId, studentId, and schoolId are required.' });
      }

      const [parent, student] = await Promise.all([
        prisma.user.findUnique({ where: { id: parentId } }),
        prisma.user.findUnique({ where: { id: studentId } }),
      ]);

      if (!parent || parent.role !== 'parent' || parent.schoolId !== schoolId) {
        return res.status(400).json({ error: 'parentId does not reference a valid parent account in that school.' });
      }
      if (!student || student.role !== 'student' || student.schoolId !== schoolId) {
        return res.status(400).json({ error: 'studentId does not reference a valid student account in that school.' });
      }

      // A retry after an uncertain LMS→Auth response must not create a second
      // authorization relationship or turn an already-established link into a
      // failure. The composite PK is the database backstop for this upsert.
      await prisma.parentStudent.upsert({
        where: { parentId_studentId: { parentId, studentId } },
        create: { parentId, studentId },
        update: {},
      });

      return res.status(200).json({ message: 'Parent-student link established.' });
    } catch (err) {
      console.error('[auth] internal link-parent error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

module.exports = { createInternalParentLinkHandler };
