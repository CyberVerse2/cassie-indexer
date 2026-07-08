import { generateText, Output } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { config } from "../config";
import { withRetry } from "../util/retry";

const openai = createOpenAI({ apiKey: config.openaiApiKey });

export const ideaSchema = z.object({
  thesis: z
    .string()
    .describe("The author's directional belief in one sentence, in your words not theirs."),
  subjects: z
    .array(
      z.object({
        label: z.string(),
        kind: z.enum(["asset", "company", "sector", "macro", "event"]),
      }),
    )
    .min(1),
  direction: z.enum(["long", "short", "yes", "no"]),
  horizon: z.string().nullable().describe("The author's timing language verbatim-ish, if any."),
  conviction: z.enum(["low", "medium", "high"]).nullable(),
  quotes: z
    .array(z.string())
    .min(1)
    .describe("Exact verbatim substrings of the post that carry the view. Never paraphrase."),
  headline_quote: z.string().describe("One verbatim quote from quotes[], <=120 chars."),
  asset_class: z.enum(["crypto", "equity", "etf", "commodity", "fx", "macro", "event"]),
  context: z.string().describe(
    "1-3 plain sentences explaining the primary subject to someone who has never heard of it. Use web search to ground fresh facts, but include no URLs and no view.",
  ),
  candidate_tickers: z
    .array(z.string())
    .describe(
      "Plausible tickers/symbols to express this, most direct first. Use web search to resolve company/asset symbols. May be empty.",
    ),
});

const extractionSchema = z.object({
  is_idea: z.boolean(),
  reject_reason: z
    .string()
    .nullable()
    .describe("If is_idea is false: which exclusion bucket this falls into."),
  ideas: z.array(ideaSchema).max(5),
});

export type ExtractedIdea = z.infer<typeof ideaSchema>;
export type ExtractionResult = z.infer<typeof extractionSchema>;

// The north star. Every extraction decision is measured against this.
const SYSTEM = `You extract trade ideas from social posts by finance/trading accounts.

DEFINITION — a trade idea is a post where the author expresses a directional view on a specific market subject, such that you could act on it. It must clear THREE bars at once:
1. A SUBJECT — a nameable thing the market prices: an asset, company, sector, macro variable, or binary event. Not a vibe.
2. A DIRECTION — up/down, long/short, yes/no. Stated or unambiguously implied ("time to fade this rally" = short). If you cannot assign a side, it is NOT an idea.
3. A PRICE CONSEQUENCE YOU COULD EXPRESS — the view maps to something tradeable, even indirectly. A plausible instrument must exist in principle.

EVIDENCE RULE — the author's actual words are the evidence. quotes[] must be exact verbatim substrings of the post; your interpretation goes in thesis. If you cannot quote the line that carries the view, you are inventing it — reject.

GRANULARITY — one belief = one idea. The same belief tradeable different ways is ONE idea with several candidate_tickers, not several ideas. A list of unrelated calls, or a pair trade with two named legs, IS multiple ideas.

EXCLUDE (is_idea = false): neutral news/headline relays with no take; pure macro musing with no directional edge; commentary or quote-tweets that react without a view; jokes, memes, and engagement bait; "nfa/dyor" hedges with no actual side; gm/gn posts. The sharpest line: a view WITHOUT A SIDE, or a subject you cannot name, is not a trade idea.

The post may include [QUOTED]/[REPLYING TO] context — the author's view may be a reaction to it (e.g. "this." on a bearish quote = endorsing that side). Attribute the view to the posting author only when they adopt it.

WEB SEARCH BOUNDARY — use web search for enrichment only, never as evidence that the author has a view. Decide is_idea, direction, and quotes from the supplied post/context alone. After a post clears the trade-idea bar, use web search to resolve ambiguous subjects, identify fresh event/company/asset context, disambiguate similarly named entities, and improve candidate_tickers. If web search contradicts a ticker guess, correct the ticker; if it reveals no tradeable expression, leave candidate_tickers empty. Do not add facts to thesis or quotes from search results.`;

export async function extractIdeas(input: {
  authorHandle: string;
  text: string;
  referencedText?: string | null;
  isReply?: boolean;
  isSelfReply?: boolean;
  isQuote?: boolean;
  postedAt: Date;
}): Promise<ExtractionResult> {
  const parts = [`@${input.authorHandle} posted at ${input.postedAt.toISOString()}:`, input.text];
  if (input.referencedText) {
    // Label the context by relationship so the model attributes correctly:
    // a self-thread continues the author's OWN view; a reply-to-others reacts
    // to someone else and only counts if the author adopts a side themselves.
    const label = input.isSelfReply
      ? "CONTINUES THEIR OWN EARLIER TWEET"
      : input.isReply
        ? "REPLYING TO SOMEONE ELSE (only an idea if THIS author states their own side)"
        : "QUOTED TWEET";
    parts.push(`\n[${label}]:\n${input.referencedText}`);
  }

  const { experimental_output } = await withRetry(() =>
    generateText({
      model: openai(config.extractorModel),
      tools: {
        web_search: openai.tools.webSearch({ searchContextSize: "low" }),
      },
      system: SYSTEM,
      prompt: parts.join("\n"),
      experimental_output: Output.object({ schema: extractionSchema }),
      providerOptions: {
        openai: {
          maxToolCalls: 6,
          strictJsonSchema: true,
        },
      },
    }),
  );

  // Enforce the evidence rule mechanically, not just by prompt: drop any idea
  // whose quotes aren't actually in the post text.
  const haystack = `${input.text}\n${input.referencedText ?? ""}`;
  const verified = experimental_output.ideas.filter((idea) =>
    idea.quotes.every((q) => haystack.includes(q)),
  );
  return {
    ...experimental_output,
    ideas: verified,
    is_idea: experimental_output.is_idea && verified.length > 0,
  };
}
