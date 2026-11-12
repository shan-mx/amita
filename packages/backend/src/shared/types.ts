import type { Op } from "@earendil-works/chord/delta";
import type { ConversationView, Cursor, EntryId, EntryRecord } from "@earendil-works/pi-durable";

export type AgentConfig = {
  name: string;
  model: { provider: string; modelId: string } | null;
  thinkingLevel: "high";
};
export type AgentInfo = AgentConfig & { id: string; slug: string; createdAt: number };
export type SessionInfo = {
  id: string;
  title: string;
  busy: boolean;
  model: { provider: string; modelId: string } | null;
  modelEditable: boolean;
  archived: boolean;
  modelLabel?: string;
};
export type SearchMessage = { entryId: number; role: "user" | "assistant"; text: string };
export type SearchHit = SearchMessage & {
  sessionId: string;
  title: string;
  archived: boolean;
  context: SearchMessage[];
};
export type HistoryPage = { entries: EntryRecord[]; next?: Cursor };
export type ChatConnection = { session: string; from?: EntryId };
export type ChatSubscription = ChatConnection & { expiresAt: number };
export type StreamPacket =
  | { type: "snapshot"; view: ConversationView }
  | { type: "delta"; ops: readonly Op[] }
  | { type: "session_changed" };
