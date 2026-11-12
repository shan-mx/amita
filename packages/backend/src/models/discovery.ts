import { z } from "zod";
import { MODEL_REASONING_LEVELS } from "../shared/config";
import { modelIdSchema as modelId, type ModelProfile } from "./schema";

const tokenLimit = z.number().int().positive();
const name = modelId;
type ModelConnection = { baseUrl: string; apiKey: string };

const upstreamModel = z.object({
  id: modelId,
  name: z.unknown().optional(),
  context_window: z.unknown().optional(),
  max_output_tokens: z.unknown().optional(),
  input_modalities: z.unknown().optional(),
  output_modalities: z.unknown().optional(),
  effort: z.unknown().optional(),
});
export type ModelCandidate = Pick<ModelProfile, "id" | "name"> &
  Partial<Pick<ModelProfile, "contextWindow" | "maxTokens" | "acceptsImages" | "reasoningLevels">>;

const reasoningMetadata = z.object({ supported_levels: z.array(z.string()) });

export async function discoverModels(connection: ModelConnection): Promise<ModelCandidate[]> {
  const response = await fetch(`${connection.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${connection.apiKey}` },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Model discovery failed");
  const { data } = z.object({ data: z.array(z.unknown()) }).parse(await response.json());
  const candidates = new Map<string, ModelCandidate>();
  for (const item of data) {
    const parsed = upstreamModel.safeParse(item);
    if (!parsed.success) continue;
    const model = parsed.data;
    const modalities = [model.input_modalities, model.output_modalities];
    if (modalities.some((items) => Array.isArray(items) && !items.includes("text"))) continue;
    const efforts = reasoningMetadata.safeParse(model.effort).data?.supported_levels;
    const reasoningLevels =
      efforts && MODEL_REASONING_LEVELS.filter((level) => efforts.includes(level));
    candidates.set(model.id, {
      id: model.id,
      name: name.safeParse(model.name).data ?? model.id,
      contextWindow: tokenLimit.safeParse(model.context_window).data,
      maxTokens: tokenLimit.safeParse(model.max_output_tokens).data,
      acceptsImages: Array.isArray(model.input_modalities)
        ? model.input_modalities.includes("image")
        : undefined,
      reasoningLevels,
    });
  }
  return [...candidates.values()];
}
