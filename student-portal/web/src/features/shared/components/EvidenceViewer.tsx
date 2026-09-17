import { Link } from 'react-router-dom'
import { fmtDateTime } from '../../../lib/format'
import type { Evidence, EvidenceRef, Provenance } from '../types/common'

const linkFor = (ref: EvidenceRef): string | null => {
  switch (ref.kind) {
    case 'coursework':
      return ref.classroomId ? `/classes/${ref.classroomId}/work/${ref.id}` : null
    case 'classroom':
      return `/classes/${ref.id}`
    case 'announcement':
      return ref.classroomId ? `/classes/${ref.classroomId}/timeline` : null
    case 'student':
      return `/interventions?student=${encodeURIComponent(ref.id)}`
    case 'submission':
      return null
    default:
      return null
  }
}

/**
 * The §7 explainability contract, rendered.
 *
 * Every derived claim in this product must be able to show the records that
 * produced it and the ruleset version that read them. Where the evidence points
 * at something the teacher can open, it is a link — a claim you can't verify is
 * a claim you shouldn't act on.
 */
export function EvidenceViewer({
  evidence,
  provenance,
}: {
  evidence: readonly Evidence[]
  provenance: Provenance
}): JSX.Element {
  return (
    <div className="evidence">
      <div className="evidence-head small" style={{ fontWeight: 700 }}>
        Evidence · {evidence.length} {evidence.length === 1 ? 'record' : 'records'}
      </div>

      <ol className="evidence-list">
        {evidence.map((item) => {
          const href = item.ref ? linkFor(item.ref) : null
          return (
            <li key={item.id}>
              <div className="small" style={{ fontWeight: 600 }}>
                {href ? (
                  <Link to={href} className="evidence-link">
                    {item.label}
                  </Link>
                ) : (
                  item.label
                )}
              </div>
              <div className="tiny muted">{item.detail}</div>
              <div className="tiny faint">{fmtDateTime(item.observedAt)}</div>
            </li>
          )
        })}
      </ol>

      <div className="evidence-prov tiny faint">
        <span>
          Ruleset <code>{provenance.rulesetVersion}</code>
        </span>
        <span>
          Gate <code>{provenance.gateVersion}</code>
        </span>
        <span>
          Source <code>{provenance.source}</code>
        </span>
        <span>Computed {fmtDateTime(provenance.computedAt)}</span>
      </div>
    </div>
  )
}
