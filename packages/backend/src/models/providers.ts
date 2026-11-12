import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import type { ApiKeyCredential, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { MODEL_REASONING_LEVELS, PROMPT_SECTIONS } from "../shared/config";
import { PROVIDER_COPY } from "../shared/config";
import type { ModelOption, ProviderConfig } from "./schema";

type ProviderField = { name: string; label: string; required?: boolean; placeholder?: string };
const AZURE_DEPLOYMENT_MAPPINGS = "AZURE_OPENAI_DEPLOYMENT_NAME_MAP";
const providerFields: Record<string, ProviderField[]> = {
  "cloudflare-workers-ai": [{ name: "CLOUDFLARE_ACCOUNT_ID", label: "Account ID", required: true }],
  "cloudflare-ai-gateway": [
    { name: "CLOUDFLARE_ACCOUNT_ID", label: "Account ID", required: true },
    { name: "CLOUDFLARE_GATEWAY_ID", label: "Gateway ID", required: true },
  ],
  azure: [
    { name: "AZURE_OPENAI_BASE_URL", label: "Endpoint", required: true },
    { name: "AZURE_OPENAI_API_VERSION", label: "API version" },
    {
      name: AZURE_DEPLOYMENT_MAPPINGS,
      label: "Deployment mappings",
      placeholder: "model-id=deployment-name, another-model=another-deployment",
    },
  ],
  "amazon-bedrock": [{ name: "AWS_REGION", label: "Region", required: true }],
};
const nativeProviders = builtinProviders().filter(
  (provider) => provider.auth.apiKey?.login && provider.getModels().length,
);
export function providerCatalog() {
  return nativeProviders.map((provider) => ({
    id: provider.id,
    name: provider.name,
    fields: providerFields[provider.id] ?? [],
  }));
}

function customProvider(config: Extract<ProviderConfig, { kind: "custom" }>): Provider {
  const apis = {
    "openai-completions": openAICompletionsApi,
    "openai-responses": openAIResponsesApi,
    "anthropic-messages": anthropicMessagesApi,
    "google-generative-ai": googleGenerativeAIApi,
  };
  return createProvider({
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: "API key",
        resolve: async ({ credential }) =>
          credential?.key ? { auth: { apiKey: credential.key } } : undefined,
      },
    },
    api: apis[config.api](),
    models: config.models.map((profile): Model<typeof config.api> => ({
      id: profile.id,
      name: profile.name,
      api: config.api,
      provider: config.id,
      baseUrl: config.baseUrl,
      contextWindow: profile.contextWindow,
      maxTokens: profile.maxTokens,
      reasoning: !!profile.reasoningLevels?.length,
      thinkingLevelMap: Object.fromEntries(
        MODEL_REASONING_LEVELS.map((level) => [
          level,
          profile.reasoningLevels?.includes(level) ? level : null,
        ]),
      ),
      input: profile.acceptsImages ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(config.api === "openai-completions"
        ? {
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsUsageInStreaming: false,
              maxTokensField: profile.maxTokensField ?? "max_tokens",
            },
          }
        : {}),
    })),
  });
}

function resolveProvider(config: ProviderConfig): Provider {
  const provider =
    config.kind === "custom"
      ? customProvider(config)
      : nativeProviders.find(({ id }) => id === config.id);
  if (!provider) throw new Error(PROVIDER_COPY.invalid);
  return provider;
}

function prompt(context: TranscriptContext) {
  const sections = getCurrentSystemMessage(context.messages)?.sections;
  if (!sections) return;
  for (const key of Object.values(PROMPT_SECTIONS))
    if (!Object.hasOwn(sections, key)) throw new Error(`Missing prompt section "${key}".`);
}

export function configuredProviders(
  configs: readonly ProviderConfig[],
  credential: (id: string) => Promise<ApiKeyCredential | undefined>,
): Provider[] {
  return configs.map((config) => {
    const provider = resolveProvider(config);
    const auth = provider?.auth.apiKey;
    if (!provider || !auth) throw new Error(PROVIDER_COPY.invalid);
    return {
      ...provider,
      auth: {
        apiKey: {
          ...auth,
          resolve: async (input) => {
            const saved = await credential(config.id);
            return saved ? auth.resolve({ ...input, credential: saved }) : undefined;
          },
          check: async () => ({ type: "api_key", source: "Configured" }),
        },
      },
      stream(model, context, options) {
        prompt(context);
        return provider.stream(model, context, options);
      },
      streamSimple(model, context, options) {
        prompt(context);
        return provider.streamSimple(model, context, options);
      },
    };
  });
}

export function providerModels(configs: readonly ProviderConfig[]): ModelOption[] {
  return configs
    .map(resolveProvider)
    .flatMap((provider) =>
      provider
        .getModels()
        .map(({ id, name }) => ({ provider: provider.id, providerName: provider.name, id, name })),
    );
}

export function validateProvider(config: ProviderConfig) {
  if (config.kind === "custom") return;
  const mapping = config.options[AZURE_DEPLOYMENT_MAPPINGS];
  if (config.id === "azure" && mapping) {
    for (const entry of mapping.split(",")) {
      const parts = entry.split("=");
      if (parts.length !== 2 || parts.some((part) => !part.trim()))
        throw new Error(PROVIDER_COPY.invalid);
    }
  }
  const descriptor = providerCatalog().find(({ id }) => id === config.id);
  if (
    !descriptor ||
    descriptor.fields.some((field) => field.required && !config.options[field.name]) ||
    Object.keys(config.options).some(
      (name) => !descriptor.fields.some((field) => field.name === name),
    )
  )
    throw new Error(PROVIDER_COPY.invalid);
}
