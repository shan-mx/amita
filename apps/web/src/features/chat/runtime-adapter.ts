import { match } from "ts-pattern";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { visibleMessages, type SessionState } from "./session-state";

/** Projects Pi's authoritative messages into assistant-ui display parts. */
export function sessionMessages(state: SessionState): ThreadMessageLike[] {
  const toolResults = new Map<string, ToolResultMessage>();
  for (const entry of state.entries)
    for (const message of entry.model ?? [])
      if (message.role === "toolResult" && !toolResults.has(message.toolCallId))
        toolResults.set(message.toolCallId, message);
  return visibleMessages(state).map(({ id, message, running }) => {
    if (message.role === "user")
      return {
        id,
        role: "user",
        createdAt: new Date(message.timestamp),
        content:
          typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : message.content.filter((part) => part.type === "text"),
      };
    if (message.role !== "assistant") throw new Error("Unsupported chat role");
    const pendingTool =
      message.content.some((part) => part.type === "toolCall" && !toolResults.has(part.id)) &&
      state.running;
    return {
      id,
      role: "assistant",
      createdAt: new Date(message.timestamp),
      content: message.content.map((part) =>
        match(part)
          .with({ type: "text" }, (part) => ({ type: "text" as const, text: part.text }))
          .with({ type: "thinking" }, (part) => ({
            type: "reasoning" as const,
            text: part.thinking,
          }))
          .with({ type: "toolCall" }, (part) => {
            const result = toolResults.get(part.id);
            return {
              type: "tool-call" as const,
              toolCallId: part.id,
              toolName: part.name,
              args: part.arguments,
              argsText: JSON.stringify(part.arguments),
              ...(result
                ? {
                    result: result.content
                      .filter((item) => item.type === "text")
                      .map((item) => item.text)
                      .join("\n"),
                    isError: result.isError,
                  }
                : {}),
            };
          })
          .exhaustive(),
      ),
      status: match({ running: running || pendingTool, reason: message.stopReason })
        .returnType<NonNullable<ThreadMessageLike["status"]>>()
        .with({ running: true }, () => ({ type: "running" }))
        .with({ reason: "aborted" }, () => ({ type: "incomplete", reason: "cancelled" }))
        .with({ reason: "error" }, () => ({ type: "incomplete", reason: "error" }))
        .otherwise(() => ({ type: "complete", reason: "stop" })),
    };
  });
}
