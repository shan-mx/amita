import { match, P } from "ts-pattern";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  configure,
  ConversationBusy,
  LiveDoc,
  defineTask,
  type TaskRuntime,
  type RunningTask,
  type Tx,
} from "@earendil-works/pi-durable";
import { ProgramTask, PROGRAM_EXTENSION } from "../agent/program";

import { SessionMetadata } from "../agent/session-metadata";
import { saveConversationBaseline, type ConversationBaseline } from "../agent/conversation-context";
import { automationSession } from "./session-target";
import { AUTOMATION_COPY as COPY, CONFIG, MODEL_COPY } from "../shared/config";
import { AutomationError, dueOccurrence } from "./automation-rules";
import {
  AutomationDocument,
  type RunInput,
  type RunCheckpoint,
  type RunResult,
  type ClockInput,
  type ClockCheckpoint,
} from "./automation-docs";

import type { AutomationModels, AutomationDependencies } from "./dependencies";
import { active, requireAutomation, type LiveAutomation } from "./state";
type RunRuntime = TaskRuntime<RunInput, RunCheckpoint, RunResult, object>;
type Run<P extends RunCheckpoint["phase"] = RunCheckpoint["phase"]> = RunningTask<
  RunInput,
  Extract<RunCheckpoint, { phase: P }>,
  RunResult
>;
type RunFinish = {
  error?: string;
  cancelled?: boolean;
  skipped?: boolean;
};

export class AutomationRuntime {
  constructor(private readonly deps: AutomationDependencies) {}
  readonly clockTask = defineTask<ClockInput, ClockCheckpoint, null>({
    name: "amita.automation.clock",
    version: 1,
    initial: () => ({ phase: "tick" }),
    phases: {
      tick: async (task, runtime, context) => {
        const models = await this.deps.models();
        await runtime.commit(async (tx) => {
          const state = await tx.doc(AutomationDocument, task.input.automationId, null);
          if (
            !state.definition ||
            state.deleted ||
            !state.definition.enabled ||
            state.epoch !== task.input.epoch
          )
            return { status: "terminal", outcome: { status: "completed", result: null } };
          const occurrence = dueOccurrence(state.definition, state.cursor, runtime.now());
          if (occurrence.due === null)
            return occurrence.next === null
              ? { status: "terminal", outcome: { status: "completed", result: null } }
              : { status: "sleeping", until: occurrence.next, checkpoint: { phase: "tick" } };
          if (state.lastRun && active(await tx.task(state.lastRun)))
            return {
              status: "waiting",
              on: [state.lastRun],
              policy: "allSettled",
              checkpoint: { phase: "tick" },
            };
          requireAutomation(state);
          const id = await this.admit(
            tx,
            task.input.automationId,
            state,
            models,
            occurrence.due,
            runtime.now(),
          );
          state.cursor = occurrence.due;
          return {
            status: "waiting",
            on: [id],
            policy: "allSettled",
            checkpoint: { phase: "tick" },
          };
        }, context);
      },
    },
    abort: async (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  readonly runTask = defineTask<RunInput, RunCheckpoint, RunResult>({
    name: "amita.automation.run",
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: (task, runtime, context) => this.startAttempt(task, runtime, context),
      script: (task, runtime, context) => this.script(task, runtime, context),
      submit: (task, runtime, context) => this.submit(task, runtime, context),
      agent: (task, runtime, context) => this.agent(task, runtime, context),
    },
    abort: async (task, runtime, context) => {
      const checkpoint = task.state.checkpoint;
      if (checkpoint.phase === "agent") {
        const pi = await this.deps.pi();
        await pi.abortSubmission(checkpoint.submissionId, context);
        // A run can hand control to another native generation while cancellation is admitted.
        // Follow only this input, so a later user run is never stopped.
        for (;;) {
          const live = await runtime.snapshot(LiveDoc, checkpoint.refs.sessionId, context);
          if (!live?.run?.inputs.includes(checkpoint.submissionId)) break;
          await pi.abortTask(live.run.taskId, context);
          await runtime.waitForTask(live.run.taskId, context);
        }
      }
      await this.finish(task, runtime, context, { cancelled: true });
    },
  });
  private async admit(
    tx: Tx,
    id: string,
    state: LiveAutomation,
    models: AutomationModels,
    scheduledAt: number,
    now: number,
  ) {
    const definition = state.definition;
    const input: RunInput = {
      automationId: id,
      definition,
      model:
        definition.execution?.kind === "new_session"
          ? (definition.execution.model ?? models.inheritedModel)
          : null,
      scheduledAt,
      admittedAt: now,
    };
    const run = await tx.createTask(this.runTask, input, {
      ownership: { kind: "conversation" },
      conversationId: state.conversationId,
      background: true,
    });
    state.lastRun = run;
    return run;
  }
  private async startAttempt(task: Run, runtime: RunRuntime, context: Context) {
    const { model, definition } = task.input;
    if (
      definition.execution?.kind === "new_session" &&
      (!model || !runtime.models.getModel(model.provider, model.modelId))
    )
      return this.finish(task, runtime, context, {
        error: definition.execution.model
          ? MODEL_COPY.unavailable(definition.execution.model)
          : MODEL_COPY.missingAgent,
      });
    const { script, prompt, timezone } = definition;
    if (script) {
      const program = runtime.registry.extension(PROGRAM_EXTENSION)!;
      await runtime.commit(async (tx) => {
        const conversation = await tx.createConversation({
          ownership: { kind: "task", taskId: runtime.taskId },
        });
        await configure(tx, conversation.id, { extensions: { add: [program] } });
        Object.assign(await tx.doc(SessionMetadata, conversation.id), { hidden: true, timezone });
        const programTask = await tx.createTask(
          ProgramTask,
          { code: script, captureReturn: !!prompt },
          { ownership: { kind: "conversation" }, conversationId: conversation.id },
        );
        return { status: "running", checkpoint: { phase: "script", refs: { programTask } } };
      }, context);
      return;
    }
    const baseline =
      task.input.definition.execution?.kind === "new_session" ? await this.deps.baseline() : null;
    await runtime.commit(async (tx) => {
      const sessionId = await this.createAgentSession(tx, task, runtime, baseline);
      return { status: "running", checkpoint: { phase: "submit", refs: { sessionId } } };
    }, context);
  }
  private async createAgentSession(
    tx: Tx,
    task: Run,
    runtime: RunRuntime,
    baseline: ConversationBaseline | null,
  ) {
    const { execution } = task.input.definition;
    if (execution?.kind === "existing_session") return automationSession(tx, execution.sessionId);
    if (!baseline) throw new Error("Automation conversation baseline is missing.");
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, conversation.id, {
      model: task.input.model,
      thinkingLevel: CONFIG.thinkingLevel,
    });
    await saveConversationBaseline(tx, conversation.id, baseline);
    Object.assign(await tx.doc(SessionMetadata, conversation.id), {
      title: `Automation: ${task.input.definition.name}`,
      timezone: task.input.definition.timezone,
      automationRunId: String(runtime.taskId),
    });
    return conversation.id;
  }
  private async script(task: Run<"script">, runtime: RunRuntime, context: Context) {
    const { programTask } = task.state.checkpoint.refs;
    const program = await runtime.waitForTask(programTask, context);
    const outcome = program.state.outcome;
    const result = outcome.result;
    if (outcome.status !== "completed" || !result)
      return this.finish(task, runtime, context, {
        error: (outcome.status === "failed" && outcome.error?.message) || COPY.scriptFailure,
      });
    if (!task.input.definition.prompt) return this.finish(task, runtime, context);
    const value = result.returned;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.runAgent !== "boolean"
    )
      return this.finish(task, runtime, context, {
        error: COPY.invalidGuard,
      });
    if (!value.runAgent) return this.finish(task, runtime, context, { skipped: true });
    const baseline =
      task.input.definition.execution?.kind === "new_session" ? await this.deps.baseline() : null;
    await runtime.commit(async (tx) => {
      const sessionId = await this.createAgentSession(tx, task, runtime, baseline);
      return {
        status: "running",
        checkpoint: { phase: "submit", refs: { programTask, sessionId } },
      };
    }, context);
  }
  private async submit(task: Run<"submit">, runtime: RunRuntime, context: Context) {
    const refs = task.state.checkpoint.refs;
    const conversation = await (await this.deps.pi()).conversation(refs.sessionId, context);
    if (!conversation) throw new Error("Automation Agent Session is missing.");
    let extra: JsonValue | undefined;
    if (refs.programTask) {
      const program = await runtime.getTask(refs.programTask, context);
      const value = program?.state.outcome?.result?.returned;
      if (value && typeof value === "object" && !Array.isArray(value)) extra = value.context;
    }
    const content =
      task.input.definition.prompt! +
      (extra === undefined ? "" : `\n\nAutomation context (JSON):\n${JSON.stringify(extra)}`);
    try {
      const admit = await this.deps.prepareInput(
        conversation,
        {
          type: "input",
          requestId: `automation:${runtime.taskId}`,
          whenBusy: "reject",
          content,
          entry: {
            kind: "amita.automation",
            data: {
              automationId: task.input.automationId,
              runId: String(runtime.taskId),
              scheduledAt: task.input.scheduledAt,
              ...(extra === undefined ? {} : { context: extra }),
            },
          },
        },
        context,
      );
      await runtime.commit(async (tx) => {
        const admission = await admit(tx);
        if ("modelError" in admission) throw new AutomationError("invalid", admission.modelError);
        return {
          status: "running",
          checkpoint: { phase: "agent", refs, submissionId: admission.submissionId },
        };
      }, context);
    } catch (error) {
      if (!(error instanceof ConversationBusy) && !(error instanceof AutomationError)) throw error;
      await this.finish(task, runtime, context, {
        error: error instanceof ConversationBusy ? COPY.sessionBusy : error.message,
      });
    }
  }

  private async agent(task: Run<"agent">, runtime: RunRuntime, context: Context) {
    const pi = await this.deps.pi();
    const submission = await pi.submission(task.state.checkpoint.submissionId, context);
    if (!submission) throw new Error("Automation Agent submission is missing.");
    const result = await submission.wait(context);
    if (result.status === "done") return this.finish(task, runtime, context);
    if (result.reason === "aborted" || result.reason === "withdrawn")
      return this.finish(task, runtime, context, { cancelled: true });
    return this.finish(task, runtime, context, {
      error: `Agent execution failed: ${result.reason ?? "unanswered"}.`,
    });
  }
  private async finish(
    task: Run,
    runtime: RunRuntime,
    context: Context,
    { error, cancelled = false, skipped = false }: RunFinish = {},
  ) {
    const refs = task.state.checkpoint.refs;
    const result: RunResult = { ...(refs ? { refs } : {}), skipped };
    await runtime.commit(() => {
      return {
        status: "terminal",
        outcome: match({ error, cancelled })
          .with({ error: P.string.minLength(1) }, ({ error }) => ({
            status: "failed" as const,
            error: { message: error },
            result,
          }))
          .with({ cancelled: true }, () => ({ status: "aborted" as const, result }))
          .otherwise(() => ({ status: "completed" as const, result })),
      };
    }, context);
  }
}
