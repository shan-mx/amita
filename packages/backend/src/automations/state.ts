import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import type { AutomationState } from "./automation-docs";
import type { AutomationDefinition } from "../shared/automations";
import { AutomationError } from "./automation-rules";
import { AUTOMATION_COPY as COPY } from "../shared/config";
export type LiveAutomation = AutomationState & {
  definition: AutomationDefinition;
  conversationId: ConversationId;
};
export const active = (task: Awaited<ReturnType<Tx["task"]>>) =>
  task !== undefined && task.state.status !== "terminal";
export function isLiveAutomation(
  state: Readonly<AutomationState> | undefined,
): state is LiveAutomation {
  return Boolean(state?.definition && state.conversationId !== null && !state.deleted);
}

export function requireAutomation(
  state: Readonly<AutomationState> | undefined,
): asserts state is LiveAutomation {
  if (!isLiveAutomation(state)) throw new AutomationError("not_found", COPY.notFound);
}
