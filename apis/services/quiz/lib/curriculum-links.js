'use strict';
function validateCurriculumLinks(input, conceptIds) {
  if (!Array.isArray(input) || input.length > 100) throw new Error('Invalid prerequisite links');
  const allowed = new Set(conceptIds);
  const links = [], seen = new Set();
  for (const row of input) {
    if (!row || !allowed.has(row.fromConceptId) || !allowed.has(row.toConceptId) || row.fromConceptId === row.toConceptId) throw new Error('Prerequisites must link distinct reviewed concepts in this quiz');
    const key = row.fromConceptId + ':' + row.toConceptId;
    if (seen.has(key)) continue;
    seen.add(key); links.push({ fromConceptId: row.fromConceptId, toConceptId: row.toConceptId });
  }
  const visiting = new Set(), visited = new Set();
  function walk(id) {
    if (visiting.has(id)) throw new Error('Prerequisite links cannot contain a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const row of links.filter(item => item.fromConceptId === id)) walk(row.toConceptId);
    visiting.delete(id); visited.add(id);
  }
  for (const id of allowed) walk(id);
  return links;
}
module.exports = { validateCurriculumLinks };
