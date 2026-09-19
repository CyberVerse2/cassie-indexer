import { readFile } from "node:fs/promises";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { closeDb, db, schema } from "../src/db/client";
import {
  GATE_SYSTEM,
  gateTradeIdea,
  type ExtractIdeasInput,
} from "../src/processor/extract";
import { assembleThread } from "../src/processor/thread";
import { generateQwenJson } from "../src/util/qwen";

const sampleSize = Number(process.env.SAMPLE_SIZE ?? 200);
const balancedPerClass = Number(process.env.BALANCED_PER_CLASS ?? 0);
const sampleSeed = process.env.SAMPLE_SEED;
const concurrency = Number(process.env.CONCURRENCY ?? 8);
const gateProviders = ["qwen", "deepseek", "openai", "jev"] as const;
type GateProvider = (typeof gateProviders)[number];
const gateProvider = (process.env.GATE_PROVIDER ?? "jev") as GateProvider;
if (!gateProviders.includes(gateProvider)) {
  throw new Error(`Unsupported GATE_PROVIDER: ${gateProvider}`);
}
const deepseekModel = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const openaiModel = process.env.OPENAI_GATE_MODEL ?? "gpt-5.4-nano";
const jevModel = process.env.JEV_MODEL ?? "typesafe/jev-1.13";
const jevPassThreshold = Number(process.env.JEV_PASS_THRESHOLD ?? 0.3);
const { rawPosts, tradeIdeas } = schema;
const startedAt = performance.now();

const gateSchema = z.object({
  is_idea: z.boolean(),
  reject_reason: z.string().nullable(),
});

function outputTextFromResponses(payload: {
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  output_text?: string;
}): string {
  if (payload.output_text) return payload.output_text;
  const text = payload.output
    ?.flatMap((item) => item.content ?? [])
    .find((item) => item.type === "output_text")?.text;
  if (!text) throw new Error("Responses API returned no output text");
  return text;
}

async function imageUrlToDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) return null;
    const mime = response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

async function gateWithDeepSeek(text: string, imageUrls: string[] = []) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("Missing required env var: DEEPSEEK_API_KEY");

  const images = (
    await Promise.all(imageUrls.slice(0, 4).map((url) => imageUrlToDataUrl(url)))
  ).filter((url): url is string => Boolean(url));

  const response = await fetch("https://api.deepseek.com/responses", {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: deepseekModel,
      instructions: GATE_SYSTEM,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text },
            ...images.map((image_url) => ({ type: "input_image", image_url, detail: "low" })),
          ],
        },
      ],
      tools: [{ type: "web_search" }],
      thinking: { type: "disabled" },
      max_output_tokens: 1_500,
    }),
  });
  if (!response.ok) {
    throw new Error(`DeepSeek API ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  return gateSchema.parse(JSON.parse(outputTextFromResponses(await response.json())));
}

async function gateWithOpenAI(text: string, imageUrls: string[]) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing required env var: OPENAI_API_KEY");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: openaiModel,
      instructions: GATE_SYSTEM,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text },
            ...imageUrls.map((image_url) => ({ type: "input_image", image_url, detail: "low" })),
          ],
        },
      ],
      tools: [{ type: "web_search" }],
      reasoning: { effort: "none" },
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "gate_result",
          strict: true,
          schema: {
            type: "object",
            properties: {
              is_idea: { type: "boolean" },
              reject_reason: { type: ["string", "null"] },
            },
            required: ["is_idea", "reject_reason"],
            additionalProperties: false,
          },
        },
      },
      max_output_tokens: 1_500,
      store: false,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI API ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  return gateSchema.parse(JSON.parse(outputTextFromResponses(await response.json())));
}

async function gateWithQwen(input: ExtractIdeasInput) {
  const { text, images } = {
    text: formatGateText(input),
    images: (input.imageUrls ?? []).filter((url) => /^https?:\/\//.test(url)).slice(0, 4),
  };
  const content =
    images.length > 0
      ? [
          { type: "text" as const, text },
          ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
        ]
      : text;
  return generateQwenJson({
    system: GATE_SYSTEM,
    content,
    schema: gateSchema,
    maxTokens: 800,
    webSearch: true,
  });
}

function formatGateText(input: ExtractIdeasInput) {
  return [`@${input.authorHandle} posted at ${input.postedAt.toISOString()}:`, input.text]
    .concat(
      input.referencedText
        ? [
            `\n[${
              input.isSelfReply || input.isSelfQuote
                ? "CONTINUES THEIR OWN EARLIER TWEET"
                : input.isReply
                  ? "REPLYING TO SOMEONE ELSE (only an idea if THIS author states their own side)"
                  : "QUOTED TWEET"
            }]:\n${input.referencedText}`,
          ]
        : [],
    )
    .join("\n");
}

type GoldLabel = "idea" | "not_idea";

async function loadGold() {
  const postsPath = process.env.GOLD_POSTS ?? "eval/gate-benchmark-v1/posts.json";
  const labelsPath = process.env.GOLD_LABELS ?? "eval/gate-benchmark-v1/labels.json";
  let posts: Array<{ tweetId: string }> | null = null;
  let labels: Record<string, GoldLabel> = {};
  try {
    posts = (JSON.parse(await readFile(postsPath, "utf8")) as { posts: Array<{ tweetId: string }> }).posts;
  } catch {
    posts = null;
  }
  try {
    labels =
      (JSON.parse(await readFile(labelsPath, "utf8")) as { labels?: Record<string, GoldLabel> }).labels ?? {};
  } catch {
    labels = {};
  }
  return { posts, labels };
}

const gold = await loadGold();
const goldLabeled = Object.keys(gold.labels).length;
const useGold = goldLabeled > 0;

const currentIdeaRows = await db.selectDistinct({ tweetId: tradeIdeas.tweetId }).from(tradeIdeas);
const currentIdeaTweetIds = new Set(currentIdeaRows.map((row) => row.tweetId));
const sampleOrder = sampleSeed
  ? sql`md5(${rawPosts.tweetId} || ${sampleSeed})`
  : sql`random()`;

async function loadRoots() {
  if (gold.posts && (useGold || process.env.GOLD_POSTS)) {
    const ids = gold.posts.map((post) => post.tweetId);
    const rows = await db.select().from(rawPosts).where(inArray(rawPosts.tweetId, ids));
    const byId = new Map(rows.map((row) => [row.tweetId, row]));
    const frozen = ids.map((id) => byId.get(id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
    return useGold ? frozen.filter((root) => gold.labels[root.tweetId]) : frozen;
  }
  const eligibleRoots = await db
    .select()
    .from(rawPosts)
    .where(and(eq(rawPosts.status, "processed"), eq(rawPosts.isReply, false)))
    .orderBy(sampleOrder);
  if (!balancedPerClass) return eligibleRoots.slice(0, sampleSize);
  return [
    ...eligibleRoots.filter((root) => currentIdeaTweetIds.has(root.tweetId)).slice(0, balancedPerClass),
    ...eligibleRoots.filter((root) => !currentIdeaTweetIds.has(root.tweetId)).slice(0, balancedPerClass),
  ].sort((left, right) => left.tweetId.localeCompare(right.tweetId));
}

const roots = await loadRoots();

type Result = {
  tweetId: string;
  handle: string;
  text: string;
  expectedIdea: boolean;
  gateIdea?: boolean;
  rejectReason?: string | null;
  noul?: number;
  imageCount?: number;
  error?: string;
};

async function evaluate(root: (typeof roots)[number]): Promise<Result> {
  try {
    const thread = await assembleThread(root);
    const assembledText =
      thread.length === 1
        ? root.text
        : thread.map((post, index) => `(${index + 1}/${thread.length}) ${post.text}`).join("\n\n");
    const rawRoot = root.raw as {
      author?: { id?: string };
      quoted_tweet?: { author?: { id?: string } };
    } | null;
    const isSelfQuote =
      root.isQuote &&
      Boolean(rawRoot?.quoted_tweet?.author?.id) &&
      rawRoot?.quoted_tweet?.author?.id === rawRoot?.author?.id;
    const imageUrls = thread
      .flatMap((post) => (post.media ?? []) as { type: string; url?: string }[])
      .filter((media) => media.type !== "video" && media.url)
      .map((media) => media.url!)
      .slice(0, 4);
    const input: ExtractIdeasInput = {
      authorHandle: root.authorHandle,
      text: assembledText,
      referencedText: root.referencedText,
      isReply: root.isReply,
      isSelfReply: root.isSelfReply,
      isSelfQuote,
      isQuote: root.isQuote,
      imageUrls,
      postedAt: root.postedAt,
    };
    const gateText = formatGateText(input);
    let gate: { is_idea: boolean; reject_reason: string | null; noul?: number };
    switch (gateProvider) {
      case "deepseek":
        gate = await gateWithDeepSeek(gateText, imageUrls);
        break;
      case "openai":
        gate = await gateWithOpenAI(gateText, imageUrls);
        break;
      case "qwen":
        gate = await gateWithQwen(input);
        break;
      case "jev":
        gate = await gateTradeIdea(input);
        break;
      default: {
        const _exhaustive: never = gateProvider;
        throw new Error(`Unsupported GATE_PROVIDER: ${_exhaustive}`);
      }
    }
    return {
      tweetId: root.tweetId,
      handle: root.authorHandle,
      text: assembledText,
      expectedIdea: useGold
        ? gold.labels[root.tweetId] === "idea"
        : currentIdeaTweetIds.has(root.tweetId),
      gateIdea: gate.is_idea,
      rejectReason: gate.reject_reason,
      noul: "noul" in gate ? gate.noul : undefined,
      imageCount: imageUrls.length,
    };
  } catch (error) {
    return {
      tweetId: root.tweetId,
      handle: root.authorHandle,
      text: root.text,
      expectedIdea: useGold
        ? gold.labels[root.tweetId] === "idea"
        : currentIdeaTweetIds.has(root.tweetId),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const results: Result[] = new Array(roots.length);
let cursor = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, roots.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= roots.length) return;
      results[index] = await evaluate(roots[index]);
      if ((index + 1) % 25 === 0) console.log(`evaluated ${index + 1}/${roots.length}`);
    }
  }),
);

const completed = results.filter((result) => result.gateIdea !== undefined);
const errors = results.filter((result) => result.error);
const truePositives = completed.filter((result) => result.expectedIdea && result.gateIdea).length;
const falseNegatives = completed.filter((result) => result.expectedIdea && !result.gateIdea);
const trueNegatives = completed.filter((result) => !result.expectedIdea && !result.gateIdea).length;
const falsePositives = completed.filter((result) => !result.expectedIdea && result.gateIdea).length;
const positives = truePositives + falseNegatives.length;
const negatives = trueNegatives + falsePositives;
const scored = completed.filter((result) => result.noul !== undefined);
const thresholdSweep = scored.length
  ? [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].map((threshold) => {
      const tp = scored.filter((result) => result.expectedIdea && result.noul! >= threshold).length;
      const fn = scored.filter((result) => result.expectedIdea && result.noul! < threshold).length;
      const tn = scored.filter((result) => !result.expectedIdea && result.noul! < threshold).length;
      const fp = scored.filter((result) => !result.expectedIdea && result.noul! >= threshold).length;
      const pos = tp + fn;
      const neg = tn + fp;
      return {
        threshold,
        truePositives: tp,
        falseNegatives: fn,
        trueNegatives: tn,
        falsePositives: fp,
        positiveRecall: pos ? tp / pos : null,
        historicalNegativeRejectionRate: neg ? tn / neg : null,
      };
    })
  : [];

function resolveModel(): string {
  switch (gateProvider) {
    case "deepseek":
      return deepseekModel;
    case "openai":
      return openaiModel;
    case "jev":
      return jevModel;
    case "qwen":
      return process.env.QWEN_MODEL ?? "qwen/qwen3.6-flash";
    default: {
      const _exhaustive: never = gateProvider;
      return _exhaustive;
    }
  }
}

console.log(
  JSON.stringify(
    {
      sampleSize: roots.length,
      gold: {
        used: useGold,
        labeled: goldLabeled,
        unlabeled: (gold.posts?.length ?? 0) - goldLabeled,
      },
      gateProvider,
      model: resolveModel(),
      jevPassThreshold: gateProvider === "jev" ? jevPassThreshold : undefined,
      thresholdSweep,
      elapsedSeconds: (performance.now() - startedAt) / 1_000,
      completed: completed.length,
      errors: errors.length,
      historicalLabels: { positives, negatives },
      confusionMatrix: {
        truePositives,
        falseNegatives: falseNegatives.length,
        trueNegatives,
        falsePositives,
      },
      positiveRecall: positives ? truePositives / positives : null,
      historicalNegativeRejectionRate: negatives ? trueNegatives / negatives : null,
      gateRejectionRate: completed.length
        ? (trueNegatives + falseNegatives.length) / completed.length
        : null,
      postsWithImages: completed.filter((result) => (result.imageCount ?? 0) > 0).length,
      falseNegativeExamples: falseNegatives.map((result) => ({
        tweetId: result.tweetId,
        handle: result.handle,
        text: result.text.slice(0, 300),
        rejectReason: result.rejectReason,
        noul: result.noul,
        imageCount: result.imageCount,
      })),
      historicalNegativePassExamples: completed
        .filter((result) => !result.expectedIdea && result.gateIdea)
        .slice(0, 20)
        .map((result) => ({
          tweetId: result.tweetId,
          handle: result.handle,
          text: result.text.slice(0, 300),
        })),
      historicalNegativeRejectExamples: completed
        .filter((result) => !result.expectedIdea && !result.gateIdea)
        .slice(0, 20)
        .map((result) => ({
          tweetId: result.tweetId,
          handle: result.handle,
          text: result.text.slice(0, 300),
          rejectReason: result.rejectReason,
        })),
      errorExamples: errors.slice(0, 10).map((result) => ({
        tweetId: result.tweetId,
        error: result.error,
      })),
    },
    null,
    2,
  ),
);

await closeDb();
