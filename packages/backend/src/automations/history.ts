import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { match, P } from "ts-pattern";
import { StorageRequestError, type TaskRecord, type Cursor } from "@earendil-works/pi-durable";

import { AUTOMATION_COPY as COPY, AUTOMATION_LIMITS as LIMIT } from "../shared/config";
import { AutomationError } from "./automation-rules";

import {
  AutomationDocument,
  type RunInput,
  type RunCheckpoint,
  type RunResult,
} from "./automation-docs";
import type { AutomationRunInfo, AutomationRunPage } from "../shared/automations";

import type { AutomationDependencies } from "./dependencies";
export async function automationHistory(
  deps: AutomationDependencies,
  taskKind: string,
  id: string,
  cursor?: string,
): Promise<AutomationRunPage> {
  const pi = await deps.pi();
  const state = await pi.snapshot(AutomationDocument, id, BG);
  if (!state?.definition || state.conversationId === null)
    throw new AutomationError("not_found", COPY.notFound);
  const conversationId = state.conversationId;
  let nativeCursor: Cursor | undefined;
  if (cursor) {
    try {
      const value: unknown = JSON.parse(cursor);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(COPY.invalidCursor);
      nativeCursor = value as Cursor;
    } catch {
      throw new AutomationError("invalid", COPY.invalidCursor);
    }
  }
  const page = await pi
    .commit(
      (tx) =>
        tx.scanTasks(
          { kind: taskKind, conversationId, order: "descending" },
          LIMIT.historyPageSize,
          nativeCursor,
        ),
      BG,
    )
    .catch((error: unknown) => {
      if (error instanceof StorageRequestError)
        throw new AutomationError("invalid", COPY.invalidCursor);
      throw error;
    });
  const runs: AutomationRunInfo[] = [];
  for (const record of page.items) {
    const task = record as TaskRecord<RunInput, RunCheckpoint, RunResult>;
    const input = task.input;
    const outcome = task.state.outcome;
    const refs = outcome?.result?.refs ?? task.state.checkpoint?.refs;
    const program = refs?.programTask ? await pi.getTask(refs.programTask, BG) : undefined;
    const output = program?.state.outcome?.result?.output;
    const status = match({ state: task.state.status, outcome })
      .returnType<AutomationRunInfo["status"]>()
      .with({ state: P.not("terminal") }, () => "running")
      .with({ outcome: { status: "completed", result: { skipped: true } } }, () => "skipped")
      .with({ outcome: { status: "completed" } }, () => "succeeded")
      .with({ outcome: { status: "aborted" } }, () => "cancelled")
      .otherwise(() => "failed");
    runs.push({
      id: String(task.id),
      automationId: id,
      automationName: input.definition.name,
      scheduledAt: input.scheduledAt,
      admittedAt: input.admittedAt,
      status,
      ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
      ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
      ...(outcome && "error" in outcome && outcome.error ? { error: outcome.error.message } : {}),
      ...(output ? { output } : {}),
      ...(refs?.sessionId ? { sessionId: String(refs.sessionId) } : {}),
    });
  }
  return { runs, ...(page.next ? { cursor: JSON.stringify(page.next) } : {}) };
}
