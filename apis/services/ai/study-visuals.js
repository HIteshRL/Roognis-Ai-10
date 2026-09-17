'use strict';

/**
 * Deterministic art direction for chapter-aware, decorative study visuals.
 *
 * This module deliberately receives only authoritative chapter fields. It never
 * sees learner names, answers, chat messages, grades, engagement telemetry, or
 * any other personal learning data. A visual may change when the published
 * chapter changes, but it must not become a portrait of a learner.
 */
const crypto = require('node:crypto');

const SAFE_THEMES = new Set(['light', 'dark']);

const BASE_CONSTRAINTS = [
  'abstract educational visual for a modern learning product',
  'editorial composition made from opaque solid-color materials, crisp geometric forms, layered cards, precise lines, and tactile paper-like shapes',
  'high contrast warm palette using cream, charcoal, saffron, terracotta, coral, berry, brass, and restrained teal accents',
  'do not use gradients, blue-dominant or purple-dominant color fields, photographs, or photorealism',
  'no text, letters, numbers, equations, logos, labels, watermarks, or UI controls',
  'no people, faces, children, characters, avatars, mascots, hands, animals, plants, leaves, flowers, trees, landscapes, or natural scenery',
  'no books, globes, clocks, compasses, desks, classrooms, laboratory props, or unrelated decorative objects',
  'no confetti, celebrations, progress trails, stock-illustration clutter, or random imagery',
  'leave deliberate quiet space around the outer edges so the visual can sit inside a responsive interface',
].join('. ');

const SUBJECT_PROFILES = [
  {
    matches: [/math|algebra|geometry|calculus|statistics|numeracy/],
    key: 'mathematics',
    composition: 'interlocking coordinate lattices, measured arcs, tessellated planes, modular blocks, and balanced intersections',
    palette: 'saffron, terracotta, cream, charcoal, and a small coral accent',
  },
  {
    matches: [/english|literature|language|grammar|writing|reading|hindi|sanskrit|french|spanish/],
    key: 'language',
    composition: 'rhythmic typographic-inspired marks with no readable characters, stacked paper fragments, punctuation-like geometry, narrative waves, and paced line systems',
    palette: 'berry, clay, cream, charcoal, and saffron',
  },
  {
    matches: [/history|geography|civics|political|economics|social/],
    key: 'social-studies',
    composition: 'timeline strata, route-like line systems, archival blocks, map-grid abstractions, civic networks, and layered chronology without literal maps or globes',
    palette: 'ochre, terracotta, charcoal, cream, and coral',
  },
  {
    matches: [/computer|coding|programming|technology|informatics/],
    key: 'technology',
    composition: 'modular logic gates, signal paths, stacked interface-like planes without UI text, discrete nodes, and clean system diagrams',
    palette: 'charcoal, cream, coral, saffron, and restrained teal',
  },
  {
    matches: [/physics|chemistry|biology|science|environmental/],
    key: 'science',
    composition: 'field lines, orbital paths, translucent-free solid layers, cellular grids, particles, molecular spacing, and experiment-like diagram logic without literal objects',
    palette: 'coral, brass, charcoal, cream, and restrained teal',
  },
  {
    matches: [/art|design|music|drama/],
    key: 'creative',
    composition: 'expressive cut-paper geometry, rhythmic lines, balanced asymmetry, framed color planes, and motion-like arcs without literal instruments or paint tools',
    palette: 'coral, berry, saffron, cream, and charcoal',
  },
];

const DEFAULT_PROFILE = {
  key: 'general',
  composition: 'layered learning paths, modular card planes, measured arcs, dot fields, and diagrammatic connections',
  palette: 'cream, charcoal, saffron, terracotta, coral, and restrained teal',
};

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeStudyVisualTheme(value) {
  return SAFE_THEMES.has(value) ? value : 'light';
}

function subjectVisualProfile(subject) {
  const normalized = cleanText(subject, 80).toLowerCase();
  return SUBJECT_PROFILES.find(profile => profile.matches.some(pattern => pattern.test(normalized))) || DEFAULT_PROFILE;
}

function stableSeed(value) {
  const hash = crypto.createHash('sha256').update(value).digest();
  // ComfyUI and OpenAI-compatible image servers accept a positive 32-bit seed.
  return hash.readUInt32BE(0) & 0x7fffffff;
}

function visualKeyFor({ studentId, documentId, learningVersionId, contentFingerprint, subject, chapterName, theme, state }) {
  const identity = [
    cleanText(studentId, 80),
    cleanText(documentId, 80),
    cleanText(learningVersionId, 80),
    cleanText(contentFingerprint, 80),
    cleanText(subject, 80).toLowerCase(),
    cleanText(chapterName, 160).toLowerCase(),
    normalizeStudyVisualTheme(theme),
    state === 'resume' ? 'resume' : 'active',
    'study-visual-v1',
  ].join('|');
  return crypto.createHash('sha256').update(identity).digest('hex');
}

function buildStudyVisualPrompt({ subject, chapterName, theme, visualKey, state }) {
  const profile = subjectVisualProfile(subject);
  const normalizedTheme = normalizeStudyVisualTheme(theme);
  const chapter = cleanText(chapterName, 160) || 'the current chapter';
  const subjectLabel = cleanText(subject, 80) || 'general learning';
  const mode = state === 'resume'
    ? 'quiet continuation energy: forms are gathering into a clear next step'
    : 'focused study energy: forms are actively resolving into a coherent idea';

  return [
    BASE_CONSTRAINTS,
    `Subject family: ${profile.key}.`,
    `Chapter inspiration: ${chapter} in ${subjectLabel}; interpret the idea abstractly and do not render the chapter title as text.`,
    `Primary composition: ${profile.composition}.`,
    `Palette direction: ${profile.palette}.`,
    `Surface mode: ${normalizedTheme === 'dark' ? 'deep espresso or charcoal solid ground with luminous warm solid accents' : 'warm cream solid ground with dark ink and warm solid accents'}.`,
    `Motion implication only: ${mode}; render a single still frame with no motion blur.`,
    `Deterministic composition seed: ${stableSeed(visualKey || `${subjectLabel}|${chapter}|${normalizedTheme}`)}.`,
  ].join('\n');
}

function studyVisualPlan(input) {
  const theme = normalizeStudyVisualTheme(input?.theme);
  const state = input?.state === 'resume' ? 'resume' : 'active';
  const visualKey = visualKeyFor({ ...input, theme, state });
  const profile = subjectVisualProfile(input?.subject);
  return {
    visualKey,
    seed: stableSeed(visualKey),
    theme,
    state,
    profile: profile.key,
    prompt: buildStudyVisualPrompt({ ...input, theme, state, visualKey }),
  };
}

module.exports = {
  BASE_CONSTRAINTS,
  DEFAULT_PROFILE,
  SUBJECT_PROFILES,
  normalizeStudyVisualTheme,
  subjectVisualProfile,
  stableSeed,
  visualKeyFor,
  buildStudyVisualPrompt,
  studyVisualPlan,
};
