import { and, eq, sql } from "drizzle-orm";
import { closeDb, db, schema } from "../src/db/client";
import { gateTradeIdea, type ExtractIdeasInput } from "../src/processor/extract";
import { assembleThread } from "../src/processor/thread";

const sampleSize = Number(process.env.SAMPLE_SIZE ?? 200);
const concurrency = Number(process.env.CONCURRENCY ?? 8);
const { rawPosts, tradeIdeas } = schema;

const currentIdeaRows = await db.selectDistinct({ tweetId: tradeIdeas.tweetId }).from(tradeIdeas);
const currentIdeaTweetIds = new Set(currentIdeaRows.map((row) => row.tweetId));

const roots = await db
  .select()
  .from(rawPosts)
  .where(and(eq(rawPosts.status, "processed"), eq(rawPosts.isReply, false)))
  .orderBy(sql`random()`)
  .limit(sampleSize);

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
    const gate = await gateTradeIdea(input);
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
