import { useCallback, useState } from 'react'
import { invalidate } from '../../shared/state/queryCache'
import { executeWorkflow, summarise } from '../services/workflowEngine'
import type { WorkflowDefinition, WorkflowRun } from '../types/workflow'

export interface UseWorkflowRunnerResult {
  readonly run: WorkflowRun | null
  readonly running: boolean
  /**
   * Generic per call rather than per hook: one runner drives workflows with
   * different input types, and each call still checks its input against its own
   * definition. Binding the hook to a single definition would force a cast at
   * every call site that switches between workflows.
   */
  readonly start: <TInput>(
    definition: WorkflowDefinition<TInput>,
    input: TInput,
  ) => Promise<WorkflowRun>
  readonly reset: () => void
  readonly summary: string | null
}

/**
 * Drives workflow runs and re-renders on every step transition, so the drawer
 * shows progress live rather than a spinner and a verdict.
 *
 * On completion the LMS and facts query prefixes are invalidated: a workflow
 * that created and published coursework has changed the timeline, the dashboard
 * counts and the calendar, and all three should reload without any caller
 * wiring it up.
 */
export function useWorkflowRunner(): UseWorkflowRunnerResult {
  const [run, setRun] = useState<WorkflowRun | null>(null)
  const [running, setRunning] = useState(false)

  const start = useCallback(
    async <TInput,>(definition: WorkflowDefinition<TInput>, input: TInput): Promise<WorkflowRun> => {
      setRunning(true)
      try {
        const result = await executeWorkflow(definition, input, setRun)
        invalidate(['lms'])
        invalidate(['facts'])
        return result
      } finally {
        setRunning(false)
      }
    },
    [],
  )

  return {
    run,
    running,
    start,
    reset: useCallback(() => setRun(null), []),
    summary: run && run.status !== 'running' ? summarise(run) : null,
  }
}
