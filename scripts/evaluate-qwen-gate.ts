import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { closeDb, db, schema } from "../src/db/client";
import {
  GATE_SYSTEM,
  gateTradeIdea,
  type ExtractIdeasInput,
} from "../src/processor/extract";
import { assembleThread } from "../src/processor/thread";

const sampleSize = Number(process.env.SAMPLE_SIZE ?? 200);
const balancedPerClass = Number(process.env.BALANCED_PER_CLASS ?? 0);
const sampleSeed = process.env.SAMPLE_SEED;
const concurrency = Number(process.env.CONCURRENCY ?? 8);
const gateProvider = process.env.GATE_PROVIDER ?? "qwen";
const deepseekModel = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const { rawPosts, tradeIdeas } = schema;
const startedAt = performance.now();

const gateSchema = z.object({
  is_idea: z.boolean(),
  reject_reason: z.string().nullable(),
});

async function gateWithDeepSeek(text: string) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("Missing required env var: DEEPSEEK_API_KEY");

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: deepseekModel,
      messages: [
        { role: "system", content: GATE_SYSTEM },
        { role: "user", content: text },
      ],
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 200,
    }),
  });
  if (!response.ok) {
    throw new Error(`DeepSeek API ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned no content");
  return gateSchema.parse(JSON.parse(content));
}

const currentIdeaRows = await db.selectDistinct({ tweetId: tradeIdeas.tweetId }).from(tradeIdeas);
const currentIdeaTweetIds = new Set(currentIdeaRows.map((row) => row.tweetId));
const sampleOrder = sampleSeed
  ? sql`md5(${rawPosts.tweetId} || ${sampleSeed})`
  : sql`random()`;

const eligibleRoots = await db
  .select()
  .from(rawPosts)
  .where(and(eq(rawPosts.status, "processed"), eq(rawPosts.isReply, false)))
  .orderBy(sampleOrder);

const roots = balancedPerClass
  ? [
      ...eligibleRoots
        .filter((root) => currentIdeaTweetIds.has(root.tweetId))
        .slice(0, balancedPerClass),
      ...eligibleRoots
        .filter((root) => !currentIdeaTweetIds.has(root.tweetId))
        .slice(0, balancedPerClass),
    ].sort((left, right) => left.tweetId.localeCompare(right.tweetId))
  : eligibleRoots.slice(0, sampleSize);

type Result = {
  tweetId: string;
  handle: string;
  text: string;
  expectedIdea: boolean;
  gateIdea?: boolean;
  rejectReason?: string | null;
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
    const gate =
      gateProvider === "deepseek"
        ? await gateWithDeepSeek(
            [`@${input.authorHandle} posted at ${input.postedAt.toISOString()}:`, input.text]
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
              .join("\n"),
          )
        : gateProvider === "qwen"
          ? await gateTradeIdea(input)
          : (() => {
              throw new Error(`Unsupported GATE_PROVIDER: ${gateProvider}`);
            })();
    return {
      tweetId: root.tweetId,
      handle: root.authorHandle,
      text: assembledText,
      expectedIdea: currentIdeaTweetIds.has(root.tweetId),
      gateIdea: gate.is_idea,
      rejectReason: gate.reject_reason,
    };
  } catch (error) {
    return {
      tweetId: root.tweetId,
      handle: root.authorHandle,
      text: root.text,
      expectedIdea: currentIdeaTweetIds.has(root.tweetId),
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

console.log(
  JSON.stringify(
    {
      sampleSize: roots.length,
      gateProvider,
      model: gateProvider === "deepseek" ? deepseekModel : process.env.QWEN_MODEL ?? "qwen/qwen3.6-flash",
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
      falseNegativeExamples: falseNegatives.map((result) => ({
        tweetId: result.tweetId,
        handle: result.handle,
        text: result.text.slice(0, 300),
        rejectReason: result.rejectReason,
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
