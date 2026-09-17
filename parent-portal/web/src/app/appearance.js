const APPEARANCE_STORAGE_KEY = "roognis-appearance";
const THEME_STORAGE_KEY = "roognis-theme";

export const SYSTEM_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

export const FONT_STACKS = {
  system: SYSTEM_FONT_STACK,
  source:
    '"Source Sans 3", "Noto Sans Devanagari", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  rounded:
    'ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  serif: 'ui-serif, Georgia, "Times New Roman", serif',
};

export const DEFAULT_APPEARANCE = Object.freeze({
  accent: "",
  accentPreset: "custom",
  background: "",
  foreground: "",
  uiFont: "system",
  contentFont: "system",
  translucentSidebar: false,
  contrast: 100,
});

export function normaliseHex(value) {
  return /^#[0-9a-f]{6}$/i.test(value || "") ? value.toUpperCase() : "";
}

export function readAppearance() {
  if (typeof window === "undefined") return { ...DEFAULT_APPEARANCE };
  try {
    const stored = JSON.parse(window.localStorage.getItem(APPEARANCE_STORAGE_KEY) || "{}");
    const next = {
      ...DEFAULT_APPEARANCE,
      ...(stored && typeof stored === "object" ? stored : {}),
    };
    const storedContrast = Number(next.contrast);
    return {
      ...next,
      accent: normaliseHex(next.accent),
      background: normaliseHex(next.background),
      foreground: normaliseHex(next.foreground),
      uiFont: FONT_STACKS[next.uiFont] ? next.uiFont : DEFAULT_APPEARANCE.uiFont,
      contentFont: FONT_STACKS[next.contentFont] ? next.contentFont : DEFAULT_APPEARANCE.contentFont,
      translucentSidebar: Boolean(next.translucentSidebar),
      contrast: Number.isFinite(storedContrast)
        ? Math.max(0, Math.min(100, storedContrast))
        : DEFAULT_APPEARANCE.contrast,
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function saveAppearance(appearance) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // Private browsing and storage quotas should not make settings unusable.
  }
}

export function readTheme() {
  if (typeof window === "undefined") return "system";
  try {
    const theme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return ["system", "light", "dark"].includes(theme) ? theme : "system";
  } catch {
    return "system";
  }
}

export function saveTheme(theme) {
  if (typeof window === "undefined") return;
  try {
    if (theme === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Optional preference; the in-memory setting still applies.
  }
}

function setOrRemove(root, property, value) {
  if (value) root.style.setProperty(property, value);
  else root.style.removeProperty(property);
}

export function applyAppearance(appearance = readAppearance()) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const accent = normaliseHex(appearance.accent);
  const background = normaliseHex(appearance.background);
  const foreground = normaliseHex(appearance.foreground);
  const uiFont = FONT_STACKS[appearance.uiFont] || SYSTEM_FONT_STACK;
  const contentFont = FONT_STACKS[appearance.contentFont] || SYSTEM_FONT_STACK;
  const rawContrast = Number(appearance.contrast);
  const contrast = Number.isFinite(rawContrast)
    ? Math.max(0, Math.min(100, rawContrast))
    : DEFAULT_APPEARANCE.contrast;

  setOrRemove(root, "--color-action", accent);
  setOrRemove(root, "--primary", accent);
  setOrRemove(root, "--color-action-hover", accent && `color-mix(in srgb, ${accent} 82%, white)`);
  setOrRemove(root, "--primary-hover", accent && `color-mix(in srgb, ${accent} 82%, white)`);
  setOrRemove(root, "--color-link", accent);
  setOrRemove(root, "--indigo-500", accent);
  setOrRemove(root, "--indigo-600", accent);
  setOrRemove(root, "--color-action-soft", accent && `color-mix(in srgb, ${accent} 16%, transparent)`);
  setOrRemove(root, "--primary-soft", accent && `color-mix(in srgb, ${accent} 16%, transparent)`);
  setOrRemove(root, "--color-bg", background);
  setOrRemove(root, "--bg", background);
  setOrRemove(root, "--color-text", foreground);
  setOrRemove(root, "--text", foreground);
  setOrRemove(root, "--color-focus", accent);
  root.style.setProperty("--font-sans", uiFont);
  root.style.setProperty("--font", uiFont);
  root.style.setProperty("--font-content", contentFont);
  root.style.setProperty("--font-display", contentFont);
  root.style.setProperty("--appearance-contrast", String(contrast));
  root.dataset.sidebarTranslucent = String(Boolean(appearance.translucentSidebar));
  root.dataset.highContrast = String(contrast >= 50);
}

export { APPEARANCE_STORAGE_KEY, THEME_STORAGE_KEY };
