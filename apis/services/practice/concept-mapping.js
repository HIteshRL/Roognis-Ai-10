'use strict';
const { createHash } = require('node:crypto');
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

// A label is never a global identity. Prefer a curriculum-owned RAG identity;
// a teacher-reviewed fallback is namespaced by curriculum and chapter.
function resolveConcept(label, { chapter = {}, chunks = [], sourceChunkIds = [], approvedCatalog = [], allowTeacherProposal = false } = {}) {
  const key = normalize(label);
  if (!key) return null;
  const catalog = [...(chapter.conceptCatalog || []), ...approvedCatalog];
  const matches = catalog.filter(row => normalize(row.label) === key || (row.aliases || []).some(alias => normalize(alias) === key));
  const ids = [...new Set(matches.map(row => row.conceptId).filter(Boolean))];
  if (ids.length === 1) return ids[0];
  if (ids.length > 1) return null;
  const referenced = chunks.filter(row => sourceChunkIds.includes(row.chunkId));
  const canonical = [...new Set(referenced.map(row => row.canonicalConceptId).filter(Boolean))];
  if (referenced.length && referenced.every(row => row.canonicalConceptId) && canonical.length === 1) return canonical[0];
  if (!allowTeacherProposal) return null;
  const scope = ['schoolId', 'board', 'curriculum', 'grade', 'subject', 'book', 'chapterNumber', 'chapterName', 'edition', 'language']
    .map(field => normalize(chapter[field]));
  if (!scope[0] || !normalize(chapter.subject)) return null;
  return 'concept:approved:' + createHash('sha256').update(JSON.stringify([...scope, key])).digest('hex').slice(0, 40);
}
module.exports = { resolveConcept, normalize };
