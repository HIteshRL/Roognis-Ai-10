const { isValidUuid } = require('./validation');
const { authStudentDirectory } = require('./auth-student-directory');

async function findStudentUser(_prisma, studentId, schoolId, studentDirectory = authStudentDirectory) {
  return studentDirectory.findStudentInSchool(studentId, schoolId);
}

async function assertStudentInSchool(prisma, studentId, schoolId, studentDirectory = authStudentDirectory) {
  if (!isValidUuid(studentId))
    return { status: 400, error: 'studentId must be a valid UUID.' };

  const student = await findStudentUser(prisma, studentId, schoolId, studentDirectory);
  if (!student)
    return { status: 404, error: 'Student not found.' };
  if (student.forbidden)
    return { status: 403, error: 'Forbidden.' };

  return { student };
}

async function assertTeacherCanAccessStudent(prisma, teacher, studentId, studentDirectory = authStudentDirectory) {
  const schoolCheck = await assertStudentInSchool(prisma, studentId, teacher.schoolId, studentDirectory);
  if (schoolCheck.error) return schoolCheck;

  const assignment = await prisma.classAssignment.findFirst({
    where: {
      teacherId: teacher.userId,
      studentId,
      schoolId: teacher.schoolId,
    },
  });

  if (!assignment)
    return { status: 404, error: 'Student is not assigned to your class.' };

  return { student: schoolCheck.student, assignment };
}

async function assertParentCanAccessStudent(parent, studentId) {
  if (!isValidUuid(studentId))
    return { status: 400, error: 'studentId must be a valid UUID.' };

  if (!parent.studentIds?.includes(studentId))
    return { status: 403, error: 'Forbidden.' };

  return { ok: true };
}

async function getTeacherAssignedStudentIds(prisma, teacher) {
  const assignments = await prisma.classAssignment.findMany({
    where: {
      teacherId: teacher.userId,
      schoolId: teacher.schoolId,
    },
    select: { studentId: true },
  });

  return [...new Set(assignments.map(a => a.studentId))];
}

async function getSchoolStudentIds(_prisma, schoolId, studentDirectory = authStudentDirectory) {
  return studentDirectory.listStudentIdsInSchool(schoolId);
}

module.exports = {
  findStudentUser,
  assertStudentInSchool,
  assertTeacherCanAccessStudent,
  assertParentCanAccessStudent,
  getTeacherAssignedStudentIds,
  getSchoolStudentIds,
};
