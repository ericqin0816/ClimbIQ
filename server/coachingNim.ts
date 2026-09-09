import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { buildCoachingCatalog, validateCoachingPlan, type CoachingPacket } from "../src/lib/coachingPolicy.js";

export async function generateNimReview(packet: CoachingPacket, apiKey: string, modelId: string, customFetch?: typeof fetch) {
  const catalog = buildCoachingCatalog(packet);
  const provider = createOpenAICompatible({ name: "nvidia", baseURL: "https://integrate.api.nvidia.com/v1", apiKey, fetch: customFetch });
  const result = await generateText({
    model: provider.chatModel(modelId),
    instructions: "Select review priorities from the supplied catalog. Return ONLY JSON with observationIds (up to three distinct approved observation IDs) and focusId (one approved focus ID). Select at least one observation when available. Do not add prose, measurements, diagnoses, causes, training prescriptions, or other keys. Required limitations are always displayed separately.",
    prompt: JSON.stringify({ goal: packet.goal, observations: catalog.observations, focuses: catalog.focuses }),
    maxOutputTokens: 700, maxRetries: 0, abortSignal: AbortSignal.timeout(20_000),
  });
  let plan = null;
  try { plan = validateCoachingPlan(JSON.parse(result.text), catalog); } catch { /* Persist rejected output, never display it. */ }
  return { plan, rawOutput: result.text, usage: { inputTokens: result.usage.inputTokens ?? null, outputTokens: result.usage.outputTokens ?? null }, estimatedCostUsd: null };
}
