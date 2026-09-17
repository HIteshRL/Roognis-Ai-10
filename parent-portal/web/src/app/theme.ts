import type { StatusTone, ThemeMode } from "./routePolicy";

export const THEME_ORDER: readonly ThemeMode[] = ["system", "light", "dark"];

export function nextTheme(mode: ThemeMode): ThemeMode {
  const index = THEME_ORDER.indexOf(mode);
  return THEME_ORDER[(index + 1) % THEME_ORDER.length] || "system";
}

/** Converts service status vocabulary into the small set of visual meanings
 * used by the product. Callers still render the original status label. */
export function statusToneFor(value: string | null | undefined): StatusTone {
  const normalized = String(value || "").toLowerCase();
  if (["not returned", "not_returned", "graded not returned", "graded_not_returned", "awaiting feedback", "awaiting_feedback"].some((token) => normalized.includes(token))) return "warning";
  if (["success", "done", "complete", "completed", "returned", "approved", "live"].some((token) => normalized.includes(token))) return "success";
  if (["danger", "error", "failed", "overdue", "missing", "blocked"].some((token) => normalized.includes(token))) return "danger";
  if (["warning", "warn", "pending", "draft", "scheduled", "generating", "review"].some((token) => normalized.includes(token))) return "warning";
  if (["info", "assigned", "published", "turned_in", "in progress"].some((token) => normalized.includes(token))) return "info";
  return "neutral";
}
