import { describe, expect, it } from "vite-plus/test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { emptyState } from "../src/features/chat/session-state";
import { sessionMessages } from "../src/features/chat/runtime-adapter";

const answer = (stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage => ({
  role: "assistant",
  api: "openai-completions",
  provider: "deepseek",
  model: "deepseek-flash",
  timestamp: 1,
  stopReason,
  content: [
    { type: "thinking", thinking: "Inspect the workspace." },
    { type: "text", text: "Reading the file." },
    { type: "toolCall", id: "read-1", name: "fs_read", arguments: { path: "/a.txt" } },
  ],
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const entry = (id: number, model: NonNullable<EntryRecord["model"]>): EntryRecord => ({
  id: id as EntryId,
  conversationId: 1 as ConversationId,
  kind: "fixture",
  model,
});

describe("assistant-ui native message projection", () => {
  it("keeps an unresolved tool running and projects its authoritative result on reconnect", () => {
    const state = { ...emptyState(), running: true, entries: [entry(1, [answer()])] };
    expect(sessionMessages(state)[0].status).toEqual({ type: "running" });
    const restored = sessionMessages({
      ...state,
      running: false,
      entries: [
        ...state.entries,
        entry(2, [
          {
            role: "toolResult",
            toolCallId: "read-1",
            toolName: "fs_read",
            content: [{ type: "text", text: "Missing file" }],
            isError: true,
            timestamp: 2,
          },
        ]),
      ],
    });
    expect(restored).toHaveLength(1);
    expect(restored[0].content).toEqual([
      { type: "reasoning", text: "Inspect the workspace." },
      { type: "text", text: "Reading the file." },
      {
        type: "tool-call",
        toolCallId: "read-1",
        toolName: "fs_read",
        args: { path: "/a.txt" },
        argsText: '{"path":"/a.txt"}',
        result: "Missing file",
        isError: true,
      },
    ]);
    expect(restored[0].status).toEqual({ type: "complete", reason: "stop" });
  });

  it.each([
    ["aborted", "cancelled"],
    ["error", "error"],
  ] as const)("projects %s as an incomplete assistant response", (stopReason, reason) => {
    const state = { ...emptyState(), entries: [entry(1, [answer(stopReason)])] };
    expect(sessionMessages(state)[0].status).toEqual({ type: "incomplete", reason });
  });
});
