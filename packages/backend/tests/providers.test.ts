import { afterEach, expect, it, vi } from "vite-plus/test";
import { encryptCredential, decryptCredential } from "../src/models/credentials";
import { configuredProviders, providerCatalog, providerModels } from "../src/models/providers";
import { createModels } from "@earendil-works/pi-ai/models";

const key = btoa("0123456789abcdef0123456789abcdef");
afterEach(() => vi.restoreAllMocks());

it("recovers encrypted credentials only for their provider and encryption key", async () => {
  const encrypted = await encryptCredential(key, "custom-a", "private-fixture-key");
  expect(JSON.stringify(encrypted)).not.toContain("private-fixture-key");
  expect(await decryptCredential(key, "custom-a", encrypted)).toBe("private-fixture-key");
  await expect(decryptCredential(key, "custom-b", encrypted)).rejects.toThrow("decrypt");
  await expect(
    decryptCredential(btoa("abcdef0123456789abcdef0123456789"), "custom-a", encrypted),
  ).rejects.toThrow("decrypt");
  await expect(
    decryptCredential(key, "custom-a", { ...encrypted, ciphertext: encrypted.ciphertext.slice(4) }),
  ).rejects.toThrow("decrypt");
  await expect(encryptCredential(undefined, "custom-a", "fixture")).rejects.toThrow(
    "not configured",
  );
  await expect(encryptCredential(btoa("too short"), "custom-a", "fixture")).rejects.toThrow(
    "not configured",
  );
});

it.each([16, 24])("recovers credentials with a %i-byte AES key", async (length) => {
  const key = btoa("a".repeat(length));
  const encrypted = await encryptCredential(key, "custom-a", "fixture");
  expect(await decryptCredential(key, "custom-a", encrypted)).toBe("fixture");
});

it("lists native providers with their complete chat catalogs without resolving credentials", () => {
  const catalog = providerCatalog();
  for (const id of ["openai", "anthropic"])
    expect(providerModels([{ kind: "builtin", id, options: {} }]).length).toBeGreaterThan(1);
  expect(catalog.some(({ id }) => id === "openai-codex")).toBe(false);
});

it("routes identical model IDs through the chosen custom provider and resolves credentials on demand", async () => {
  const credentials = vi.fn(async (id: string) => ({ type: "api_key" as const, key: `${id}-key` }));
  const providers = configuredProviders(
    ["a", "b"].map((id) => ({
      kind: "custom" as const,
      id,
      name: id,
      api: "openai-completions" as const,
      baseUrl: `https://${id}.example.test/v1`,
      models: [{ id: "shared-model", name: "Shared", contextWindow: 8192, maxTokens: 1024 }],
    })),
    credentials,
  );
  const models = createModels();
  providers.forEach((provider) => models.setProvider(provider));
  expect(credentials).not.toHaveBeenCalled();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (resource, options) => {
    const request = new Request(resource, options);
    expect(request.url).toBe("https://b.example.test/v1/chat/completions");
    expect(request.headers.get("Authorization")).toBe("Bearer b-key");
    return new Response(
      'data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const model = models.getModel("b", "shared-model");
  if (!model) throw new Error("Missing fixture model");
  const response = await models.completeSimple(model, {
    messages: [{ role: "user", content: "Hi", timestamp: 1 }],
  });
  expect(response.content).toContainEqual({ type: "text", text: "Hello" });
  expect(credentials).toHaveBeenCalledWith("b");
});
