/** Types for the existing `format.js` presentation helpers. */

/**
 * Parse an API timestamp as UTC when it carries no timezone designator.
 * Returns null for empty or unparseable input. Every timestamp read anywhere in
 * the app must go through this — see the note in `format.js`.
 */
export declare function parseApiDate(iso?: string | null): Date | null

export declare function initials(name?: string | null): string
export declare function colorFor(seed?: string | null): string
export declare function fmtDate(iso?: string | null, opts?: Intl.DateTimeFormatOptions): string
export declare function fmtDateTime(iso?: string | null): string
export declare function relTime(iso?: string | null): string
export declare function dueLabel(
  iso?: string | null,
): { text: string; tone: 'default' | 'primary' | 'warn' | 'danger' } | null
