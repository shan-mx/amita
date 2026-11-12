import { describe, expect, it } from "vite-plus/test";
import { copyJson } from "@earendil-works/chord";
import { applyImmutable } from "@earendil-works/chord/delta";
import type {
  ConversationId,
  ConversationView,
  EntryId,
  EntryRecord,
  LiveState,
  TaskId,
} from "@earendil-works/pi-durable";
import { projectView, toolPresentation } from "../src/features/chat/session-state";

const run = { taskId: 1 as TaskId, inputs: [], turns: 0 };
function view(entries: EntryRecord[], live: LiveState = {}): ConversationView {
  return {
    conversation: { id: 1 as ConversationId },
    entries,
    docs: { "pi.live": live },
  };
}

describe("native conversation outcome restoration", () => {
  it.each(["model_error", "aborted", "restart_limit"] as const)(
    "keeps the %s outcome identical before and after reconnect",
    (reason) => {
      const live = { runFailure: { taskId: run.taskId, inputs: [], reason } };
      const incremental = applyImmutable(view([], { run }), [["s", ["docs", "pi.live"], live]]);
      const expected = {
        failed: reason !== "aborted",
        stopped: reason === "aborted",
        needsRetry: reason === "restart_limit",
      };
      expect(projectView(incremental)).toMatchObject(expected);
      expect(projectView(view([], live))).toMatchObject(expected);
    },
  );

  it("does not show the previous failure during a new run", () => {
    const state = projectView(
      view([], {
        run,
        runFailure: { taskId: run.taskId, inputs: [], reason: "model_error" },
      }),
    );
    expect(state).toMatchObject({ running: true, failed: false, stopped: false });
  });
});

const parent = {
  callId: "root",
  name: "codemode",
  taskId: 10 as TaskId,
  status: "running" as const,
};
const child = {
  callId: "opaque-child-id",
  name: "bash",
  taskId: 11 as TaskId,
  parentCallId: "root",
  parentTaskId: 10 as TaskId,
  arguments: { command: "exit 7" },
  status: "running" as const,
  output: "initial",
};

function completedTool(): EntryRecord {
  return {
    id: 3 as EntryId,
    conversationId: 1 as ConversationId,
    kind: "pi.tool-result",
    data: { diagnostics: [] },
    model: [
      {
        role: "toolResult",
        toolCallId: "root",
        toolName: "codemode",
        timestamp: 0,
        content: [{ type: "text", text: "Script completed\nHandled exit 7" }],
        isError: false,
        details: {
          calls: [
            { id: 1, name: "bash", args: '{"command":"exit 7"}', status: "error", error: "exit 7" },
          ],
        },
      },
    ],
  };
}

describe("native nested tool presentation", () => {
  it("applies nested output windows and restores the same failed-child state on reconnect", () => {
    const initial = view([], {
      run,
      tools: [parent],
      nestedTools: [{ ...child, output: "prefix-" }],
    });
    const path = ["docs", "pi.live", "nestedTools", 0, "output"] as const;
    const streamed = applyImmutable(initial, [
      ["t", path, 7],
      ["a", path, "tail"],
    ]);
    expect(toolPresentation(projectView(streamed), "root").calls[0].output).toBe("tail");

    const done = {
      ...child,
      status: "done" as const,
      output: "",
      summary: { isError: true, error: "exit 7" },
    };
    const ended = applyImmutable(streamed, [["s", ["docs", "pi.live", "nestedTools", 0], done]]);
    const restored = view([], { run, tools: [parent], nestedTools: [done] });
    expect(toolPresentation(projectView(ended), "root").calls).toEqual(
      toolPresentation(projectView(restored), "root").calls,
    );
    expect(toolPresentation(projectView(restored), "root").calls[0]).toMatchObject({
      status: "failed",
      error: "exit 7",
    });
  });

  it("retires live child output and restores terminal details without changing a sibling call", () => {
    const entry = completedTool();
    const sibling = { ...parent, callId: "sibling", taskId: 12 as TaskId };
    const initial = view([], { run, tools: [parent, sibling], nestedTools: [child] });
    const ended = projectView(
      applyImmutable(initial, [
        ["s", ["docs", "pi.live"], { run, tools: [sibling] }],
        ["p", ["entries"], 0, 0, [copyJson(entry)]],
      ]),
    );
    expect(Object.keys(ended.tools)).toEqual(["sibling"]);
    const restored = projectView(view([entry]));
    expect(toolPresentation(ended, "root")).toEqual(toolPresentation(restored, "root"));
    expect(toolPresentation(restored, "root")).toMatchObject({
      status: "completed",
      calls: [{ status: "failed", error: "exit 7" }],
    });
  });

  it("uses native abort diagnostics after reopening and does not invent a child summary", () => {
    const entry = completedTool();
    const aborted = {
      ...entry,
      data: {
        diagnostics: [{ severity: "error", code: "aborted", message: "Tool codemode was aborted" }],
      },
      model: entry.model!.map((message) => ({ ...message, isError: true, details: undefined })),
    } as EntryRecord;
    const state = projectView(view([aborted]));
    expect(toolPresentation(state, "root")).toMatchObject({ status: "cancelled", calls: [] });
  });
});
