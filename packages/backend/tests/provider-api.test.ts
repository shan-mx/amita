import { afterEach, expect, it, vi } from "vite-plus/test";
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { owner } from "./helpers";
import { directory } from "../src/deployment/directory";
import type { Env } from "../src/env";
import { configuredProviders } from "../src/models/providers";
import { createModels } from "@earendil-works/pi-ai/models";

afterEach(() => vi.restoreAllMocks());
const config = {
  kind: "custom" as const,
  name: "Fixture gateway",
  api: "openai-completions" as const,
  baseUrl: "https://provider.example.test/v1",
  models: [{ id: "fixture", name: "Fixture", contextWindow: 8192, maxTokens: 1024 }],
};

it("stores encrypted Owner credentials, preserves an unchanged key and recovers after eviction", async () => {
  const account = owner({ setupModels: false });
  await expect(account.client.providers.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await account.login();
  const saved = await account.client.providers.save({ config, apiKey: "PRIVATE_PROVIDER_KEY" });
  expect(JSON.stringify(saved)).not.toContain("PRIVATE_PROVIDER_KEY");
  expect(saved.config.id).toMatch(/^custom-/);
  const stub = directory(env as unknown as Env);
  const persisted = await runInDurableObject(stub, (_instance, state) => [
    ...state.storage.kv.list(),
  ]);
  expect(JSON.stringify(persisted)).not.toContain("PRIVATE_PROVIDER_KEY");
  if (saved.config.kind !== "custom") throw new Error("Expected a custom provider");
  await account.client.providers.save({ config: { ...saved.config, name: "Renamed" } });
  await evictDurableObject(stub);
  expect(await account.client.providers.list()).toMatchObject([
    { config: { name: "Renamed" }, hasApiKey: true },
  ]);
  const models = createModels();
  configuredProviders(await stub.providerConfigs(), (id) => stub.providerCredential(id)).forEach(
    (provider) => models.setProvider(provider),
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(async (resource, init) => {
    const request = new Request(resource, init);
    expect(request.headers.get("authorization")).toBe("Bearer PRIVATE_PROVIDER_KEY");
    return new Response(
      'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"Recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const model = models.getModel(saved.config.id, "fixture");
  if (!model) throw new Error("Missing saved model");
  expect(
    (
      await models.completeSimple(model, {
        messages: [{ role: "user", content: "Hi", timestamp: 1 }],
      })
    ).content,
  ).toContainEqual({ type: "text", text: "Recovered" });
  await account.client.providers.remove({ id: saved.config.id });
  expect(await account.client.providers.list()).toEqual([]);
  expect(await stub.providerCredential(saved.config.id)).toBeUndefined();
});

it("exposes the complete native catalog after configuring a provider without revealing its key", async () => {
  const account = owner({ setupModels: false });
  await account.login();
  await account.client.providers.save({
    config: { kind: "builtin", id: "anthropic", options: {} },
    apiKey: "PRIVATE_NATIVE_KEY",
  });
  const options = await account.client.providers.models();
  expect(options.length).toBeGreaterThan(1);
  expect(options.every(({ provider }) => provider === "anthropic")).toBe(true);
  expect(JSON.stringify(await account.client.providers.list())).not.toContain("PRIVATE_NATIVE_KEY");
  await expect(
    account.client.providers.save({
      config: { kind: "builtin", id: "unknown", options: {} },
      apiKey: "fixture",
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

it("validates Azure mappings and sends the selected model to its named deployment", async () => {
  const account = owner({ setupModels: false });
  await account.login();
  const options = { AZURE_OPENAI_BASE_URL: "https://azure.example.test/openai/v1" };
  await expect(
    account.client.providers.save({
      config: {
        kind: "builtin",
        id: "azure",
        options: { ...options, AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "production-deployment" },
      },
      apiKey: "AZURE_FIXTURE_KEY",
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const [azure] = configuredProviders(
    [{ kind: "builtin", id: "azure", options }],
    async () => undefined,
  );
  const model = azure.getModels().find(({ api }) => api === "openai-completions");
  if (!model) throw new Error("Missing native Azure Chat Completions model");
  await account.client.providers.save({
    config: {
      kind: "builtin",
      id: "azure",
      options: {
        ...options,
        AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `other-model=other-deployment, ${model.id} = production-deployment`,
      },
    },
    apiKey: "AZURE_FIXTURE_KEY",
  });
  const deployment = directory(env as unknown as Env);
  configuredProviders(await deployment.providerConfigs(), (id) =>
    deployment.providerCredential(id),
  ).forEach((provider) => models.setProvider(provider));
  const payloads: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (resource, init) => {
    const request = new Request(resource, init);
    expect(request.url).toBe("https://azure.example.test/openai/v1/chat/completions");
    expect(request.headers.get("authorization")).toBe("Bearer AZURE_FIXTURE_KEY");
    payloads.push(await request.json());
    return new Response(
      'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"Azure routed"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const response = await models.completeSimple(model, {
    messages: [{ role: "user", content: "Hello", timestamp: 1 }],
  });
  expect(response.content).toContainEqual({ type: "text", text: "Azure routed" });
  expect(payloads).toEqual([expect.objectContaining({ model: "production-deployment" })]);
});
