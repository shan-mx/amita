import { modelRefSchema, type ModelRef } from "@amita/backend/models";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { match, P } from "ts-pattern";
import {
  ToolResultEntry,
  type ConversationView,
  type EntryRecord,
  type InboxState,
  type LiveState,
  type NestedToolSlot,
  type ToolSlot,
  type ToolDiagnostic,
} from "@earendil-works/pi-durable";
import type { CodemodeToolDetails } from "@earendil-works/pi-durable/codemode";

export const CODEMODE_NAME = "codemode";
export const STREAMING_MESSAGE_ID = "streaming";
type LiveTool = Omit<ToolSlot, "output"> &
  Partial<Pick<NestedToolSlot, "parentCallId" | "parentTaskId" | "arguments" | "summary">> & {
    output: string;
  };
export type ToolStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export type SessionState = {
  model: ModelRef | null;
  tools: Record<string, LiveTool>;
  entries: readonly EntryRecord[];
  live?: AssistantMessage;
  running: boolean;
  queued: number;
  needsRetry: boolean;
  stopped: boolean;
  failed: boolean;
};
export const emptyState = (): SessionState => ({
  model: null,
  tools: {},
  entries: [],
  running: false,
  queued: 0,
  needsRetry: false,
  stopped: false,
  failed: false,
});

export function projectView(view: Pick<ConversationView, "entries" | "docs">): SessionState {
  const live = view.docs["pi.live"] as LiveState | undefined;
  const inbox = view.docs["pi.inbox"] as InboxState | undefined;
  const running = Boolean(live?.run);
  const reason = running ? undefined : live?.runFailure?.reason;
  return {
    model: modelRefSchema.safeParse(view.docs["pi.agent"]?.model).data ?? null,
    entries: view.entries,
    live: live?.generation?.message,
    running,
    queued: inbox?.items.filter(({ mode }) => mode !== "write").length ?? 0,
    needsRetry: reason === "restart_limit",
    stopped: reason === "aborted",
    failed:
      reason !== undefined &&
      reason !== "aborted" &&
      reason !== "reset" &&
      reason !== "nothing_to_answer",
    tools: Object.fromEntries(
      [...(live?.tools ?? []), ...(live?.nestedTools ?? [])].map((tool) => [
        tool.callId,
        { ...tool, output: tool.output ?? "" },
      ]),
    ),
  };
}

function outcome(isError: boolean, diagnostics: readonly ToolDiagnostic[] = []): ToolStatus {
  if (diagnostics.some((item) => item.code === "aborted")) return "cancelled";
  if (diagnostics.some((item) => item.code === "interrupted" || item.code === "abandoned"))
    return "interrupted";
  return isError ? "failed" : "completed";
}

type ChildTool = {
  id: string;
  name: string;
  args: string;
  status: ToolStatus;
  output?: string;
  error?: string;
};

/** A display projection of Pi's live slots or its terminal result, never a second execution state. */
export function toolPresentation(state: SessionState, callId: string) {
  let result: ToolResultMessage | undefined;
  let diagnostics: readonly ToolDiagnostic[] = [];
  for (const entry of state.entries) {
    const message = entry.model?.find(
      (item): item is ToolResultMessage => item.role === "toolResult" && item.toolCallId === callId,
    );
    if (message) {
      result = message;
      if (ToolResultEntry.is(entry)) diagnostics = entry.data.diagnostics;
      break;
    }
  }
  const live = state.tools[callId];
  const status = match({ result, live })
    .returnType<ToolStatus>()
    .with({ result: P.nonNullable }, ({ result }) => outcome(result.isError, diagnostics))
    .with({ live: { status: P.not("done") } }, () => "running")
    .otherwise(() => "interrupted");
  const calls = match(result)
    .returnType<ChildTool[]>()
    .with({ toolName: CODEMODE_NAME }, (result) =>
      ((result.details as CodemodeToolDetails | undefined)?.calls ?? []).map((call) => ({
        id: String(call.id),
        name: call.name,
        args: call.args,
        status: match(call.status)
          .returnType<ToolStatus>()
          .with("ok", () => "completed")
          .with("error", () => "failed")
          .otherwise((status) => status),
        error: call.error,
      })),
    )
    .with(P.nonNullable, () => [])
    .otherwise(() =>
      Object.values(state.tools)
        .filter((tool) => tool.parentCallId === callId)
        .map((tool) => ({
          id: tool.callId,
          name: tool.name,
          args: JSON.stringify(tool.arguments ?? {}, null, 2),
          status: match(tool)
            .returnType<ToolStatus>()
            .with({ status: P.not("done") }, () => "running")
            .with({ summary: P.nonNullable }, ({ summary }) =>
              outcome(summary.isError, tool.diagnostics),
            )
            .otherwise(() => "interrupted"),
          output: tool.output || undefined,
          error: tool.summary?.error,
        })),
    );
  return {
    status,
    result,
    calls,
    output: result
      ? result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n")
      : (live?.output ?? ""),
  };
}

export function visibleMessages(
  state: SessionState,
): { id: string; message: Message; running: boolean }[] {
  const messages = state.entries.flatMap(visibleEntryMessages);
  if (state.live) messages.push({ id: STREAMING_MESSAGE_ID, message: state.live, running: true });
  return messages;
}

export function visibleEntryMessages(entry: EntryRecord) {
  return (entry.model ?? [])
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message, index) => ({ id: `${entry.id}:${index}`, message, running: false }));
}
