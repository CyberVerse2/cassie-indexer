import { z } from "zod";
import { config } from "../config";

const responseSchema = z.object({
  answers: z.object({
    decision: z.object({
      noul: z.number().min(0).max(1),
    }),
  }),
});

export async function jevBoolean(options: {
  state: unknown;
  instructions: string;
  trueCriteria: string;
  falseCriteria: string;
}): Promise<number> {
  const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${config.openrouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/thecyberverse/cassie-indexer",
      "X-Title": "cassie-indexer",
    },
    body: JSON.stringify({
      model: config.jevModel,
      state: options.state,
      questions: {
        decision: {
          type: "noul",
          instructions: options.instructions,
          criteria: {
            true: options.trueCriteria,
            false: options.falseCriteria,
          },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Jev Decisions API ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }

  return responseSchema.parse(await response.json()).answers.decision.noul;
}
