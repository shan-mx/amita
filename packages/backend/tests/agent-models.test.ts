import { afterEach, expect, it, vi } from "vite-plus/test";
import { owner, WAIT, modelFixture } from "./helpers";
import { SELF } from "cloudflare:test";

afterEach(() => vi.restoreAllMocks());

it("requires an Agent model and keeps existing sessions independent of later Agent choices", async () => {
  const account = owner({ setupModels: false });
  await account.login();
  const provider = await account.client.providers.save({
    config: {
      kind: "custom",
      name: "Agent fixture",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      models: ["deepseek-flash", "deepseek-v4-pro"].map((id) => ({
        id,
        name: id,
        contextWindow: 128000,
        maxTokens: 8192,
        reasoningLevels: ["high"],
      })),
    },
    apiKey: "test-model-key",
  });
  const firstModel = { provider: provider.config.id, modelId: "deepseek-flash" };
  const secondModel = { ...firstModel, modelId: "deepseek-v4-pro" };
  const missing = await SELF.fetch("https://amita.test/api/rpc/agents/create", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://amita.test",
      Cookie: account.cookie(),
    },
    body: JSON.stringify({ json: { name: "Missing model", persona: "" } }),
  });
  expect(missing.status).toBe(400);
  const { agent, sessionId } = await account.client.agents.create({
    name: "First Agent",
    persona: "",
    model: firstModel,
  });
  const other = await account.client.agents.create({
    name: "Second Agent",
    persona: "",
    model: secondModel,
  });
  expect(agent.model).toEqual(firstModel);
  expect(other.agent.model).toEqual(secondModel);
  const inference = modelFixture(() => ({ text: "Agent response" }));
  await account.client.agents.setModel({ agentId: agent.id, model: secondModel });
  const next = await account.client.sessions.create({ agentId: agent.id });
  const sessions = await account.client.sessions.list({ agentId: agent.id });
  expect(sessions.find(({ id }) => id === sessionId)?.model).toEqual(firstModel);
  expect(sessions.find(({ id }) => id === next.id)?.model).toEqual(secondModel);
  await account.client.sessions.submit({
    agentId: agent.id,
    sessionId,
    text: "Continue existing session",
    operationId: crypto.randomUUID(),
  });
  await vi.waitFor(async () => {
    expect(
      (await account.client.sessions.list({ agentId: agent.id })).find(({ id }) => id === sessionId)
        ?.busy,
    ).toBe(false);
    expect(inference.requests.at(-1)?.model).toBe(firstModel.modelId);
  }, WAIT);
});
