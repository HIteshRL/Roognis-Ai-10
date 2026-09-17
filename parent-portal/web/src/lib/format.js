// Small presentation helpers shared across screens.

export function initials(name) {
  if (!name) return '?'
  const parts = String(name).trim().split(/\s+/)
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}

// Deterministic, pleasant avatar/classroom colour from any id/string.
const PALETTE = ['#4f46e5', '#0ea5e9', '#059669', '#d97706', '#db2777', '#7c3aed', '#0891b2', '#ca8a04']
export function colorFor(seed) {
  const s = String(seed || '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

// Timestamps arrive as UTC, but not always labelled as such. Python's
// `datetime.isoformat()` emits an offset only when the value is timezone-aware:
// under Postgres (`DateTime(timezone=True)`) it appends `+00:00`, while SQLite
// hands back naive datetimes and the offset is simply missing. JavaScript then
// reads an unlabelled date-time as *local* time, so the same record renders
// hours apart depending on which database is behind the API.
//
// Everything below parses through here, so a bare timestamp is read as the UTC
// it actually is. Strings that already carry `Z` or an offset are untouched.
const HAS_TZ = /(?:Z|[+-]\d{2}:?\d{2})$/i
const IS_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

export function parseApiDate(iso) {
  if (!iso) return null
  const raw = String(iso)
  const normalised = IS_DATE_TIME.test(raw) && !HAS_TZ.test(raw) ? `${raw}Z` : raw
  const d = new Date(normalised)
  return Number.isNaN(d.getTime()) ? null : d
}

export function fmtDate(iso, opts) {
  const d = parseApiDate(iso)
  if (!d) return ''
  return d.toLocaleDateString(undefined, opts || { month: 'short', day: 'numeric', year: 'numeric' })
}

export function fmtDateTime(iso) {
  const d = parseApiDate(iso)
  if (!d) return ''
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function relTime(iso) {
  const d = parseApiDate(iso)
  if (!d) return ''
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`
  return fmtDate(iso)
}

export function dueLabel(iso) {
  const d = parseApiDate(iso)
  if (!d) return null
  const now = new Date()
  const days = Math.round((d - now) / 86400000)
  if (days < 0) return { text: `Overdue · ${fmtDate(iso)}`, tone: 'danger' }
  if (days === 0) return { text: 'Due today', tone: 'warn' }
  if (days === 1) return { text: 'Due tomorrow', tone: 'warn' }
  if (days <= 7) return { text: `Due in ${days} days`, tone: 'primary' }
  return { text: `Due ${fmtDate(iso)}`, tone: 'default' }
}
