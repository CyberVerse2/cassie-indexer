import { desc, eq } from "drizzle-orm";
import { closeDb, db, schema } from "../src/db/client";
import { extractIdeas } from "../src/processor/extract";

const { rawPosts, tradeIdeas } = schema;
const model = "qwen/qwen3.8-flash";

const ideaRows = await db
  .select({ tweetId: tradeIdeas.tweetId })
  .from(tradeIdeas)
  .orderBy(desc(tradeIdeas.postedAt))
  .limit(40);

const seen = new Set<string>();
const posts = [];
for (const row of ideaRows) {
  if (seen.has(row.tweetId)) continue;
  const [post] = await db.select().from(rawPosts).where(eq(rawPosts.tweetId, row.tweetId)).limit(1);
  if (!post) continue;
  seen.add(row.tweetId);
  posts.push(post);
  if (posts.length === 10) break;
}

if (posts.length < 10) {
  console.error(`Only found ${posts.length} posts with prior ideas.`);
  process.exitCode = 1;
  await closeDb();
  process.exit(process.exitCode);
}

const results = [];
for (const [index, post] of posts.entries()) {
  const imageUrls = (post.media ?? [])
    .filter((item) => item.type !== "video" && item.url)
    .map((item) => item.url!)
    .slice(0, 4);
  const started = Date.now();
  try {
    const extraction = await extractIdeas({
      authorHandle: post.authorHandle,
      text: post.text,
      referencedText: post.referencedText,
      isReply: post.isReply,
      isSelfReply: post.isSelfReply,
      isQuote: post.isQuote,
      imageUrls,
      postedAt: post.postedAt,
      model,
    });
    results.push({
      n: index + 1,
      tweetId: post.tweetId,
      author: post.authorHandle,
      ms: Date.now() - started,
      text: post.text.replace(/\s+/g, " ").slice(0, 160),
      isIdea: extraction.is_idea,
      reject: extraction.reject_reason,
      ideaCount: extraction.ideas.length,
      searches: extraction.references.length,
      references: extraction.references,
      ideas: extraction.ideas.map((idea) => ({
        direction: idea.direction,
        tickers: idea.candidate_tickers,
        thesis: idea.thesis,
      })),
    });
  } catch (error) {
    results.push({
      n: index + 1,
      tweetId: post.tweetId,
      author: post.authorHandle,
      ms: Date.now() - started,
      text: post.text.replace(/\s+/g, " ").slice(0, 160),
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const last = results[results.length - 1];
  console.log(
    JSON.stringify({
      n: last.n,
      author: last.author,
      ms: last.ms,
      isIdea: last.isIdea,
      searches: last.searches,
      error: last.error ?? null,
    }),
  );
}

console.log(
  JSON.stringify(
    {
      model,
      posts: results.length,
      ideas: results.reduce((n, row) => n + (row.ideaCount ?? 0), 0),
      searched: results.filter((row) => (row.searches ?? 0) > 0).length,
      failed: results.filter((row) => row.error).length,
      results,
    },
    null,
    2,
  ),
);

await closeDb();
