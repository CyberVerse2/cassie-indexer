import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { config } from "../config";

// Provider routing by model id. gpt-* → OpenAI, gemini-* → Google. Keeps the
// extractor and router pointed at whatever EXTRACTOR_MODEL is set to without
// hardcoding a provider.
const openai = createOpenAI({ apiKey: config.openaiApiKey });
const google = createGoogleGenerativeAI({ apiKey: config.geminiApiKey });

export const isGeminiModel = (modelId: string) => modelId.startsWith("gemini");

export function resolveModel(modelId: string) {
  return isGeminiModel(modelId) ? google(modelId) : openai(modelId);
}
