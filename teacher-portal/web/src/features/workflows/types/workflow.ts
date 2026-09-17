import type { CapabilityId } from '../../shared/services/capability'

export type WorkflowId =
  | 'upload-material'
  | 'create-assignment'
  | 'create-quiz'
  | 'post-announcement'
  | 'schedule-revision'
  | 'risk-to-recommendation'

export type StepStatus = 'pending' | 'running' | 'done' | 'blocked' | 'failed' | 'skipped'

export interface WorkflowStepSpec {
  readonly id: string
  readonly title: string
  readonly description: string
  /**
   * Capability the step needs. When it is unprovisioned the step reports
   * `blocked` and the run continues — a missing generator must not strand a
   * teacher halfway through publishing real work.
   */
  readonly requires?: CapabilityId
  /** A step the teacher performs, not the system (approval gates). */
  readonly manual?: boolean
}

export interface WorkflowStepState extends WorkflowStepSpec {
  readonly status: StepStatus
  /** One line of what actually happened, shown under the step. */
  readonly detail: string | null
  readonly error: string | null
  readonly startedAt: string | null
  readonly finishedAt: string | null
}

/** Free-form values a step publishes for later steps and for the caller. */
export type WorkflowOutput = Readonly<Record<string, string>>

export interface WorkflowRun {
  readonly id: string
  readonly workflowId: WorkflowId
  readonly title: string
  readonly steps: readonly WorkflowStepState[]
  readonly status: 'idle' | 'running' | 'completed' | 'failed'
  readonly output: WorkflowOutput
  readonly startedAt: string | null
  readonly finishedAt: string | null
}

/** Result a step hands back to the engine. */
export type StepResult =
  | { readonly kind: 'done'; readonly detail: string; readonly output?: WorkflowOutput }
  | { readonly kind: 'skipped'; readonly detail: string }
  | { readonly kind: 'blocked'; readonly capability: CapabilityId; readonly detail: string }

export interface WorkflowContext<TInput> {
  readonly input: TInput
  /** Values published by earlier steps in this run. */
  readonly output: WorkflowOutput
}

export interface WorkflowStep<TInput> extends WorkflowStepSpec {
  readonly run: (context: WorkflowContext<TInput>) => Promise<StepResult>
}

export interface WorkflowDefinition<TInput> {
  readonly id: WorkflowId
  readonly title: string
  readonly description: string
  readonly steps: readonly WorkflowStep<TInput>[]
}
