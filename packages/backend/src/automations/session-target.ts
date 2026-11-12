import { z } from "zod";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { SessionMetadata } from "../agent/session-metadata";
import { AUTOMATION_COPY as COPY } from "../shared/config";
import { AutomationError } from "./automation-rules";

const conversationIdSchema = z.custom<ConversationId>(
  (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0,
);

export async function automationSession(tx: Tx, sessionId: string) {
  const id = conversationIdSchema.parse(Number(sessionId));
  const conversation = await tx.conversation(id);
  if (!conversation || conversation.owner || (await tx.doc(SessionMetadata, id)).hidden)
    throw new AutomationError("invalid", COPY.invalidSession);
  return id;
}
