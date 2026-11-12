import {
  defineDoc,
  defineDocFamily,
  type ConversationId,
  type EntryId,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { ChannelInput } from "./adapter";
import type { AttachmentMetadata } from "./attachments";

export type DeliveryResult = {
  status: "sent" | "cancelled" | "failed" | "unknown";
  receipts: string[];
  error?: string;
};

type PendingInbound = {
  taskId: TaskId;
  destinationId: string;
  conversationId: ConversationId | null;
  input: ChannelInput;
  creatingThread: boolean;
  attachments?: AttachmentMetadata[];
};

export const Inbound = defineDocFamily<
  { pending: Record<string, PendingInbound>; recent: Record<string, number> },
  null
>({
  kind: "amita.channels.inbox",
  scope: "session",
  family: true,
  version: 1,
  initial: () => ({ pending: {}, recent: {} }),
  checkpointWhen: () => true,
});

type RepliesState = {
  publishers: Record<string, EntryId | 0>;
  deliveries: Record<string, { entryId: EntryId; taskId: TaskId<DeliveryResult> }>;
};

export const Replies = defineDoc<RepliesState>({
  kind: "amita.channels.replies",
  scope: "conversation",
  history: "latest",
  fork: "initial",
  version: 1,
  initial: () => ({ publishers: {}, deliveries: {} }),
  checkpointWhen: () => true,
});

export const TaskDelivery = defineDoc<{ taskId: TaskId<DeliveryResult> | null }>({
  kind: "amita.channels.task-delivery",
  scope: "task",
  version: 1,
  initial: () => ({ taskId: null }),
  checkpointWhen: () => true,
});

export function pruneReplies(state: RepliesState) {
  // Each publisher can only enqueue replies after its pre-admission boundary.
  const oldestBoundary = Object.values(state.publishers).reduce<number>(
    (minimum, entry) => Math.min(minimum, entry),
    Infinity,
  );
  for (const [key, { entryId }] of Object.entries(state.deliveries))
    if (entryId <= oldestBoundary) delete state.deliveries[key];
}
