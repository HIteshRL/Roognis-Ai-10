import { useState } from 'react'
import { Avatar, Loading, useToast } from '../../../components/ui'
import { relTime } from '../../../lib/format'
import { useAuth } from '../../../auth/AuthContext'
import { useMutation } from '../../shared/hooks/useMutation'
import { useQuery } from '../../shared/hooks/useQuery'
import {
  addCommentReaction,
  createComment,
  listComments,
  removeCommentReaction,
} from '../../shared/services/lmsService'
import type { Comment } from '../../shared/types/lms'
import type { TimelineEvent } from '../types/timeline'

/** Reactions the LMS accepts on comments; event-level reactions have no endpoint. */
const REACTIONS = ['👍', '🎉', '🤔'] as const

/**
 * Comments on one timeline event.
 *
 * Loaded on expansion rather than with the timeline: a class with sixty posts
 * would otherwise fire sixty comment requests to render a list nobody has
 * opened.
 *
 * Reactions are real, and are a comment-level feature in `discussions.py`.
 * There is no endpoint for reacting to an announcement or a piece of coursework
 * — that gap is declared as `lms.event-reactions` and surfaced on the card
 * rather than faked here.
 */
export function TimelineComments({ event }: { event: TimelineEvent }): JSX.Element {
  const { user } = useAuth()
  const toast = useToast()
  const [draft, setDraft] = useState('')

  const scope = event.announcementId
    ? { announcementId: event.announcementId }
    : event.courseworkId
      ? { courseworkId: event.courseworkId }
      : {}

  const commentsQuery = useQuery<readonly Comment[]>(
    ['lms', 'comments', event.classroomId, event.id],
    () => listComments(event.classroomId, scope),
    { staleTime: 15_000 },
  )

  const invalidateKey = ['lms', 'comments', event.classroomId, event.id] as const

  const postMutation = useMutation<string, Comment>(
    (body) => createComment(event.classroomId, { body, ...scope }),
    {
      invalidates: [invalidateKey],
      onSuccess: () => setDraft(''),
      onError: (error) => toast.error(error.message),
    },
  )

  const reactionMutation = useMutation<{ commentId: string; emoji: string; active: boolean }, unknown>(
    ({ commentId, emoji, active }) =>
      active ? removeCommentReaction(commentId, emoji) : addCommentReaction(commentId, emoji),
    {
      invalidates: [invalidateKey],
      onError: (error) => toast.error(error.message),
    },
  )

  const comments = commentsQuery.data ?? []

  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: '12px 18px 14px 66px' }}>
      {commentsQuery.status === 'loading' ? (
        <Loading label="Loading comments…" />
      ) : comments.length === 0 ? (
        <div className="tiny faint" style={{ marginBottom: 10 }}>
          No comments yet.
        </div>
      ) : (
        <div className="col" style={{ gap: 12, marginBottom: 12 }}>
          {comments.map((comment) => (
            <div key={comment.id} className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
              <Avatar name={comment.authorName} id={comment.authorId} size="sm" />
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className="small" style={{ fontWeight: 650 }}>
                    {comment.authorName ?? 'User'}
                  </span>
                  <span className="tiny faint">{relTime(comment.createdAt)}</span>
                </div>
                <div className="small" style={{ overflowWrap: 'anywhere' }}>
                  {comment.body}
                </div>

                <div className="row" style={{ gap: 4, marginTop: 5 }}>
                  {REACTIONS.map((emoji) => {
                    const count = comment.reactions?.[emoji] ?? 0
                    return (
                      <button
                        key={emoji}
                        className="chip"
                        style={{ padding: '2px 8px', fontSize: 12 }}
                        aria-pressed={count > 0}
                        aria-label={`React ${emoji}`}
                        disabled={reactionMutation.pending}
                        onClick={() =>
                          void reactionMutation.mutate({
                            commentId: comment.id,
                            emoji,
                            active: count > 0,
                          })
                        }
                      >
                        {emoji}
                        {count > 0 && <span className="chip-count">{count}</span>}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ gap: 8 }}>
        <Avatar name={user?.name} id={user?.userId} size="sm" />
        <input
          className="input"
          value={draft}
          placeholder="Add a class comment…"
          aria-label="Add a class comment"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(keyEvent) => {
            if (keyEvent.key === 'Enter' && draft.trim()) void postMutation.mutate(draft.trim())
          }}
        />
        <button
          className="btn btn-outline btn-sm"
          disabled={!draft.trim() || postMutation.pending}
          onClick={() => void postMutation.mutate(draft.trim())}
        >
          {postMutation.pending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
