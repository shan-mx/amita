import type {
  Conversation,
  Harness,
  InputSubmissionDraft,
  ModelRef,
  SubmissionId,
  Tx,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { ConversationBaseline } from "../agent/conversation-context";
import type { ModelOption } from "../models/schema";

export type AutomationModels = {
  inheritedModel: ModelRef | null;
  models: ModelOption[];
};

export type AutomationDependencies = {
  pi: () => Promise<Harness>;
  models: () => Promise<AutomationModels>;
  baseline: () => Promise<ConversationBaseline>;
  prepareInput: (
    conversation: Conversation,
    draft: InputSubmissionDraft & { requestId: string },
    context: Context,
  ) => Promise<(tx: Tx) => Promise<{ submissionId: SubmissionId } | { modelError: string }>>;
  now?: () => number;
};
