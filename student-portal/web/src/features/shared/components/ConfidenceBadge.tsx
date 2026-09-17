import type { Confidence } from '../types/common'

const band = (score: number): { label: string; color: string } => {
  if (score >= 0.8) return { label: 'High confidence', color: 'var(--emerald-500)' }
  if (score >= 0.55) return { label: 'Moderate confidence', color: 'var(--amber-500)' }
  return { label: 'Low confidence', color: 'var(--text-faint)' }
}

/**
 * A confidence score is meaningless without the sample behind it, so the meter
 * always states both. The numeric value and the basis go into the accessible
 * name; the bar is decorative.
 */
export function ConfidenceBadge({
  confidence,
  compact = false,
}: {
  confidence: Confidence
  compact?: boolean
}): JSX.Element {
  const clamped = Math.max(0, Math.min(1, confidence.score))
  const { label, color } = band(clamped)
  const percent = Math.round(clamped * 100)
  const description = `${label}: ${percent}% from ${confidence.sampleSize} observations. ${confidence.basis}`

  return (
    <span className="conf" title={description} aria-label={description}>
      <span className="conf-meter" aria-hidden="true">
        <span className="conf-fill" style={{ width: `${percent}%`, background: color }} />
      </span>
      <span className="tiny" style={{ color: 'var(--text-muted)', fontWeight: 600 }}>
        {percent}%{compact ? '' : ` · n=${confidence.sampleSize}`}
      </span>
    </span>
  )
}
