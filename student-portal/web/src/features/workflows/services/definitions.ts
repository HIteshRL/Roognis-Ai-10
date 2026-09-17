/**
 * The declared automation chains, implemented against real endpoints.
 *
 * Each step states what it actually did. Two facts about `services/lms` shape
 * these definitions and are worth stating plainly, because both are easy to
 * assume wrongly:
 *
 *  - Publishing coursework fires an analytics event but does **not** notify
 *    students (`main.py:403`). Only announcements notify, via
 *    `stream.py::_notify_students`. So "student notified" is a real, separate
 *    announcement post — not a side effect someone hoped for.
 *  - The calendar is a *view* over coursework due dates (`calendar_view.py`),
 *    not a separate store. Setting a due date is what puts work on the
 *    calendar; there is nothing else to write.
 */

import { fmtDateTime } from '../../../lib/format'
import { CAPABILITIES } from '../../shared/services/capability'
import {
  createAnnouncement,
  createCoursework,
  publishCoursework,
} from '../../shared/services/lmsService'
import { analyseMaterial, generateLesson, generateWorksheet, requestQuizApproval } from './aiService'
import type { WorkflowDefinition } from '../types/workflow'

/* ── Inputs ───────────────────────────────────────────────────────────────── */

export interface CreateWorkInput {
  readonly classroomId: string
  readonly classroomName: string
  readonly title: string
  readonly description: string
  readonly dueAt: string | null
  readonly maxPoints: number | null
  readonly announceToClass: boolean
}

export interface UploadMaterialInput {
  readonly classroomId: string
  readonly classroomName: string
  readonly title: string
  readonly description: string
  readonly url: string
}

export interface AnnouncementInput {
  readonly classroomId: string
  readonly classroomName: string
  readonly title: string
  readonly body: string
  readonly pin: boolean
}

const blockedBy = (capability: keyof typeof CAPABILITIES) => ({
  kind: 'blocked' as const,
  capability,
  detail: `${CAPABILITIES[capability].service} · ${CAPABILITIES[capability].endpoint}`,
})

const dueLine = (dueAt: string | null): string =>
  dueAt
    ? `Due ${fmtDateTime(dueAt)} — now on the class calendar.`
    : 'No due date set, so it will not appear on the calendar.'

/* ── 1. Assignment / quiz created ─────────────────────────────────────────── */

/**
 * Assignment Created → Timeline updated → Calendar updated → Student notified
 *                   → AI predicts completion difficulty
 */
export const createAssignmentWorkflow = (
  type: 'assignment' | 'quiz',
): WorkflowDefinition<CreateWorkInput> => ({
  id: type === 'quiz' ? 'create-quiz' : 'create-assignment',
  title: type === 'quiz' ? 'Create quiz' : 'Create assignment',
  description:
    'Creates the work, publishes it to the class timeline and calendar, and notifies students.',
  steps: [
    {
      id: 'create',
      title: 'Create the work',
      description: 'Writes the coursework record in the LMS.',
      run: async ({ input }) => {
        const created = await createCoursework(input.classroomId, {
          type,
          title: input.title,
          description: input.description,
          ...(input.dueAt ? { dueAt: input.dueAt } : {}),
          ...(input.maxPoints !== null ? { maxPoints: input.maxPoints } : {}),
        })
        return {
          kind: 'done',
          detail: `Created “${created.title}” as a draft.`,
          output: { courseworkId: created.id, courseworkTitle: created.title },
        }
      },
    },
    {
      id: 'publish',
      title: 'Publish to the timeline',
      description: 'Publishing makes it visible to students and puts it on the class timeline.',
      run: async ({ output }) => {
        const courseworkId = output.courseworkId
        if (!courseworkId) return { kind: 'skipped', detail: 'No coursework was created.' }
        await publishCoursework(courseworkId)
        return { kind: 'done', detail: 'Published — students can see it now.' }
      },
    },
    {
      id: 'calendar',
      title: 'Update the calendar',
      description: 'The calendar is a view over due dates; setting one is what schedules the work.',
      run: async ({ input }) => ({
        kind: input.dueAt ? 'done' : 'skipped',
        detail: dueLine(input.dueAt),
      }),
    },
    {
      id: 'notify',
      title: 'Notify students',
      description:
        'Publishing coursework does not notify anyone by itself, so this posts a matching announcement, which does.',
      run: async ({ input, output }) => {
        if (!input.announceToClass) {
          return { kind: 'skipped', detail: 'Announcement not requested — no notification sent.' }
        }
        const title = output.courseworkTitle ?? input.title
        await createAnnouncement(input.classroomId, {
          title: `New ${type}: ${title}`,
          body: input.dueAt
            ? `${input.description || title}\n\nDue ${fmtDateTime(input.dueAt)}.`
            : input.description || title,
        })
        return { kind: 'done', detail: 'Posted to the stream — every enrolled student was notified.' }
      },
    },
    {
      id: 'predict',
      title: 'Predict completion difficulty',
      description:
        'Needs class mastery aggregates to estimate how hard this will land. Gated by the Privacy Guard.',
      requires: 'privacy.class-aggregates',
      run: async () => blockedBy('privacy.class-aggregates'),
    },
  ],
})

/* ── 2. Upload material ───────────────────────────────────────────────────── */

/**
 * Upload Material → AI analyses → Timeline event → Generate lesson
 *                → Generate quiz → Generate worksheet → Teacher approves → Publish
 */
export const uploadMaterialWorkflow: WorkflowDefinition<UploadMaterialInput> = {
  id: 'upload-material',
  title: 'Upload material',
  description:
    'Attaches the material to the class, posts it to the timeline, and runs the generation chain over it.',
  steps: [
    {
      id: 'attach',
      title: 'Attach the material',
      description: 'Creates a material record on the class.',
      run: async ({ input }) => {
        const created = await createCoursework(input.classroomId, {
          type: 'material',
          title: input.title,
          description: input.url ? `${input.description}\n\n${input.url}` : input.description,
        })
        return {
          kind: 'done',
          detail: `Attached “${created.title}”.`,
          output: { courseworkId: created.id, materialTitle: created.title },
        }
      },
    },
    {
      id: 'analyse',
      title: 'Analyse the document',
      description: 'Extracts concepts and reading level so the generators have something to work from.',
      requires: 'ai.document-analysis',
      run: async ({ input }) => {
        const result = await analyseMaterial({
          classroomId: input.classroomId,
          title: input.title,
          ...(input.url ? { url: input.url } : {}),
        })
        if (!result.ok) return blockedBy(result.capability)
        return {
          kind: 'done',
          detail: result.data.summary,
          output: { concepts: result.data.concepts.join(', ') },
        }
      },
    },
    {
      id: 'timeline',
      title: 'Post to the timeline',
      description: 'Publishes the material so it appears in the class stream.',
      run: async ({ input, output }) => {
        const courseworkId = output.courseworkId
        if (!courseworkId) return { kind: 'skipped', detail: 'Nothing was attached.' }
        await publishCoursework(courseworkId)
        await createAnnouncement(input.classroomId, {
          title: `New material: ${input.title}`,
          body: input.description || input.title,
          ...(input.url ? { attachments: [{ url: input.url, title: input.title }] } : {}),
        })
        return { kind: 'done', detail: 'Published and announced to the class.' }
      },
    },
    {
      id: 'lesson',
      title: 'Generate a lesson',
      description: 'Drafts a lesson plan from the extracted concepts.',
      requires: 'ai.lesson-generation',
      run: async ({ input, output }) => {
        const result = await generateLesson({
          classroomId: input.classroomId,
          materialTitle: input.title,
          concepts: output.concepts ? output.concepts.split(', ') : [],
        })
        if (!result.ok) return blockedBy(result.capability)
        return { kind: 'done', detail: `Drafted “${result.data.title}”.`, output: { lessonId: result.data.id } }
      },
    },
    {
      id: 'quiz',
      title: 'Generate a quiz',
      description: 'Drafts quiz items over the same concepts.',
      requires: 'ai.lesson-generation',
      run: async ({ input, output }) => {
        const result = await generateLesson({
          classroomId: input.classroomId,
          materialTitle: `${input.title} (quiz)`,
          concepts: output.concepts ? output.concepts.split(', ') : [],
        })
        if (!result.ok) return blockedBy(result.capability)
        return { kind: 'done', detail: `Drafted “${result.data.title}”.`, output: { quizId: result.data.id } }
      },
    },
    {
      id: 'worksheet',
      title: 'Generate a worksheet',
      description: 'Drafts practice items at the material’s reading level.',
      requires: 'ai.worksheet-generation',
      run: async ({ input, output }) => {
        const result = await generateWorksheet({
          classroomId: input.classroomId,
          materialTitle: input.title,
          concepts: output.concepts ? output.concepts.split(', ') : [],
        })
        if (!result.ok) return blockedBy(result.capability)
        return { kind: 'done', detail: `Drafted “${result.data.title}”.` }
      },
    },
    {
      id: 'approve',
      title: 'Teacher approves',
      description:
        'A generated quiz must be reviewed before students can see it — Quiz.status defaults to pending_review and this calls the real approve endpoint (services/quiz/server.js). Lesson output has no equivalent gate yet, so it skips straight through.',
      manual: true,
      run: async ({ output }) => {
        if (!output.quizId && !output.lessonId) {
          return { kind: 'skipped', detail: 'Nothing was generated, so there is nothing to approve.' }
        }
        if (!output.quizId) {
          return { kind: 'skipped', detail: 'Lesson output has no review gate to run.' }
        }
        const result = await requestQuizApproval(output.quizId)
        return { kind: 'done', detail: `Approved — status: ${result.status}.` }
      },
    },
  ],
}

/* ── 3. Announcement ──────────────────────────────────────────────────────── */

export const announcementWorkflow: WorkflowDefinition<AnnouncementInput> = {
  id: 'post-announcement',
  title: 'Post announcement',
  description: 'Posts to the class stream and notifies every enrolled student.',
  steps: [
    {
      id: 'post',
      title: 'Post to the stream',
      description: 'Creates the announcement and notifies students.',
      run: async ({ input }) => {
        const created = await createAnnouncement(input.classroomId, {
          ...(input.title ? { title: input.title } : {}),
          body: input.body,
        })
        return {
          kind: 'done',
          detail: `Posted to ${input.classroomName} — every enrolled student was notified.`,
          output: { announcementId: created.id },
        }
      },
    },
  ],
}

/* ── 4. Score threshold → inbox → queue → recommendation ──────────────────── */

/**
 * This chain is observational, not executable: it is what the two rulesets
 * already do on every load. It is declared here so the pipeline is documented
 * in one place and can be rendered as a diagram beside the runnable workflows.
 */
export const riskPipeline = {
  id: 'risk-to-recommendation' as const,
  title: 'Score below threshold → recommendation',
  stages: [
    {
      id: 'evidence',
      label: 'Submission graded',
      detail: 'A grade lands in the LMS. No AI is involved in reading it.',
      implementedBy: 'services/lms · POST /api/lms/submissions/{id}/grade',
    },
    {
      id: 'facts',
      label: 'Facts derived',
      detail: 'buildClassFacts turns grades, due dates and turn-in times into per-student facts.',
      implementedBy: 'features/shared/services/classFacts.ts',
    },
    {
      id: 'inbox',
      label: 'AI Inbox insight',
      detail: 'Class-level rules detect weak tasks, backlogs and trends.',
      implementedBy: 'features/ai-inbox/services/insightRules.ts',
    },
    {
      id: 'queue',
      label: 'Intervention queue',
      detail: 'Per-student rules assign exactly one category, with evidence.',
      implementedBy: 'features/interventions/services/riskRules.ts',
    },
    {
      id: 'recommendation',
      label: 'Recommendation',
      detail: 'The highest-priority insights become dashboard recommendations with actions.',
      implementedBy: 'features/dashboard/services/recommendationService.ts',
    },
  ],
} as const
