import type { ModelRef, ModelOption } from "../models/schema";

export type AutomationTriggerInput =
  | { type: "once"; runAt: string }
  | { type: "cron"; expression: string };
export type AutomationTrigger = { type: "once"; at: number } | { type: "cron"; expression: string };
export type AutomationExecution =
  | { kind: "new_session"; model?: ModelRef }
  | { kind: "existing_session"; sessionId: string };

export type AutomationWrite = {
  name: string;
  trigger: AutomationTriggerInput;
  timezone?: string;
  script?: string | null;
  prompt?: string | null;
  enabled?: boolean;
  execution?: AutomationExecution | null;
};
export type AutomationDefinition = {
  name: string;
  trigger: AutomationTrigger;
  timezone: string;
  script: string | null;
  prompt: string | null;
  enabled: boolean;
  execution: AutomationExecution | null;
};
export type AutomationInfo = {
  id: string;
  definition: AutomationDefinition;
  nextRun: number | null;
  activeRun: string | null;
  lastRun: string | null;
};
export type AutomationRunStatus = "running" | "succeeded" | "skipped" | "failed" | "cancelled";
export type AutomationRunInfo = {
  id: string;
  automationId: string;
  automationName: string;
  scheduledAt: number;
  admittedAt: number;
  startedAt?: number;
  endedAt?: number;
  status: AutomationRunStatus;
  error?: string;
  output?: string;
  sessionId?: string;
};
export type AutomationOptions = {
  models: ModelOption[];
};
export type AutomationRunPage = { runs: AutomationRunInfo[]; cursor?: string };
