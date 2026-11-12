import {
  defineDoc,
  defineDocFamily,
  type ConversationId,
  type SubmissionId,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { AutomationDefinition } from "../shared/automations";
import type { ProgramResult } from "../agent/program";

export const AutomationCatalog = defineDoc<{ ids: string[] }>({
  kind: "amita.automations",
  version: 1,
  scope: "session",
  initial: () => ({ ids: [] }),
  checkpointWhen: () => true,
});
export type AutomationState = {
  definition: AutomationDefinition | null;
  creationFingerprint: string | null;
  deleted: boolean;
  conversationId: ConversationId | null;
  cursor: number;
  epoch: number;
  clockTask: TaskId | null;
  lastRun: TaskId<RunResult> | null;
};
export const AutomationDocument = defineDocFamily<AutomationState, null>({
  kind: "amita.automation",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({
    definition: null,
    creationFingerprint: null,
    deleted: false,
    conversationId: null,
    cursor: 0,
    epoch: 0,
    clockTask: null,
    lastRun: null,
  }),
  checkpointWhen: () => true,
});
export type RunInput = {
  automationId: string;
  definition: AutomationDefinition;
  model: { provider: string; modelId: string } | null;
  scheduledAt: number;
  admittedAt: number;
};
/** Native records own execution state and timing. */
export type RunReferences = {
  programTask?: TaskId<ProgramResult>;
  sessionId?: ConversationId;
};
export type RunCheckpoint =
  | { phase: "start"; refs?: never }
  | { phase: "script"; refs: { programTask: TaskId<ProgramResult>; sessionId?: never } }
  | { phase: "submit"; refs: RunReferences & { sessionId: ConversationId } }
  | {
      phase: "agent";
      refs: RunReferences & { sessionId: ConversationId };
      submissionId: SubmissionId;
    };
export type RunResult = {
  refs?: RunReferences;
  skipped: boolean;
};
export type ClockInput = { automationId: string; epoch: number };
export type ClockCheckpoint = { phase: "tick" };
