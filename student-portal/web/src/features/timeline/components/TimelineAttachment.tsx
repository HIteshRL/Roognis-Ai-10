import type { TimelineAttachmentRef } from '../types/timeline'

const ICON: Readonly<Record<TimelineAttachmentRef['kind'], string>> = {
  link: '🔗',
  file: '📄',
  coursework: '📝',
}

/**
 * Attachments render as links only when a URL exists; otherwise the title is
 * shown as plain text. A link that goes nowhere is worse than no link.
 * External links carry `rel="noreferrer"` — they are teacher-supplied URLs.
 */
export function TimelineAttachment({
  attachment,
}: {
  attachment: TimelineAttachmentRef
}): JSX.Element {
  const content = (
    <>
      <span aria-hidden="true">{ICON[attachment.kind]}</span>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: attachment.url ? 'var(--primary)' : 'var(--text-muted)',
        }}
      >
        {attachment.title}
      </span>
    </>
  )

  if (!attachment.url) {
    return <span className="tl-attach">{content}</span>
  }

  return (
    <a
      className="tl-attach"
      href={attachment.url}
      target="_blank"
      rel="noreferrer noopener"
      title={attachment.url}
    >
      {content}
    </a>
  )
}
