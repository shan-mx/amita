import { SELF, env, runInDurableObject } from "cloudflare:test";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "../src/http/router";
import type { Env } from "../src/env";
import type { AutomationTriggerInput } from "../src/shared/automations";
import { directory } from "../src/deployment/directory";
import type { ModelRef, ModelProfile } from "../src/models/schema";
import type { ApiClient } from "../src/types";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { vi } from "vite-plus/test";

export const automationTriggerSoon = (): AutomationTriggerInput => ({
  type: "once",
  runAt: new Date(Date.now() + 1_000).toISOString(),
});

export const WAIT = { timeout: 8_000, interval: 25 };
const TEST_MODELS: { models: ModelProfile[] } = {
  models: [
    {
      id: "deepseek-flash",
      name: "DeepSeek Flash",
      contextWindow: 128_000,
      maxTokens: 8192,
      reasoningLevels: ["high"],
    },
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      contextWindow: 128_000,
      maxTokens: 8192,
      reasoningLevels: ["high"],
    },
  ],
};

export async function setupTestProviders() {
  const deployment = directory(env as unknown as Env);
  const existing = (await deployment.providersList()).find(
    ({ config }) => config.kind === "custom" && config.name === "Fixture model service",
  );
  if (existing) return existing.config.id;
  const saved = await deployment.providerSave({
    config: {
      kind: "custom",
      name: "Fixture model service",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      models: TEST_MODELS.models,
    },
    apiKey: "test-model-key",
  });
  return saved.config.id;
}

export async function createAgent(
  client: ApiClient,
  input: Omit<Parameters<ApiClient["agents"]["create"]>[0], "model"> & { model?: ModelRef },
) {
  const available = await client.providers.models();
  const model =
    available.find(
      (option) => option.providerName === "Fixture model service" && option.id === "deepseek-flash",
    ) ?? available[0];
  if (!model && !input.model) throw new Error("Configure a fixture model before creating an Agent");
  return client.agents.create({
    ...input,
    model: input.model ?? { provider: model.provider, modelId: model.id },
  });
}

export function owner({ setupModels = true } = {}) {
  let cookie = "";
  const origin = "https://amita.test";
  const ip = crypto.randomUUID();
  const client: RouterClient<AppRouter> = createORPCClient(
    new RPCLink({
      url: `${origin}/api/rpc`,
      fetch: async (resource, options) => {
        const request = new Request(resource, options);
        const headers = new Headers(request.headers);
        headers.set("Origin", origin);
        headers.set("CF-Connecting-IP", ip);
        if (cookie) headers.set("Cookie", cookie);
        const response = await SELF.fetch(new Request(request, { headers }));
        const value = response.headers.get("Set-Cookie");
        if (value) cookie = value.split(";")[0];
        return response;
      },
    }),
  );
  return {
    client,
    cookie: () => cookie,
    login: async () => {
      const login = await client.auth.login({ password: "test-owner-password" });
      if (setupModels) await setupTestProviders();
      return login;
    },
  };
}
export async function appendMessage(
  agentId: string,
  sessionId: string,
  role: "user" | "assistant",
  text: string,
) {
  const bindings = env as unknown as Env;
  return runInDurableObject(
    bindings.AGENTS.get(bindings.AGENTS.idFromName(agentId)),
    async (instance) => {
      const conversation = await instance.harness.conversation(sessionId);
      return conversation.commit(async (tx) => {
        const message =
          role === "user"
            ? { role: "user" as const, content: text, timestamp: Date.now() }
            : {
                role: "assistant" as const,
                content: [{ type: "text" as const, text }],
                api: "openai-completions",
                provider: "deepseek",
                model: "deepseek-flash",
                stopReason: "stop" as const,
                timestamp: Date.now(),
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
              };
        return Number(
          (await tx.appendEntry(conversation.id, { kind: "amita.fixture", model: [message] })).id,
        );
      }, BG);
    },
  );
}
export type ModelRequest = {
  messages: { role: string; content: unknown }[];
  model: string;
  thinking?: { type: string };
  tools?: { function: { name: string; description: string; parameters: unknown } }[];
};
type ModelReply = { text?: string; tool?: { name: string; arguments: object } };

export function codemodeToolCall(name: string, args: object) {
  return {
    name: "codemode",
    arguments: { code: `return await tools[${JSON.stringify(name)}](${JSON.stringify(args)});` },
  };
}

export function modelFixture(
  respond: (body: ModelRequest, signal: AbortSignal) => ModelReply | Promise<ModelReply>,
  discover?: (request: Request) => Response,
) {
  const original = globalThis.fetch;
  const requests: ModelRequest[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (resource, options) => {
    const request = new Request(resource, options);
    if (!request.url.startsWith("https://api.deepseek.com/")) return original(resource, options);
    if (request.url === "https://api.deepseek.com/models" && discover) return discover(request);
    const body = (await request.json()) as ModelRequest;
    const naming = body.thinking?.type === "disabled";
    if (!naming) requests.push(body);
    const reply = naming ? { text: "Fixture session title" } : await respond(body, request.signal);
    const encoder = new TextEncoder();
    const delta = reply.tool
      ? {
          tool_calls: [
            {
              index: 0,
              id: crypto.randomUUID(),
              type: "function",
              function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.arguments) },
            },
          ],
        }
      : { content: reply.text ?? "Done." };
    const chunk = (value: unknown, reason: string | null = null) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "deepseek-flash", choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
    return new Response(
      encoder.encode(
        chunk({ role: "assistant", reasoning_content: "Fixture reasoning." }) +
          (reply.tool && reply.text ? chunk({ content: reply.text }) : "") +
          chunk(delta) +
          chunk({}, reply.tool ? "tool_calls" : "stop") +
          "data: [DONE]\n\n",
      ),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  return { requests };
}
