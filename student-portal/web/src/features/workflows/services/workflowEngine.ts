/**
 * Workflow engine.
 *
 * A workflow is an ordered list of steps, each of which either performs a real
 * API call or reports that it is blocked on a named capability. The engine's
 * contract is that a blocked step never aborts the run: uploading a material
 * and posting it to the timeline must still work when the lesson generator does
 * not exist. A *failed* step does abort, because continuing past a real error
 * would produce a half-created assignment.
 *
 * Runs are observable so the drawer can show progress as it happens rather than
 * a spinner followed by a result.
 */

import type {
  StepResult,
  WorkflowDefinition,
  WorkflowOutput,
  WorkflowRun,
  WorkflowStepSpec,
  WorkflowStepState,
} from '../types/workflow'

let runCounter = 0

const nowIso = (): string => new Date().toISOString()

const initialStep = (step: WorkflowStepSpec): WorkflowStepState => ({
  id: step.id,
  title: step.title,
  description: step.description,
  requires: step.requires,
  manual: step.manual,
  status: 'pending',
  detail: null,
  error: null,
  startedAt: null,
  finishedAt: null,
})

export function createRun<TInput>(definition: WorkflowDefinition<TInput>): WorkflowRun {
  runCounter += 1
  return {
    id: `${definition.id}-${runCounter}`,
    workflowId: definition.id,
    title: definition.title,
    steps: definition.steps.map(initialStep),
    status: 'idle',
    output: {},
    startedAt: null,
    finishedAt: null,
  }
}

const patchStep = (
  run: WorkflowRun,
  stepId: string,
  patch: Partial<WorkflowStepState>,
): WorkflowRun => ({
  ...run,
  steps: run.steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step)),
})

/**
 * Execute a workflow, calling `onProgress` after every state change.
 * Resolves with the terminal run state; it does not throw.
 */
export async function executeWorkflow<TInput>(
  definition: WorkflowDefinition<TInput>,
  input: TInput,
  onProgress: (run: WorkflowRun) => void,
): Promise<WorkflowRun> {
  let run: WorkflowRun = { ...createRun(definition), status: 'running', startedAt: nowIso() }
  onProgress(run)

  let output: WorkflowOutput = {}

  for (const step of definition.steps) {
    run = patchStep(run, step.id, { status: 'running', startedAt: nowIso() })
    onProgress(run)

    let result: StepResult
    try {
      result = await step.run({ input, output })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      run = patchStep(run, step.id, {
        status: 'failed',
        error: message,
        finishedAt: nowIso(),
      })
      run = { ...run, status: 'failed', finishedAt: nowIso(), output }
      onProgress(run)
      return run
    }

    switch (result.kind) {
      case 'done':
        output = { ...output, ...(result.output ?? {}) }
        run = patchStep(run, step.id, {
          status: 'done',
          detail: result.detail,
          finishedAt: nowIso(),
        })
        break
      case 'skipped':
        run = patchStep(run, step.id, {
          status: 'skipped',
          detail: result.detail,
          finishedAt: nowIso(),
        })
        break
      case 'blocked':
        // Deliberate: a missing downstream capability degrades the run, it does
        // not cancel the work already committed.
        run = patchStep(run, step.id, {
          status: 'blocked',
          detail: result.detail,
          finishedAt: nowIso(),
        })
        break
      default:
        break
    }

    run = { ...run, output }
    onProgress(run)
  }

  run = { ...run, status: 'completed', finishedAt: nowIso(), output }
  onProgress(run)
  return run
}

/** Human summary of a finished run, used in toasts. */
export function summarise(run: WorkflowRun): string {
  const done = run.steps.filter((step) => step.status === 'done').length
  const blocked = run.steps.filter((step) => step.status === 'blocked').length
  const failed = run.steps.find((step) => step.status === 'failed')

  if (failed) return `${run.title} stopped at “${failed.title}”: ${failed.error ?? 'unknown error'}`
  if (blocked > 0) {
    return `${run.title}: ${done} step${done === 1 ? '' : 's'} completed, ${blocked} awaiting backend`
  }
  return `${run.title}: ${done} step${done === 1 ? '' : 's'} completed`
}
