import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { closeDb, db, schema } from "../src/db/client";
import { assembleThread } from "../src/processor/thread";

const sampleSeed = process.env.SAMPLE_SEED ?? "model-compare-1";
const balancedPerClass = Number(process.env.BALANCED_PER_CLASS ?? 50);
const outDir = process.env.BENCHMARK_DIR ?? "eval/gate-benchmark-v1";
const { rawPosts, tradeIdeas } = schema;

const currentIdeaRows = await db.selectDistinct({ tweetId: tradeIdeas.tweetId }).from(tradeIdeas);
const currentIdeaTweetIds = new Set(currentIdeaRows.map((row) => row.tweetId));
const sampleOrder = sql`md5(${rawPosts.tweetId} || ${sampleSeed})`;

const eligibleRoots = await db
  .select()
  .from(rawPosts)
  .where(and(eq(rawPosts.status, "processed"), eq(rawPosts.isReply, false)))
  .orderBy(sampleOrder);

const roots = [
  ...eligibleRoots.filter((root) => currentIdeaTweetIds.has(root.tweetId)).slice(0, balancedPerClass),
  ...eligibleRoots.filter((root) => !currentIdeaTweetIds.has(root.tweetId)).slice(0, balancedPerClass),
].sort((left, right) => left.tweetId.localeCompare(right.tweetId));

const posts = [];
for (const root of roots) {
  const thread = await assembleThread(root);
  const assembledText =
    thread.length === 1
      ? root.text
      : thread.map((post, index) => `(${index + 1}/${thread.length}) ${post.text}`).join("\n\n");
  const imageUrls = thread
    .flatMap((post) => (post.media ?? []) as { type: string; url?: string }[])
    .filter((media) => media.type !== "video" && media.url)
    .map((media) => media.url!)
    .slice(0, 4);
  posts.push({
    tweetId: root.tweetId,
    handle: root.authorHandle,
    text: assembledText,
    referencedText: root.referencedText,
    isQuote: root.isQuote,
    postedAt: root.postedAt.toISOString(),
    imageUrls,
    url: `https://x.com/${root.authorHandle}/status/${root.tweetId}`,
  });
}

const payload = {
  id: "gate-benchmark-v1",
  seed: sampleSeed,
  createdAt: new Date().toISOString(),
  posts,
};

const postsPath = join(outDir, "posts.json");
await mkdir(dirname(postsPath), { recursive: true });
await writeFile(postsPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify({ postsPath, count: posts.length, seed: sampleSeed }, null, 2));
await closeDb();
