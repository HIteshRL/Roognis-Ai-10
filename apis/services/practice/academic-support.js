'use strict';
async function loadAcademicSupport({ studentId, schoolId, url, token, fetchImpl = fetch }) {
  if (!url || !token) return [];
  try {
    const params = new URLSearchParams({ studentId, schoolId });
    const response = await fetchImpl(url.replace(/\/+$/, '') + '/api/psv/internal/student-snapshot?' + params, {
      headers: { 'X-Internal-Service-Token': token }, signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return [];
    return ((await response.json()).knowledgeGaps || []).filter(row =>
      typeof row.conceptId === 'string' && Number.isFinite(row.gapScore) && row.evidenceCount > 0
      && Date.now() - new Date(row.computedAt).getTime() < 7 * 86400000);
  } catch (_) { return []; }
}
function orderPractice(items, support) {
  const gaps = new Map(support.map(row => [row.conceptId, row.gapScore]));
  return [...items].sort((a, b) => (gaps.get(b.conceptId) || 0) - (gaps.get(a.conceptId) || 0));
}
function supportForChapter(chapter, support) {
  return support.flatMap(row => {
    const concept = (chapter.conceptCatalog || []).find(item => item.conceptId === row.conceptId);
    return concept ? [{ label: concept.label, conceptId: row.conceptId,
      nextDifficulty: ['simple', 'medium', 'hard'].includes(row.nextDifficulty) ? row.nextDifficulty : 'simple',
      scaffold: ['worked_example', 'completion_problem', 'bare_problem'].includes(row.scaffold) ? row.scaffold : 'completion_problem',
      gapScore: row.gapScore, computedAt: row.computedAt, decisionSource: row.decisionSource }] : [];
  });
}
module.exports = { loadAcademicSupport, orderPractice, supportForChapter };
