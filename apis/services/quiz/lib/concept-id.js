'use strict';

const { createHash } = require('node:crypto');

/**
 * Stable v1 fallback identity for teacher-approved concept labels.
 *
 * The KG may later replace this with a curriculum-owned UUID during mapping,
 * but an assessment event must never use free text as its join key.
 */
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

function misconceptionIdFor(conceptId, label) {
  const normalizedConcept = String(conceptId || '').trim();
  const normalizedLabel = String(label || '').normalize('NFKD').toLowerCase().trim();
  if (!normalizedConcept || !normalizedLabel) return null;
  const digest = createHash('sha256')
    .update(`${normalizedConcept}\u0000${normalizedLabel}`)
    .digest('hex')
    .slice(0, 32);
  return `misconception:v1:${digest}`;
}

module.exports = { conceptIdForTag, misconceptionIdFor };
