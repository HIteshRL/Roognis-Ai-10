'use strict';

const { createHash } = require('node:crypto');

/** See services/quiz/lib/concept-id.js. Keep the versioned algorithm exact. */
function conceptIdForTag(value) {
  const normalized = String(value || '').normalize('NFKD').toLowerCase().trim();
  const slug = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  if (slug) return `concept:v1:${slug}`;
  if (!normalized) return null;
  return `concept:v1:${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`;
}

module.exports = { conceptIdForTag };
