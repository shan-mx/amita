import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { configured } from "../src/http/auth";
import type { Env } from "../src/env";
import { codemodeToolCall, modelFixture, owner, createAgent, WAIT } from "./helpers";

afterEach(() => vi.restoreAllMocks());

it("allows Owner login without a provider or encryption key", () => {
  expect(
    configured({ ...(env as unknown as Env), AMITA_CREDENTIAL_ENCRYPTION_KEY: undefined }),
  ).toBe(true);
  expect(configured({ ...(env as unknown as Env), AMITA_OWNER_PASSWORD: "" })).toBe(false);
});

it("discovers model metadata using an encrypted saved key and leaves unknown limits unset", async () => {
  const account = owner({ setupModels: false });
  await account.login();
  const saved = await account.client.providers.save({
    config: {
      kind: "custom",
      name: "Discovery",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      models: [],
    },
    apiKey: "test-model-key",
  });
  modelFixture(
    () => ({ text: "Discovered model response" }),
    (request) => {
      expect(request.headers.get("authorization")).toBe("Bearer test-model-key");
      return Response.json({
        data: [
          {
            id: "deepseek-flash",
            context_window: 64000,
            max_output_tokens: 4096,
            input_modalities: ["text", "image"],
            effort: { supported_levels: ["low", "high"] },
          },
          { id: "unknown-model" },
        ],
      });
    },
  );
  const candidates = await account.client.providers.discover({ config: saved.config });
  expect(candidates[0]).toMatchObject({
    id: "deepseek-flash",
    contextWindow: 64000,
    maxTokens: 4096,
    acceptsImages: true,
    reasoningLevels: ["low", "high"],
  });
  expect(candidates[1]).toMatchObject({ id: "unknown-model" });
  expect(candidates[1].contextWindow).toBeUndefined();
  expect(candidates[1].maxTokens).toBeUndefined();
});

it("steers a busy session on its original model and admits a repeated operation only once", async () => {
  const { client, login } = owner();
  await login();
  const originalModelId = "deepseek-flash";
  const newDefaultModelId = "deepseek-v4-pro";
  const { agent, sessionId } = await createAgent(client, { name: "Steering", persona: "" });
  const target = { agentId: agent.id, sessionId };
  const submit = (text: string, operationId = crypto.randomUUID()) =>
    client.sessions.submit({ ...target, text, operationId });
  const initialText = "Start the run";
  const steerText = "Steer the run";
  const nextText = "Start a new run";
  const operationId = crypto.randomUUID();
  let releaseFirstRequest!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    releaseFirstRequest = resolve;
  });
  const model = modelFixture(async ({ messages }) => {
    if (messages.at(-1)?.content === initialText) {
      await firstRequest;
      return { tool: codemodeToolCall("computer_list", {}) };
    }
    return { text: "Done" };
  });

  try {
    await expect(submit(initialText)).resolves.toMatchObject({ accepted: true });
    await vi.waitFor(() => {
      expect(model.requests).toHaveLength(1);
      expect(model.requests[0]?.model).toBe(originalModelId);
    }, WAIT);
    await client.agents.setModel({
      agentId: agent.id,
      model: { provider: agent.model!.provider, modelId: newDefaultModelId },
    });

    const receipts = await Promise.all([
      submit(steerText, operationId),
      submit(steerText, operationId),
    ]);
    expect(receipts.map(({ accepted }) => accepted)).toEqual(expect.arrayContaining([true, false]));
    for (const receipt of receipts)
      expect(receipt).toMatchObject({ operationId, session: sessionId });
  } finally {
    releaseFirstRequest();
  }

  await vi.waitFor(async () => {
    const [session] = await client.sessions.list({ agentId: agent.id });
    expect(session?.busy).toBe(false);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.model).toBe(originalModelId);
    expect(
      model.requests[1]?.messages.filter(
        ({ role, content }) => role === "user" && content === steerText,
      ),
    ).toHaveLength(1);
  }, WAIT);

  await expect(submit(steerText, operationId)).resolves.toEqual({
    operationId,
    session: sessionId,
    accepted: false,
  });
  await expect(submit(nextText)).resolves.toMatchObject({ accepted: true });
  await vi.waitFor(() => {
    expect(model.requests).toHaveLength(3);
    expect(model.requests[2]?.model).toBe(originalModelId);
    expect(model.requests[2]?.messages.at(-1)).toMatchObject({ role: "user", content: nextText });
  }, WAIT);
});

it("reports a removed Automation model and permits pause before repairing it", async () => {
  const { client, login } = owner();
  await login();
  const saved = (await client.providers.list()).find(
    ({ config }) => config.kind === "custom" && config.name === "Fixture model service",
  );
  if (!saved || saved.config.kind !== "custom") throw new Error("Expected a custom fixture");
  const { agent } = await createAgent(client, { name: "Unavailable model", persona: "" });
  const input = { agentId: agent.id, id: crypto.randomUUID() };
  const removed = "deepseek-v4-pro";
  const at = Date.now() + 60_000;
  await client.automations.create({
    ...input,
    definition: {
      name: "Explicit model",
      trigger: { type: "once", runAt: new Date(at).toISOString() },
      timezone: "Asia/Taipei",
      prompt: "This should never reach the model.",
      execution: { kind: "new_session", model: { provider: saved.config.id, modelId: removed } },
      enabled: true,
    },
  });
  await client.providers.save({
    config: { ...saved.config, models: saved.config.models.filter(({ id }) => id !== removed) },
  });
  const model = modelFixture(() => ({ text: "Unexpected inference" }));
  const stub = (env as unknown as Env).AGENTS.getByName(agent.id);
  await vi.waitFor(async () => {
    expect(
      await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    ).not.toBeNull();
  }, WAIT);
  await evictDurableObject(stub);
  vi.spyOn(Date, "now").mockReturnValue(at + 1);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await vi.waitFor(async () => {
    const { runs } = await client.automations.history(input);
    expect(runs[0]).toMatchObject({
      status: "failed",
      error: `Model “${saved.config.id} / deepseek-v4-pro” is unavailable. Choose an available model in the automation settings.`,
    });
  }, WAIT);
  expect(model.requests).toEqual([]);
  await expect(
    client.automations.update({ ...input, patch: { enabled: false } }),
  ).resolves.toMatchObject({
    definition: {
      enabled: false,
      execution: { kind: "new_session", model: { provider: saved.config.id, modelId: removed } },
    },
  });
  await expect(
    client.automations.update({ ...input, patch: { enabled: true } }),
  ).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});
