import { generateText, Output } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";
import { config } from "../config";
import { generateDeepSeekJson } from "../util/deepseek";
import { generateQwenJson, generateQwenText, type QwenContent } from "../util/qwen";
import { jevBoolean } from "../util/jev";
import { withRetry } from "../util/retry";

const openai = createOpenAI({ apiKey: config.openaiApiKey });
const google = createGoogleGenerativeAI({ apiKey: config.geminiApiKey });

export const horizonSchema = z.enum([
  "immediate",
  "short-term",
  "medium-term",
  "long-term",
  "unspecified",
]);

// One leg of the trade strategy: what to do, and whether the author said it
// (basis 'author') or we filled the gap (basis 'suggested').
function strategyComponent(desc: string) {
  return z.object({
    text: z.string().describe(`${desc} Keep it under ~15 words.`),
    basis: z.enum(["author", "suggested"]),
  });
}

function asStrategyComponent(value: unknown) {
  return typeof value === "string" ? { text: value, basis: "suggested" } : value;
}

const SUBJECT_KIND: Record<string, "asset"> = {
  commodity: "asset",
  crypto: "asset",
  equity: "asset",
  etf: "asset",
  fx: "asset",
  token: "asset",
  stock: "asset",
};

function coerceStrategy(strategy: unknown) {
  if (!strategy || typeof strategy !== "object") return strategy;
  const s = strategy as Record<string, unknown>;
  return {
    ...s,
    exit: asStrategyComponent(s.exit),
    hold: asStrategyComponent(s.hold),
    stop_loss: asStrategyComponent(s.stop_loss),
    take_profit: asStrategyComponent(s.take_profit),
  };
}

function coerceSubjects(subjects: unknown) {
  if (!Array.isArray(subjects)) return subjects;
  return subjects.map((subject) => {
    if (!subject || typeof subject !== "object") return subject;
    const item = subject as Record<string, unknown>;
    const kind = typeof item.kind === "string" ? SUBJECT_KIND[item.kind.toLowerCase()] ?? item.kind : item.kind;
    return { ...item, kind };
  });
}

export function coerceExtraction(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const rec = raw as Record<string, unknown>;
  if (!Array.isArray(rec.ideas)) return raw;
  return {
    ...rec,
    ideas: rec.ideas.map((idea) => {
      if (!idea || typeof idea !== "object") return idea;
      const row = idea as Record<string, unknown>;
      return { ...row, strategy: coerceStrategy(row.strategy), subjects: coerceSubjects(row.subjects) };
    }),
  };
}

export const ideaSchema = z.object({
  thesis: z
    .string()
    .describe(
      "The trade opportunity in one sentence: the subject, the direction, and the core reason. If the author stated a view, capture it; if you derived the opportunity from the situation, state the angle you see.",
    ),
  stated_by_author: z
    .boolean()
    .describe(
      "true ONLY if the author explicitly took this side in their own words. false if YOU derived the opportunity from a neutral post (a question, a data relay, a warning, a chart with no stated side). Be honest — never mark a derived opportunity as the author's call.",
    ),
  reasoning: z
    .array(z.string())
    .min(2)
    .max(4)
    .describe(
      "The WHY behind the opportunity, in 2-4 tight steps: the setup (what happened and why it matters), the edge (why there's a trade here / what the crowd is missing), and the payoff (target / upside and any catalyst). When the author argued it, use their case; when you derived it, work out the why and GROUND it in facts from web search (e.g. a 36% drop → why it fell; odds at 60% → the catalyst). Keep concrete numbers; do not guess facts you haven't grounded.",
    ),
  subjects: z
    .array(
      z.object({
        label: z.string(),
        kind: z.enum(["asset", "company", "sector", "macro", "event"]),
      }),
    )
    .min(1),
  direction: z.enum(["long", "short", "yes", "no"]),
  horizon: horizonSchema.describe(
    "Normalized trade horizon. immediate: through 3 days; short-term: 4 days through 4 weeks; medium-term: over 4 weeks through 6 months; long-term: over 6 months; unspecified: timing cannot be determined from the post or catalyst.",
  ),
  target: z
    .string()
    .nullable()
    .describe(
      "The author's STATED price target / upside, ONLY if they gave one — a number ($150, 'PT 200'), a level ('Wave 3', 'prior highs'), or a magnitude ('2x', '+30%'). Keep it short and close to their words. null if the author named no target. Never invent one.",
    ),
  invalidation: z
    .string()
    .nullable()
    .describe(
      "The author's STATED stop / the level or condition that would kill the thesis, ONLY if they gave one ('below the 200 WMA', 'if it loses 60', 'stop at 4.20'). Short, close to their words. null if the author named none. Never invent one.",
    ),
  conviction: z.enum(["low", "medium", "high"]).nullable(),
  strategy: z
    .object({
      exit: strategyComponent("The overall exit plan in one short sentence."),
      hold: strategyComponent("How long to hold (e.g. 'days, into the catalyst', '2-3 weeks')."),
      stop_loss: strategyComponent(
        "Where to cut: the author's stop if stated, else a sensible level/percent from entry.",
      ),
      take_profit: strategyComponent(
        "Where to take profit: the author's target if stated, else a sensible objective.",
      ),
    })
    .describe(
      "A COMPLETE strategy for acting on this idea. Components the author stated get basis 'author'; where they said nothing, fill the gap with a reasonable suggestion (basis 'suggested') consistent with their argument, conviction, horizon, and asset class.",
    ),
  quotes: z
    .array(z.string())
    .min(1)
    .describe(
      "Exact verbatim substrings of the post — the author's own words. When they stated a side, quote it; when you derived the opportunity, quote the situation they described (the move, the level, the subject). Never paraphrase.",
    ),
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

const strategyComponentJson = {
  type: "object",
  properties: {
    text: { type: "string" },
    basis: { type: "string", enum: ["author", "suggested"] },
  },
  required: ["text", "basis"],
  additionalProperties: false,
} as const;

const extractionJsonSchema = {
  type: "object",
  properties: {
    is_idea: { type: "boolean" },
    reject_reason: { type: ["string", "null"] },
    ideas: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          thesis: { type: "string" },
          stated_by_author: { type: "boolean" },
          reasoning: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 },
          subjects: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                kind: { type: "string", enum: ["asset", "company", "sector", "macro", "event"] },
              },
              required: ["label", "kind"],
              additionalProperties: false,
            },
          },
          direction: { type: "string", enum: ["long", "short", "yes", "no"] },
          horizon: {
            type: "string",
            enum: ["immediate", "short-term", "medium-term", "long-term", "unspecified"],
          },
          target: { type: ["string", "null"] },
          invalidation: { type: ["string", "null"] },
          conviction: {
            anyOf: [{ type: "string", enum: ["low", "medium", "high"] }, { type: "null" }],
          },
          strategy: {
            type: "object",
            properties: {
              exit: strategyComponentJson,
              hold: strategyComponentJson,
              stop_loss: strategyComponentJson,
              take_profit: strategyComponentJson,
            },
            required: ["exit", "hold", "stop_loss", "take_profit"],
            additionalProperties: false,
          },
          quotes: { type: "array", items: { type: "string" }, minItems: 1 },
          headline_quote: { type: "string" },
          asset_class: {
            type: "string",
            enum: ["crypto", "equity", "etf", "commodity", "fx", "macro", "event"],
          },
          context: { type: "string" },
          candidate_tickers: { type: "array", items: { type: "string" } },
        },
        required: [
          "thesis",
          "stated_by_author",
          "reasoning",
          "subjects",
          "direction",
          "horizon",
          "target",
          "invalidation",
          "conviction",
          "strategy",
          "quotes",
          "headline_quote",
          "asset_class",
          "context",
          "candidate_tickers",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["is_idea", "reject_reason", "ideas"],
  additionalProperties: false,
} as const;

export const GATE_SYSTEM = `You decide whether a downstream financial analyst should inspect supplied content.

Return JSON only with exactly this shape:
{"is_idea": boolean, "reject_reason": string | null}

Pass when any plausible causal path could connect the supplied information to a change in the price or probability of something traded. You do not need to identify the instrument, direction, or completed trade thesis. The absence of financial vocabulary is not evidence for rejection. Consider all supplied text, quoted context, and images.

Reject only when you are highly confident no such causal path exists. When uncertain, pass. Set reject_reason to a short explanation only when rejecting; otherwise null.

When a named subject, event, or claim is present, you may use web search to check whether a plausible price path exists. Do not search obvious non-opportunities such as greetings, jokes, or personal chatter.`;

export type ExtractedIdea = z.infer<typeof ideaSchema>;
export interface Reference {
  url: string;
  title: string | null;
}
export type ExtractionResult = z.infer<typeof extractionSchema> & {
  references: Reference[];
};

export interface ExtractIdeasInput {
  authorHandle: string;
  text: string;
  referencedText?: string | null;
  isReply?: boolean;
  isSelfReply?: boolean;
  isSelfQuote?: boolean;
  isQuote?: boolean;
  imageUrls?: string[];
  postedAt: Date;
  model?: string;
}

// The north star. Every extraction decision is measured against this.
const SYSTEM = `You turn social posts from finance/trading accounts into actionable trade OPPORTUNITIES.

MINDSET — every post about a market subject is a potential opportunity, not just an explicit call. Your job is not merely to record what the author said — it is to spot the trade in what they are pointing at. When a post names a market subject and something is happening (a move, a catalyst, a data point, a warning, even a question), ask WHY it is happening and whether there is a trade in it, then build it. Bias toward finding the opportunity; when in doubt, it IS one.

WHAT COUNTS as an opportunity — the post must have BOTH:
1. A SUBJECT the market prices — a stock, crypto, sector, macro variable, or event. (No nameable subject → not an opportunity.)
2. SOMETHING TO ACT ON — a move, catalyst, mispricing, setup, level, or an open question worth a directional answer. Stated OR implied by the situation.

DIRECTION — assign the most likely side (long/short/yes/no). Use the author's side if they stated one; otherwise pick the side the evidence and setup best support (a −36% post-parabola drop → likely short/fade; a breakout-retest-hold → likely long). If genuinely balanced, choose the side the setup favors and mark conviction low. Do not refuse just because the author did not spell out a side — deriving the side IS the job.

STATED vs DERIVED (be honest) — set stated_by_author = true ONLY when the author explicitly took this side in their own words; false when you derived the opportunity from a neutral post (a question, a data relay, a warning, a chart). conviction must reflect this: an explicit strong author call is high; an opportunity you spotted in a neutral post is low. NEVER dress a derived opportunity as the author's own call.

WHY (the analysis) — reasoning is the WHY: what happened, why it matters, the edge, the payoff/catalyst. When the author argued it, use their case. When you derived it, work out the why and GROUND it in real facts via web search (a 36% drop → find why it fell; Fed-hike odds at 60% → find the catalyst; a bounce in $MU $IREN → find the sector driver). Concrete, grounded — do not speculate facts you have not checked.

EVIDENCE — quotes[] are the author's LITERAL words (exact substrings of the post), the record of what THEY actually said. Your analysis (thesis, reasoning) is separate and may draw on search. If the author stated a side, quote it; if you derived it, quote the situation they described.

GRANULARITY — one opportunity = one idea; the same view tradeable different ways is ONE idea with several candidate_tickers. A list of unrelated names, or a pair trade with two legs, IS multiple ideas.

TARGET & INVALIDATION — fill these ONLY from a level the AUTHOR explicitly stated. Never invent a price level here; a fabricated stated-target is worse than a null one. (The strategy block below is where you may add suggested levels.)

HORIZON — always return exactly one normalized value. "immediate" means the same session through 3 days; "short-term" means 4 days through 4 weeks; "medium-term" means over 4 weeks through 6 months; "long-term" means over 6 months; "unspecified" means the timing cannot be determined from the author's words or a dated catalyst. Classify the intended holding period, not the age of the post. Put the author's original timing language in strategy.hold when they provided it.

STRATEGY — every idea gets a complete strategy: exit, hold, stop_loss, take_profit. A component the author stated gets basis "author"; otherwise construct a disciplined, conservative suggestion (basis "suggested") consistent with the setup, conviction, horizon, and the instrument's volatility. NEVER tag a suggestion as "author".

IMAGES — posts often include a chart or screenshot. Read it: chart patterns, levels, and the numbers in the image are part of the setup and the why. A "breakout/retest" call or a big move is usually shown in the image, not just the text.

CONTEXT — the post may include [CONTINUES THEIR OWN EARLIER TWEET] (the author's own prior words — treat as fully theirs), [QUOTED TWEET] (someone else's — the author's angle may be a reaction to it), or [REPLYING TO SOMEONE ELSE].

REJECT (is_idea = false) ONLY genuine non-opportunities: gm/gn, pure personal chatter, jokes with no subject, logistics/announcements with no market subject. A question about a named stock, a data relay on a named asset, or a warning about a named ticker is NOT a reject — it is an opportunity to analyze. Rejecting a real subject because the author did not state a side is the main mistake to avoid.`;

function prepareInput(input: ExtractIdeasInput) {
  const parts = [`@${input.authorHandle} posted at ${input.postedAt.toISOString()}:`, input.text];
  if (input.referencedText) {
    // Label the context by relationship so the model attributes correctly. A
    // self-thread OR a self-quote continues the author's OWN view; a reply to
    // someone else only counts if the author states their own side.
    const label =
      input.isSelfReply || input.isSelfQuote
        ? "CONTINUES THEIR OWN EARLIER TWEET"
        : input.isReply
          ? "REPLYING TO SOMEONE ELSE (only an idea if THIS author states their own side)"
          : "QUOTED TWEET";
    parts.push(`\n[${label}]:\n${input.referencedText}`);
  }

  const text = parts.join("\n");
  // Multimodal when the post carries images: send text + each image so the
  // model can read the chart. Otherwise a plain text prompt.
  const images = (input.imageUrls ?? []).filter((u) => /^https?:\/\//.test(u)).slice(0, 4);
  const messages =
    images.length > 0
      ? [
          {
            role: "user" as const,
            content: [
              { type: "text" as const, text },
              ...images.map((url) => ({ type: "image" as const, image: new URL(url) })),
            ],
          },
        ]
      : undefined;

  return { text, images, messages };
}

function qwenUserContent(text: string, images: string[]): QwenContent {
  if (images.length === 0) return text;
  return [
    { type: "text", text },
    ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
  ];
}

async function extractWithQwen(modelId: string, text: string, images: string[]) {
  let brief = "";
  let sources: Array<{ sourceType?: string; url?: string; title?: string | null }> = [];
  try {
    const research = await withRetry(() =>
      generateQwenText({
        model: modelId,
        system:
          "Research the market subjects in this post. Return 3-6 short bullets of CURRENT, verifiable facts — what happened, why, key price levels, catalysts, dates. Ground every point in web search; no opinions or trade calls.",
        content: qwenUserContent(text, images),
        webSearch: true,
        maxTokens: 800,
      }),
    );
    brief = research.text;
    sources = research.references.map((reference) => ({
      sourceType: "url",
      url: reference.url,
      title: reference.title,
    }));
  } catch {
    // grounding is best-effort; fall through to structuring on the post alone
  }

  const groundedText = brief
    ? `${text}\n\n[GROUNDED RESEARCH — verified facts to use in the reasoning]:\n${brief}`
    : text;
  const extracted = await withRetry(async () => {
    const raw = await generateQwenJson({
      model: modelId,
      system: SYSTEM,
      content: qwenUserContent(groundedText, images),
      schema: z.unknown(),
      maxTokens: 6_000,
    });
    return extractionSchema.parse(coerceExtraction(raw));
  });
  return { extracted, sources };
}

export type GateResult = {
  is_idea: boolean;
  reject_reason: string | null;
  noul: number;
};

export async function gateTradeIdea(input: ExtractIdeasInput): Promise<GateResult> {
  const { text, images } = prepareInput(input);
  const state =
    images.length > 0
      ? `${text}\n\n[NOTE: ${images.length} image(s) were attached. This model cannot see them. Do not reject only because the text is short if a chart or screenshot may carry the market subject.]`
      : text;
  const noul = await withRetry(() =>
    jevBoolean({
      state,
      instructions:
        "Should a downstream financial analyst inspect this post for a tradeable opportunity? Pass when any plausible causal path could connect the supplied information to a change in the price or probability of something traded. You do not need an instrument, direction, or completed thesis. Absence of financial vocabulary is not evidence for rejection. When uncertain, pass.",
      trueCriteria:
        "The post names or implies a market subject and something that could move its price or probability. Includes data relays, warnings, questions, charts, and derived opportunities.",
      falseCriteria:
        "Genuine non-opportunity: greeting, personal chatter, joke with no subject, or logistics/announcement with no traded subject.",
    }),
  );
  const isIdea = noul >= config.jevPassThreshold;
  return {
    is_idea: isIdea,
    reject_reason: isIdea ? null : `jev noul ${noul.toFixed(3)} below ${config.jevPassThreshold}`,
    noul,
  };
}

export async function extractIdeas(input: ExtractIdeasInput): Promise<ExtractionResult> {
  const { text, images, messages } = prepareInput(input);
  const gate = await gateTradeIdea(input);
  if (!gate.is_idea) {
    return {
      is_idea: false,
      reject_reason: gate.reject_reason ?? "rejected by Jev pre-gate",
      ideas: [],
      references: [],
    };
  }

  const modelId = input.model ?? config.extractorModel;
  const isQwen = modelId.includes("qwen");
  const isDeepSeek = modelId.startsWith("deepseek");
  const isGemini = modelId.startsWith("gemini");
  const schemaOutput = Output.object({ schema: extractionSchema });

  let extracted: z.infer<typeof extractionSchema>;
  let sources: Array<{ sourceType?: string; url?: string; title?: string | null }> = [];

  if (isQwen) {
    const result = await extractWithQwen(modelId, text, images);
    extracted = result.extracted;
    sources = result.sources;
  } else if (isDeepSeek) {
    const result = await withRetry(() =>
      generateDeepSeekJson({
        model: modelId,
        system: SYSTEM,
        text,
        imageUrls: images,
        parse: (raw) => extractionSchema.parse(coerceExtraction(raw)),
        jsonSchema: extractionJsonSchema as Record<string, unknown>,
        schemaName: "extraction_result",
      }),
    );
    extracted = result.value;
    sources = result.references.map((reference) => ({
      sourceType: "url",
      url: reference.url,
      title: reference.title,
    }));
  } else if (isGemini) {
    // Gemini silently DROPS Google Search grounding when structured output is on
    // (AI SDK gap: vercel/ai#11599). So do it in two passes: (1) ground with
    // real search → brief + sources, (2) structure the idea using post + brief.
    let brief = "";
    try {
      const g = await withRetry(() =>
        generateText({
          model: google(modelId),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider tool typing quirk
          tools: { google_search: google.tools.googleSearch({}) as any },
          system:
            "Research the market subjects in this post. Return 3-6 short bullets of CURRENT, verifiable facts — what happened, why, key price levels, catalysts, dates. Ground every point in web search; no opinions or trade calls.",
          prompt: text,
        }),
      );
      brief = g.text;
      // Gemini exposes citations via providerMetadata.google.groundingMetadata
      // (groundingChunks), not always via top-level sources — capture both.
      const gm = (g.providerMetadata?.google as { groundingMetadata?: unknown } | undefined)
        ?.groundingMetadata as { groundingChunks?: { web?: { uri?: string; title?: string } }[] } | undefined;
      const chunkSources = (gm?.groundingChunks ?? [])
        .map((c) => ({ sourceType: "url", url: c.web?.uri, title: c.web?.title ?? null }))
        .filter((s): s is { sourceType: string; url: string; title: string | null } => Boolean(s.url));
      sources = g.sources && g.sources.length ? g.sources : chunkSources;
    } catch {
      // grounding is best-effort; fall through to structuring on the post alone
    }

    const groundedText = brief
      ? `${text}\n\n[GROUNDED RESEARCH — verified facts to use in the reasoning]:\n${brief}`
      : text;
    const p2messages =
      images.length > 0
        ? [
            {
              role: "user" as const,
              content: [
                { type: "text" as const, text: groundedText },
                ...images.map((url) => ({ type: "image" as const, image: new URL(url) })),
              ],
            },
          ]
        : undefined;

    const r = await withRetry(() =>
      generateText({
        model: google(modelId),
        system: SYSTEM,
        ...(p2messages ? { messages: p2messages } : { prompt: groundedText }),
        output: schemaOutput,
      }),
    );
    extracted = r.output;
  } else {
    // OpenAI: web_search + structured output work together in one call.
    const r = await withRetry(() =>
      generateText({
        model: openai(modelId),
        tools: { web_search: openai.tools.webSearch({ searchContextSize: "low" }) },
        system: SYSTEM,
        ...(messages ? { messages } : { prompt: text }),
        output: schemaOutput,
        providerOptions: { openai: { maxToolCalls: 6, strictJsonSchema: true } },
      }),
    );
    extracted = r.output;
    sources = r.sources ?? [];
  }

  // Capture the web-search citations the model actually consulted — the sources
  // behind the enrichment (context/tickers), shown as references on the idea.
  // Dedupe by URL; most posts trigger no search and yield none.
  const references: Reference[] = [];
  const seen = new Set<string>();
  for (const source of sources ?? []) {
    if (source.sourceType !== "url" || !source.url || seen.has(source.url)) continue;
    seen.add(source.url);
    references.push({ url: source.url, title: source.title ?? null });
  }

  // Enforce the evidence rule mechanically, not just by prompt: drop any idea
  // whose quotes aren't actually in the post text.
  const haystack = `${input.text}\n${input.referencedText ?? ""}`;
  const verified = extracted.ideas.filter((idea) =>
    idea.quotes.every((q) => haystack.includes(q)),
  );
  return {
    ...extracted,
    ideas: verified,
    is_idea: extracted.is_idea && verified.length > 0,
    references,
  };
}
