import { z } from "zod";
import { MODEL_REASONING_LEVELS } from "../shared/config";

export const modelIdSchema = z.string().trim().min(1).max(256);
export const modelRefSchema = z.object({ provider: modelIdSchema, modelId: modelIdSchema });
export type ModelRef = z.infer<typeof modelRefSchema>;
export const modelProfileSchema = z
  .object({
    id: modelIdSchema,
    name: modelIdSchema,
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    acceptsImages: z.boolean().optional(),
    reasoningLevels: z.array(z.enum(MODEL_REASONING_LEVELS)).optional(),
    maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
  })
  .refine(({ contextWindow, maxTokens }) => maxTokens < contextWindow);
export type ModelProfile = z.infer<typeof modelProfileSchema>;
export const MODEL_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export const baseUrlSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\/+$/, ""))
  .refine((value) => {
    const url = URL.parse(value);
    if (!url || url.username || url.password || url.search || url.hash) return false;
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    );
  });
const builtinSchema = z.object({
  kind: z.literal("builtin"),
  id: modelIdSchema,
  options: z.record(z.string(), z.string().trim()).default({}),
});
const customSchema = z.object({
  kind: z.literal("custom"),
  id: modelIdSchema,
  name: modelIdSchema,
  api: z.enum(MODEL_APIS),
  baseUrl: baseUrlSchema,
  models: z
    .array(modelProfileSchema)
    .refine((models) => new Set(models.map(({ id }) => id)).size === models.length),
});
export const providerConfigSchema = z.discriminatedUnion("kind", [builtinSchema, customSchema]);
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export const providerWriteSchema = z.object({
  config: z.discriminatedUnion("kind", [
    builtinSchema,
    customSchema.omit({ id: true }).extend({ id: modelIdSchema.optional() }),
  ]),
  apiKey: z.string().trim().min(1).max(16_384).optional(),
});
export type ProviderWrite = z.infer<typeof providerWriteSchema>;
export type ModelOption = { provider: string; providerName: string; id: string; name: string };
export type ProviderInfo = { config: ProviderConfig; hasApiKey: boolean };
export const sameModel = (a: ModelRef | null | undefined, b: ModelRef | null | undefined) =>
  a?.provider === b?.provider && a?.modelId === b?.modelId;
export const modelValue = (ref: ModelRef) => JSON.stringify([ref.provider, ref.modelId]);
