/**
 * The Academic Premium palette, as literal values, for sandboxed documents only.
 *
 * ── Why this file has to exist ─────────────────────────────────────────────
 * An explainer renders inside `<iframe sandbox="allow-scripts">` with no
 * `allow-same-origin`, which gives it an opaque origin. That is exactly what
 * makes it safe, and it is also why it cannot see the parent's stylesheet: CSS
 * custom properties do not cross a document boundary. `var(--ap-ink)` inside
 * the frame resolves to nothing.
 *
 * So the values must be literal somewhere. `frontend/DESIGN.md` §9 invariant 5
 * forbids hard-coded hex precisely because it survives a theme swap — the bug
 * it records is hex *scattered across call sites*. One file that every
 * sandboxed document is built from keeps that invariant's intent: a palette
 * change is still a single edit, and it is greppable. This is a documented
 * exception, not an oversight, and the pairing is the cost of the sandbox.
 *
 * Mirrored from the `:root` and `:root[data-theme="dark"]` blocks in
 * frontend/index.html. If those change, this changes with them — nothing
 * enforces that automatically, which is the honest weakness of the approach.
 *
 * The model never sees these and never picks a colour. It writes markup that
 * refers to the variables by name; the values come from here.
 */

/** Only these names are exposed to an explainer. A short, stable vocabulary. */
const TOKEN_NAMES = [
  'bg', 'surface', 'surface-2', 'ink', 'ink-muted',
  'line', 'line-strong', 'accent', 'accent-ink', 'accent-soft',
  'green', 'blue', 'amber', 'red',
];

const LIGHT_TOKENS = {
  bg: '#f9f7f3',
  surface: '#ffffff',
  'surface-2': '#f2ece1',
  ink: '#1a2d47',
  'ink-muted': '#5f5248',
  line: '#e4dbcc',
  'line-strong': '#d8ccb8',
  accent: '#c4965f',
  'accent-ink': '#1a2d47',
  'accent-soft': '#f3e4d0',
  green: '#4a7c59',
  blue: '#3d5a80',
  amber: '#a8752e',
  red: '#a4453b',
};

const DARK_TOKENS = {
  bg: '#0f1826',
  surface: '#16233a',
  'surface-2': '#1c2c47',
  ink: '#f2ede4',
  'ink-muted': '#b9ac9d',
  line: '#2b3a56',
  'line-strong': '#3a4c6c',
  accent: '#d3a874',
  'accent-ink': '#14213a',
  'accent-soft': '#2b2419',
  green: '#6ea37c',
  blue: '#6f93b8',
  amber: '#d19b4f',
  red: '#c6685c',
};

/** Font stacks, minus the webfonts — a CSP of `default-src 'none'` blocks those. */
const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

function declarationsFor(tokens) {
  return TOKEN_NAMES.map(name => `  --${name}: ${tokens[name]};`).join('\n');
}

/**
 * The `:root` block for a sandboxed document.
 *
 * Both palettes are always emitted, in three layers, because the frame can be
 * themed three different ways and only one of them is under our control:
 *   - `:root` carries light, so there is always a defined value;
 *   - `prefers-color-scheme: dark` covers the case where the caller passed no
 *     theme at all;
 *   - `:root[data-theme="…"]` wins over both, and is what the parent stamps.
 *
 * Emitting only the caller's theme would look correct and then be wrong the
 * moment a student switched themes with a visual already open.
 */
function themeStyleBlock() {
  return [
    ':root {',
    declarationsFor(LIGHT_TOKENS),
    `  --font-body: ${FONT_STACK};`,
    '  color-scheme: light dark;',
    '}',
    '@media (prefers-color-scheme: dark) {',
    '  :root:not([data-theme="light"]) {',
    declarationsFor(DARK_TOKENS).replace(/^/gm, '  '),
    '  }',
    '}',
    ':root[data-theme="dark"] {',
    declarationsFor(DARK_TOKENS),
    '}',
    ':root[data-theme="light"] {',
    declarationsFor(LIGHT_TOKENS),
    '}',
  ].join('\n');
}

/** `dark` and `light` are the only values that reach the markup. */
function normalizeTheme(value) {
  const theme = String(value || '').trim().toLowerCase();
  return theme === 'dark' || theme === 'light' ? theme : '';
}

module.exports = {
  TOKEN_NAMES,
  LIGHT_TOKENS,
  DARK_TOKENS,
  FONT_STACK,
  themeStyleBlock,
  normalizeTheme,
};
