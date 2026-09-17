import { TIMELINE_FILTERS, type TimelineFilterId } from '../types/timeline'

/**
 * Filter chips plus the search box.
 *
 * Each chip carries the count it would produce, so a teacher can see there are
 * no pinned posts without clicking to find an empty list. Chips are toggle
 * buttons with `aria-pressed`, not links, because the URL is not changing.
 */
export function TimelineFilters({
  filter,
  counts,
  search,
  onFilterChange,
  onSearchChange,
}: {
  filter: TimelineFilterId
  counts: Readonly<Record<TimelineFilterId, number>>
  search: string
  onFilterChange: (filter: TimelineFilterId) => void
  onSearchChange: (value: string) => void
}): JSX.Element {
  return (
    <div className="col" style={{ gap: 11, marginBottom: 16 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div className="grow" style={{ position: 'relative', minWidth: 220 }}>
          <label className="tiny faint" htmlFor="timeline-search" style={{ position: 'absolute', left: -9999 }}>
            Search this timeline
          </label>
          <input
            id="timeline-search"
            className="input"
            type="search"
            value={search}
            placeholder="Search posts, work and attachments…"
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>
      </div>

      <div className="chip-bar" role="group" aria-label="Filter the timeline">
        {TIMELINE_FILTERS.map((spec) => {
          const count = counts[spec.id] ?? 0
          return (
            <button
              key={spec.id}
              className="chip"
              aria-pressed={filter === spec.id}
              onClick={() => onFilterChange(spec.id)}
              disabled={count === 0 && spec.id !== 'all' && filter !== spec.id}
            >
              {spec.label}
              <span className="chip-count">{count}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
