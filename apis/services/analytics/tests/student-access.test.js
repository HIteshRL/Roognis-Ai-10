const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  assertStudentInSchool,
  assertTeacherCanAccessStudent,
  assertParentCanAccessStudent,
} = require('../lib/student-access');

const SCHOOL_A = '550e8400-e29b-41d4-a716-446655440000';
const SCHOOL_B = '660e8400-e29b-41d4-a716-446655440001';
const STUDENT_A = '770e8400-e29b-41d4-a716-446655440002';
const TEACHER_A = '880e8400-e29b-41d4-a716-446655440003';

function mockPrisma({ assignment = null } = {}) {
  return {
    classAssignment: {
      findFirst: async () => assignment,
    },
  };
}

function mockDirectory(student = null) {
  return { findStudentInSchool: async () => student };
}

describe('student access', () => {
  it('returns 404 for unknown student', async () => {
    const result = await assertStudentInSchool(mockPrisma(), STUDENT_A, SCHOOL_A, mockDirectory());
    assert.equal(result.status, 404);
  });

  it('preserves the cross-school 403 authorization result', async () => {
    const result = await assertStudentInSchool(
      mockPrisma(), STUDENT_A, SCHOOL_A, mockDirectory({ forbidden: true }),
    );
    assert.equal(result.status, 403);
  });

  it('accepts valid student in same school', async () => {
    const result = await assertStudentInSchool(
      mockPrisma(), STUDENT_A, SCHOOL_A, mockDirectory({ studentId: STUDENT_A, schoolId: SCHOOL_A }),
    );
    assert.ok(result.student);
  });

  it('requires class assignment for teacher writes', async () => {
    const prisma = mockPrisma({ assignment: null });
    const teacher = { userId: TEACHER_A, schoolId: SCHOOL_A };
    const result = await assertTeacherCanAccessStudent(
      prisma, teacher, STUDENT_A, mockDirectory({ studentId: STUDENT_A, schoolId: SCHOOL_A }),
    );
    assert.equal(result.status, 404);
  });

  it('allows teacher access for assigned student', async () => {
    const prisma = mockPrisma({ assignment: { id: 'assign-1' } });
    const teacher = { userId: TEACHER_A, schoolId: SCHOOL_A };
    const result = await assertTeacherCanAccessStudent(
      prisma, teacher, STUDENT_A, mockDirectory({ studentId: STUDENT_A, schoolId: SCHOOL_A }),
    );
    assert.ok(result.student);
    assert.ok(result.assignment);
  });

  it('allows parent access only for linked children', async () => {
    const parent = { studentIds: [STUDENT_A] };
    assert.ok(!(await assertParentCanAccessStudent(parent, STUDENT_A)).error);
    assert.equal((await assertParentCanAccessStudent(parent, TEACHER_A)).status, 403);
  });
});
