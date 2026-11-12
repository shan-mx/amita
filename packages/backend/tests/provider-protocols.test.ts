import { afterEach, expect, it, vi } from "vite-plus/test";
import { createModels } from "@earendil-works/pi-ai/models";
import { configuredProviders } from "../src/models/providers";
import { MODEL_APIS } from "../src/models/schema";

afterEach(() => vi.restoreAllMocks());
const sse = (events: { type?: string; [key: string]: unknown }[], named = false) =>
  new Response(
    events
      .map((event) => `${named ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );

for (const api of MODEL_APIS) {
  it(`continues a tool round using the native ${api} wire protocol`, async () => {
    const models = createModels();
    const [provider] = configuredProviders(
      [
        {
          kind: "custom",
          id: "protocol-fixture",
          name: "Protocol",
          api,
          baseUrl:
            api === "anthropic-messages"
              ? "https://protocol.example.test"
              : "https://protocol.example.test/v1",
          models: [{ id: "fixture-chat", name: "Chat", contextWindow: 8192, maxTokens: 1024 }],
        },
      ],
      async () => ({ type: "api_key", key: "protocol-key" }),
    );
    models.setProvider(provider);
    let round = 0;
    const observed: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (resource, init) => {
      const request = new Request(resource, init);
      observed.push(request.url);
      const body = await request.text();
      const tool = round++ === 0;
      if (!tool) expect(body).toContain("TOOL_RESULT_MARKER");
      if (api === "openai-completions") {
        expect(request.url).toBe("https://protocol.example.test/v1/chat/completions");
        expect(request.headers.get("authorization")).toBe("Bearer protocol-key");
        return sse([
          {
            id: "chat",
            choices: [
              {
                index: 0,
                delta: tool
                  ? {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "tool_fixture",
                          type: "function",
                          function: { name: "lookup", arguments: "{}" },
                        },
                      ],
                    }
                  : { role: "assistant", content: "Complete" },
                finish_reason: tool ? "tool_calls" : "stop",
              },
            ],
          },
        ]);
      }
      if (api === "anthropic-messages") {
        expect(new URL(request.url).pathname).toBe("/v1/messages");
        expect(request.headers.get("x-api-key")).toBe("protocol-key");
        return sse(
          [
            {
              type: "message_start",
              message: {
                id: "msg",
                type: "message",
                role: "assistant",
                model: "fixture-chat",
                content: [],
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: tool
                ? { type: "tool_use", id: "tool_fixture", name: "lookup", input: {} }
                : { type: "text", text: "Complete" },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: tool ? "tool_use" : "end_turn" },
              usage: { output_tokens: 1 },
            },
            { type: "message_stop" },
          ],
          true,
        );
      }
      if (api === "google-generative-ai") {
        expect(request.url).toContain("/models/fixture-chat:streamGenerateContent");
        expect(request.headers.get("x-goog-api-key")).toBe("protocol-key");
        return sse([
          {
            candidates: [
              {
                index: 0,
                content: {
                  role: "model",
                  parts: [
                    tool
                      ? { functionCall: { id: "tool_fixture", name: "lookup", args: {} } }
                      : { text: "Complete" },
                  ],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          },
        ]);
      }
      expect(request.url).toBe("https://protocol.example.test/v1/responses");
      expect(request.headers.get("authorization")).toBe("Bearer protocol-key");
      const item = tool
        ? {
            type: "function_call",
            id: "fc_fixture",
            call_id: "tool_fixture",
            name: "lookup",
            arguments: "{}",
            status: "completed",
          }
        : {
            type: "message",
            id: "msg_fixture",
            role: "assistant",
            content: [{ type: "output_text", text: "Complete", annotations: [] }],
            status: "completed",
          };
      return sse([
        {
          type: "response.created",
          response: {
            id: "resp_fixture",
            model: "fixture-chat",
            status: "in_progress",
            output: [],
          },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: tool ? { ...item, arguments: "" } : { ...item, content: [] },
        },
        ...(tool
          ? [
              {
                type: "response.function_call_arguments.delta",
                item_id: "fc_fixture",
                output_index: 0,
                delta: "{}",
              },
            ]
          : [
              {
                type: "response.content_part.added",
                output_index: 0,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
              },
              {
                type: "response.output_text.delta",
                item_id: "msg_fixture",
                output_index: 0,
                content_index: 0,
                delta: "Complete",
              },
            ]),
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "resp_fixture",
            model: "fixture-chat",
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]);
    });
    const model = models.getModel(provider.id, "fixture-chat");
    if (!model) throw new Error("Missing protocol fixture");
    const user = { role: "user" as const, content: "Use lookup", timestamp: 1 };
    const tools = [
      {
        name: "lookup",
        description: "Look up a value",
        parameters: { type: "object" as const, properties: {} },
      },
    ];
    const first = await models.completeSimple(model, { messages: [user], tools });
    const call = first.content.find((part) => part.type === "toolCall");
    expect(first.stopReason, JSON.stringify({ error: first.errorMessage, observed })).toBe(
      "toolUse",
    );
    if (!call) throw new Error(JSON.stringify(first));
    const second = await models.completeSimple(model, {
      tools,
      messages: [
        user,
        first,
        {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: "TOOL_RESULT_MARKER" }],
          isError: false,
          timestamp: 2,
        },
      ],
    });
    expect(second.content).toContainEqual(
      expect.objectContaining({ type: "text", text: "Complete" }),
    );
    expect(second.stopReason).toBe("stop");
  });
}
