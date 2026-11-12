import { afterEach, expect, it, vi } from "vite-plus/test";
import { env, evictDurableObject } from "cloudflare:test";
import type { Env } from "../src/env";
import { createAgent, owner, modelFixture, codemodeToolCall, WAIT } from "./helpers";

afterEach(() => vi.restoreAllMocks());

it("rejects model changes throughout a running tool round and persists an idle selection", async () => {
  const account = owner();
  await account.login();
  const { agent, sessionId } = await createAgent(account.client, {
    name: "Session model",
    persona: "",
  });
  if (!agent.model) throw new Error("Missing fixture model");
  const first = agent.model;
  const second = { ...first, modelId: "deepseek-v4-pro" };
  const target = { agentId: agent.id, sessionId };
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inference = modelFixture(async ({ messages }) => {
    if (messages.at(-1)?.content === "Start") {
      await gate;
      return { tool: codemodeToolCall("computer_list", {}) };
    }
    return { text: "Finished" };
  });
  try {
    await account.client.sessions.submit({
      ...target,
      text: "Start",
      operationId: crypto.randomUUID(),
    });
    await vi.waitFor(() => expect(inference.requests).toHaveLength(1), WAIT);
    await expect(
      account.client.sessions.setModel({ ...target, model: second }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await account.client.sessions.submit({
      ...target,
      text: "Steer",
      operationId: crypto.randomUUID(),
    });
  } finally {
    release();
  }
  await vi.waitFor(
    async () =>
      expect((await account.client.sessions.list({ agentId: agent.id }))[0].busy).toBe(false),
    WAIT,
  );
  expect(inference.requests.map(({ model }) => model)).toEqual([first.modelId, first.modelId]);
  await account.client.sessions.setModel({ ...target, model: second });
  await evictDurableObject((env as unknown as Env).AGENTS.getByName(agent.id));
  expect((await account.client.sessions.list({ agentId: agent.id }))[0].model).toEqual(second);
  await account.client.sessions.submit({
    ...target,
    text: "New turn",
    operationId: crypto.randomUUID(),
  });
  await vi.waitFor(() => expect(inference.requests.at(-1)?.model).toBe(second.modelId), WAIT);
});

it("does not silently replace a removed session model with the Agent model", async () => {
  const account = owner();
  await account.login();
  const { agent, sessionId } = await createAgent(account.client, {
    name: "Unavailable",
    persona: "",
  });
  const [provider] = await account.client.providers.list();
  if (!agent.model || provider.config.kind !== "custom")
    throw new Error("Missing fixture provider");
  await account.client.agents.setModel({
    agentId: agent.id,
    model: { ...agent.model, modelId: "deepseek-v4-pro" },
  });
  await account.client.providers.save({
    config: {
      ...provider.config,
      models: provider.config.models.filter(({ id }) => id !== agent.model?.modelId),
    },
  });
  await expect(
    account.client.sessions.submit({
      agentId: agent.id,
      sessionId,
      text: "Keep history",
      operationId: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  expect((await account.client.sessions.list({ agentId: agent.id }))[0].model).toEqual(agent.model);
});
