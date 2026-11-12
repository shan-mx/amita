import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";

import { type Harness, type Extension, type Tx } from "@earendil-works/pi-durable";
import { digest } from "../http/auth";
import { SessionMetadata } from "../agent/session-metadata";

import { AUTOMATION_COPY as COPY, MODEL_COPY } from "../shared/config";
import { sameModel, type ModelRef } from "../models/schema";
import { normalizeAutomation, nextOccurrence, AutomationError } from "./automation-rules";
import { AutomationCatalog, AutomationDocument } from "./automation-docs";
import type {
  AutomationDefinition,
  AutomationTrigger,
  AutomationWrite,
  AutomationInfo,
  AutomationRunPage,
  AutomationOptions,
} from "../shared/automations";

import type { AutomationDependencies, AutomationModels } from "./dependencies";
import { isLiveAutomation, requireAutomation, type LiveAutomation } from "./state";
import { AutomationRuntime } from "./runtime";
import { automationHistory } from "./history";
export type { AutomationDependencies } from "./dependencies";
import { automationSession } from "./session-target";

function sameTrigger(previous: AutomationTrigger, next: AutomationTrigger) {
  return previous.type === "once"
    ? next.type === "once" && previous.at === next.at
    : next.type === "cron" && previous.expression === next.expression;
}

export class Automations {
  readonly now: () => number;
  private readonly runtime: AutomationRuntime;
  constructor(private readonly deps: AutomationDependencies) {
    this.now = deps.now ?? Date.now;
    this.runtime = new AutomationRuntime(deps);
  }
  get clockTask() {
    return this.runtime.clockTask;
  }
  get runTask() {
    return this.runtime.runTask;
  }
  extension(): Extension {
    return { name: "amita.automations.runtime", tasks: [this.clockTask, this.runTask] };
  }

  private validateModel(model: ModelRef | null, models: AutomationModels, requiresModel: boolean) {
    if (
      model &&
      !models.models.some(({ provider, id }) => sameModel(model, { provider, modelId: id }))
    )
      throw new AutomationError("invalid", MODEL_COPY.invalidSelection);
    if (requiresModel && !model && !models.inheritedModel)
      throw new AutomationError("invalid", MODEL_COPY.missingAgent);
  }
  private async schedule(tx: Tx, id: string, state: LiveAutomation, now: number) {
    const previous = state.clockTask;
    state.epoch++;
    state.cursor = now;
    state.clockTask = state.definition.enabled
      ? await tx.createTask(
          this.clockTask,
          { automationId: id, epoch: state.epoch },
          {
            ownership: { kind: "conversation" },
            conversationId: state.conversationId,
            background: true,
          },
        )
      : null;
    return previous;
  }

  async options(): Promise<AutomationOptions> {
    const { models } = await this.deps.models();
    return { models };
  }

  async create(id: string, input: AutomationWrite, timezone?: string): Promise<AutomationInfo> {
    const pi = await this.deps.pi();
    const models = await this.deps.models();
    const definition = normalizeAutomation(input, timezone);
    await pi.commit(async (tx) => {
      const creationFingerprint = await digest(JSON.stringify(definition));
      const state = await tx.doc(AutomationDocument, id, null);
      if (state.definition) {
        if (state.deleted) throw new AutomationError("not_found", COPY.notFound);
        if (state.creationFingerprint !== creationFingerprint)
          throw new AutomationError("conflict", COPY.createConflict);
        return;
      }
      const { execution } = definition;
      if (execution?.kind === "existing_session") await automationSession(tx, execution.sessionId);
      if (execution?.kind === "new_session" && (execution.model || definition.enabled))
        this.validateModel(execution.model ?? null, models, definition.enabled);
      const now = this.now();
      if (definition.trigger.type === "once" && definition.trigger.at <= now)
        throw new AutomationError("invalid", COPY.futureTime);
      const catalog = await tx.doc(AutomationCatalog);
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      (await tx.doc(SessionMetadata, conversation.id)).hidden = true;
      Object.assign(state, {
        definition,
        creationFingerprint,
        conversationId: conversation.id,
      });
      requireAutomation(state);
      catalog.ids.push(id);
      await this.schedule(tx, id, state, now);
    }, BG);
    pi.resume();
    return this.info(id);
  }
  async update(id: string, patch: Partial<AutomationWrite>): Promise<AutomationInfo> {
    const pi = await this.deps.pi();
    const models = await this.deps.models();
    const old = await pi.commit(async (tx) => {
      const state = await tx.doc(AutomationDocument, id, null);
      requireAutomation(state);
      const previous = state.definition;
      const definition = normalizeAutomation(patch, undefined, previous);
      const { execution } = definition;
      if (execution?.kind === "existing_session") await automationSession(tx, execution.sessionId);
      if (execution?.kind === "new_session") {
        const previousExecution = previous.execution;
        const modelChanged = !sameModel(
          execution.model,
          previousExecution?.kind === "new_session" ? previousExecution.model : undefined,
        );
        const requiresModel =
          definition.enabled &&
          (!previous.enabled || previousExecution?.kind !== "new_session" || modelChanged);
        if ((modelChanged && execution.model) || requiresModel)
          this.validateModel(execution.model ?? null, models, requiresModel);
      }
      const now = this.now();
      const triggerChanged = !sameTrigger(previous.trigger, definition.trigger);
      if (triggerChanged && definition.trigger.type === "once" && definition.trigger.at <= now)
        throw new AutomationError("invalid", COPY.futureTime);
      const scheduleChanged =
        triggerChanged ||
        previous.timezone !== definition.timezone ||
        previous.enabled !== definition.enabled;
      state.definition = definition;
      return scheduleChanged ? await this.schedule(tx, id, state, now) : null;
    }, BG);
    if (old) await pi.abortTask(old, BG);
    pi.resume();
    return this.info(id);
  }
  async remove(id: string) {
    const pi = await this.deps.pi();
    const old = await pi.commit(async (tx) => {
      const state = await tx.doc(AutomationDocument, id, null);
      requireAutomation(state);
      const catalog = await tx.doc(AutomationCatalog);
      catalog.ids = catalog.ids.filter((entry) => entry !== id);
      const previous = state.clockTask;
      state.deleted = true;
      state.definition.enabled = false;
      state.epoch++;
      state.clockTask = null;
      return previous;
    }, BG);
    if (old) await pi.abortTask(old, BG);
    return { removed: true as const };
  }
  async list() {
    const pi = await this.deps.pi();
    const catalog = await pi.snapshot(AutomationCatalog, BG);
    const result: AutomationInfo[] = [];
    for (const id of catalog?.ids ?? []) {
      const state = await pi.snapshot(AutomationDocument, id, BG);
      if (isLiveAutomation(state)) result.push(await this.describe(pi, id, state));
    }
    return result;
  }
  async info(id: string): Promise<AutomationInfo> {
    const pi = await this.deps.pi();
    const state = await pi.snapshot(AutomationDocument, id, BG);
    requireAutomation(state);
    return this.describe(pi, id, state);
  }
  private async describe(
    pi: Harness,
    id: string,
    state: Readonly<LiveAutomation>,
  ): Promise<AutomationInfo> {
    const run = state.lastRun ? await pi.getTask(state.lastRun, BG) : undefined;
    const definition: AutomationDefinition = {
      ...state.definition,
      trigger: { ...state.definition.trigger },
    };
    return {
      id,
      definition,
      nextRun: state.definition.enabled ? nextOccurrence(state.definition, state.cursor) : null,
      activeRun: run && run.state.status !== "terminal" ? String(run.id) : null,
      lastRun: state.lastRun ? String(state.lastRun) : null,
    };
  }
  async stop(id: string) {
    const pi = await this.deps.pi();
    const state = await pi.snapshot(AutomationDocument, id, BG);
    if (!state?.definition || state.conversationId === null)
      throw new AutomationError("not_found", COPY.notFound);
    const task = state.lastRun ? await pi.getTask(state.lastRun, BG) : undefined;
    if (!task || task.state.status === "terminal") return { stopped: false };
    await pi.abortTask(task.id, BG);
    return { stopped: true };
  }
  history(id: string, cursor?: string): Promise<AutomationRunPage> {
    return automationHistory(this.deps, this.runTask.definition.name, id, cursor);
  }
}
