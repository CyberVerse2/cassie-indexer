import { z } from "zod";
import { config } from "../config";

export type QwenContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
      }),
    )
    .min(1),
});

export async function generateQwenJson<T>(options: {
  system: string;
  content: QwenContent;
  schema: z.ZodType<T>;
  maxTokens?: number;
  webSearch?: boolean;
}): Promise<T> {
  const response = await fetch(`${config.openrouterBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(options.webSearch ? 60_000 : 30_000),
    headers: {
      Authorization: `Bearer ${config.openrouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/thecyberverse/cassie-indexer",
      "X-Title": "cassie-indexer",
    },
    body: JSON.stringify({
      model: config.qwenModel,
      messages: [
        { role: "system", content: options.system },
        { role: "user", content: options.content },
      ],
      reasoning: { enabled: false },
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: options.maxTokens ?? 1_024,
      ...(options.webSearch
        ? {
            tools: [
              {
                type: "openrouter:web_search",
                parameters: { max_results: 5, max_uses: 2, search_context_size: "low" },
              },
            ],
            max_tool_calls: 2,
          }
        : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter Qwen API ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }

  const payload = responseSchema.parse(await response.json());
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.choices[0].message.content);
  } catch {
    throw new Error("Qwen returned invalid JSON");
  }
  return options.schema.parse(parsed);
}
