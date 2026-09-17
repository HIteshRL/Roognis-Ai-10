const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildStudentDashboard,
  buildTeacherDashboard,
  buildParentDashboard,
} = require('../lib/dashboard');

const now = new Date('2026-07-10T10:00:00.000Z');

function event(overrides) {
  return {
    id: overrides.id || `${overrides.type}-${overrides.studentId || 'student'}`,
    type: overrides.type,
    studentId: overrides.studentId || 'student-1',
    schoolId: 'school-1',
    subject: overrides.subject || 'Science',
    sessionId: overrides.sessionId || null,
    metadata: overrides.metadata || {},
    createdAt: overrides.createdAt || now,
  };
}

describe('dashboard builders', () => {
  it('builds student progress from learning events', () => {
    const dashboard = buildStudentDashboard([
      event({ type: 'chat_message', createdAt: now }),
      event({ type: 'image_generated', createdAt: now }),
      event({ type: 'quiz_submitted', createdAt: now, metadata: { quizId: 'q1' } }),
      event({
        type: 'quiz_graded',
        createdAt: now,
        metadata: { quizId: 'q1', score: 3, maxScore: 5, weakArea: 'Photosynthesis equation' },
      }),
    ], { studentId: 'student-1', now });

    assert.equal(dashboard.studentId, 'student-1');
    assert.equal(dashboard.learningStreakDays, 1);
    assert.equal(dashboard.timeSpentSecondsThisWeek, 0);
    assert.equal(dashboard.practiceProgressPercent, 60);
    assert.equal(dashboard.lessonsCompletedThisWeek, 1);
    assert.equal(dashboard.weakAreas[0].label, 'Photosynthesis equation');
  });

  it('builds teacher dashboard without attendance data', () => {
    const dashboard = buildTeacherDashboard([
      event({ type: 'chat_message', studentId: 'student-1', createdAt: now }),
      event({ type: 'video_recommended', studentId: 'student-2', createdAt: now }),
      event({ type: 'quiz_published', studentId: 'student-1', metadata: { quizId: 'q1', quizTitle: 'Plants quiz' }, createdAt: now }),
      event({ type: 'quiz_graded', studentId: 'student-1', metadata: { quizId: 'q1', scorePercent: 80 }, createdAt: now }),
    ], ['student-1', 'student-2'], { schoolId: 'school-1', now });

    assert.equal(dashboard.studentCount, 2);
    assert.equal(dashboard.usageStats.activeStudents7d, 2);
    assert.equal(dashboard.activeQuiz.title, 'Plants quiz');
    assert.equal(dashboard.activeQuiz.averageScorePercent, 80);
    assert.ok(dashboard.lessonEngagement.find(item => item.key === 'videos').count > 0);
  });

  it('counts only explicit active seconds for study time', () => {
    const dashboard = buildStudentDashboard([
      event({ type: 'chat_message', createdAt: now }),
      event({ type: 'study_time_tracked', createdAt: now, metadata: { activeSeconds: 45 } }),
    ], { studentId: 'student-1', now });

    assert.equal(dashboard.timeSpentSecondsThisWeek, 45);
  });

  it('counts generated visuals alongside diffusion images as diagram activity', () => {
    // `visual_generated` (structured SVG) and `image_generated` (diffusion) are
    // two producers for one idea. If the new type were missing from
    // LEARNING_EVENT_TYPES it would be filtered out before ever reaching
    // buildCourseProgress, and the counter would silently not move.
    const dashboard = buildStudentDashboard([
      event({ type: 'image_generated', createdAt: now }),
      event({ type: 'visual_generated', createdAt: now, metadata: { visualKind: 'concept_map' } }),
    ], { studentId: 'student-1', now });

    const science = dashboard.courseProgress.find(entry => entry.subject === 'Science');
    assert.equal(science.diagramCount, 2);
    assert.equal(science.activityCount, 2);

    const teacher = buildTeacherDashboard([
      event({ type: 'image_generated', studentId: 'student-1', createdAt: now }),
      event({ type: 'visual_generated', studentId: 'student-2', createdAt: now }),
    ], ['student-1', 'student-2'], { schoolId: 'school-1', now });

    assert.equal(teacher.lessonEngagement.find(item => item.key === 'diagrams').count, 2);
  });

  it('builds parent summary for a linked child', () => {
    const dashboard = buildParentDashboard([
      event({ type: 'chat_message', createdAt: now }),
      event({ type: 'quiz_opened', metadata: { quizId: 'q1' }, createdAt: now }),
    ], { id: 'student-1', name: 'Arjun Sharma' }, { now });

    assert.equal(dashboard.studentName, 'Arjun Sharma');
    assert.equal(dashboard.learningStreakDays, 1);
    assert.equal(dashboard.assignedQuizStatus, 'Opened');
  });

  it('rolls up weak areas from instant-practice completions alongside gated-quiz grading', () => {
    // practice_completed comes from services/practice, a separate ungated
    // pipeline from the quiz_graded events above. weakAreasFromEvent reads
    // metadata.weakAreas off any event unconditionally, so this only works if
    // practice_completed also clears LEARNING_EVENT_TYPES — if it were
    // missing there, this would silently count toward nothing.
    const dashboard = buildTeacherDashboard([
      event({
        type: 'quiz_graded',
        studentId: 'student-1',
        metadata: { quizId: 'q1', scorePercent: 80, weakArea: 'Photosynthesis equation' },
        createdAt: now,
      }),
      event({
        type: 'practice_completed',
        studentId: 'student-2',
        metadata: { practiceSetId: 'p1', weakAreas: ['Photosynthesis equation', 'Cell structure'] },
        createdAt: now,
      }),
    ], ['student-1', 'student-2'], { schoolId: 'school-1', now });

    const photosynthesis = dashboard.weakAreas.find(area => area.label === 'Photosynthesis equation');
    assert.equal(photosynthesis.count, 2);
    assert.ok(dashboard.weakAreas.find(area => area.label === 'Cell structure'));
  });

  it('rolls discover_article_dwell\'s durationSeconds into timeSpentSecondsThisWeek', () => {
    // discover_article_dwell carries no activeSeconds/timeSpentSeconds key of its
    // own — it fires durationSeconds (services/discover/server.js), which
    // eventActiveSeconds() already reads generically. This only works at all if
    // discover_article_dwell is in LEARNING_EVENT_TYPES; if it were missing the
    // event would be filtered out before eventActiveSeconds ever saw it and this
    // would silently read 0.
    const dashboard = buildStudentDashboard([
      event({ type: 'chat_message', createdAt: now }),
      event({ type: 'discover_article_dwell', createdAt: now, metadata: { articleId: 'a1', category: 'science', durationSeconds: 42 } }),
    ], { studentId: 'student-1', now });

    assert.equal(dashboard.timeSpentSecondsThisWeek, 42);
  });

  it('rolls discover_headline_dwell\'s durationSeconds into timeSpentSecondsThisWeek too, additively with discover_article_dwell', () => {
    // Both discover_article_dwell and discover_headline_dwell are listed in
    // LEARNING_EVENT_TYPES (services/discover/server.js fires durationSeconds
    // in both), so both roll into the same generic sum — there is no separate
    // "glance time" bucket in this dashboard number, by design (see the
    // KNOWN_EVENT_TYPES comment in lib/validation.js for the distinction
    // between the two event types themselves).
    const dashboard = buildStudentDashboard([
      event({ type: 'discover_article_dwell', createdAt: now, metadata: { articleId: 'a1', category: 'science', durationSeconds: 42 } }),
      event({ type: 'discover_headline_dwell', createdAt: now, metadata: { articleId: 'a2', category: 'science', durationSeconds: 5 } }),
    ], { studentId: 'student-1', now });

    assert.equal(dashboard.timeSpentSecondsThisWeek, 47);
  });

  it('buildLessonEngagement\'s 5th "discover" bucket counts discover_article_opened events', () => {
    // Added alongside tutor_chat/diagrams/videos/practice_quiz. This list is a
    // plain .map() in frontend/index.html with no nth-of-type colour mapping
    // (that constraint applies only to the unrelated 4-card .dashboard-grid
    // summary strip), so a 5th entry here is safe.
    const dashboard = buildTeacherDashboard([
      event({ type: 'discover_article_opened', studentId: 'student-1', metadata: { category: 'science' }, createdAt: now }),
      event({ type: 'discover_article_opened', studentId: 'student-2', metadata: { category: 'sports' }, createdAt: now }),
      event({ type: 'chat_message', studentId: 'student-1', createdAt: now }),
    ], ['student-1', 'student-2'], { schoolId: 'school-1', now });

    const discover = dashboard.lessonEngagement.find(item => item.key === 'discover');
    assert.ok(discover, 'expected a "discover" entry in lessonEngagement');
    assert.equal(discover.label, 'Discover reading');
    assert.equal(discover.count, 2);
  });
});
