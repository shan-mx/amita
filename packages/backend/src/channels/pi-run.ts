import {
  AssistantEntry,
  LiveDoc,
  type Conversation,
  type ConversationId,
  type Cursor,
  type EntryId,
  type Harness,
  type LiveState,
  type Submission,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { CONFIG } from "../shared/config";
import { formatToolCall } from "./tool-display";

export type CommittedRange = (after: EntryId, through: EntryId) => void;

export async function* committedReplies(
  conversation: Conversation,
  after: EntryId,
  through: EntryId,
  context: Context,
) {
  const query = {
    minEntryId: (after + 1) as EntryId,
    maxEntryId: through,
    order: "ascending",
  } as const;
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries(query, CONFIG.historyPageSize, cursor, context);
    for (const entry of page.items) {
      if (!AssistantEntry.is(entry)) continue;
      let position = 0;
      const items: { position: number; text: string; kind: "text" | "tool" }[] = [];
      for (const message of entry.model ?? []) {
        if (message.role !== "assistant" || ["error", "aborted"].includes(message.stopReason))
          continue;
        for (const part of message.content) {
          const index = position++;
          if (part.type === "text" && part.text.trim())
            items.push({ position: index, text: part.text, kind: "text" });
          if (part.type === "toolCall")
            items.push({
              position: index,
              text: formatToolCall(part.name, part.arguments),
              kind: "tool",
            });
        }
      }
      yield { id: entry.id, items };
    }
    cursor = page.next;
  } while (cursor);
}

export async function currentChannelDestination(pi: Harness, id: ConversationId, context: Context) {
  const run = (await pi.snapshot(LiveDoc, id, context))?.run;
  if (!run?.inputs.length) return;
  const inputs = await Promise.all(
    run.inputs.map(async (input) => {
      const handle = await pi.submission(input, context);
      const submission = await handle?.status(context);
      if (
        submission?.type === "input" &&
        submission.status === "placed" &&
        submission.conversationId === id
      )
        return submission.entry;
    }),
  );
  const origins = await pi.commit(
    (tx) =>
      Promise.all(
        inputs.map(async (input) => {
          if (input === undefined) return;
          const entry = await tx.entry(input);
          const data = entry?.data;
          if (
            entry?.kind !== "amita.channel" ||
            !data ||
            typeof data !== "object" ||
            Array.isArray(data)
          )
            return;
          if (typeof data.destinationId === "string") return data.destinationId;
        }),
      ),
    context,
  );
  const [first] = origins;
  if (first && origins.every((origin) => origin === first)) return first;
}

export type AnsweredInput = Extract<SubmissionRecord, { type: "input"; status: "done" }>;

/** Publish live output only for the first placed input of a Pi run. */
export async function watchChannelTurn(
  conversation: Conversation,
  submission: Submission,
  context: Context,
  committed: CommittedRange,
  placed: (first: boolean, active: boolean) => void,
) {
  const watch = await conversation.watch(context);
  const observe = async (view: typeof watch.value) => {
    const live = view.docs["pi.live"] as LiveState | undefined;
    const inputs = live?.run?.inputs ?? live?.runFailure?.inputs;
    if (!inputs?.includes(submission.id)) return;
    const first = inputs[0] === submission.id;
    placed(first, Boolean(live?.run));
    if (!first) return;
    const through = view.entries.at(-1)?.id;
    if (through === undefined) return;
    const record = await submission.status(context);
    if (record.type !== "input" || record.entry === undefined) return;
    // The run can settle while the observer is reading its submission.
    const end = record.status === "done" ? (Math.min(through, record.answer) as EntryId) : through;
    if (end > record.entry) committed(record.entry, end);
  };
  try {
    await observe(watch.value);
  } catch (error) {
    await watch.stop();
    throw error;
  }
  watch.start(async (call) => {
    if (call.kind === "value") await observe(call.value);
  });
  return watch;
}
