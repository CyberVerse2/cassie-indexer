import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { config } from "../config";
import { fetchTimeline, resolveUserId, type TimelinePage, type XTweet } from "./twitter";

const { sources, rawPosts } = schema;

/**
 * Stage 1 — Collector.
 * One unit of work per tracked source: fetch new tweets since the cursor,
 * land them durably in raw_posts (idempotent on tweet_id), advance the cursor.
 * No LLM work, no market calls: if everything downstream breaks, we still
 * have the posts.
 */
export async function collectAll(): Promise<{ fetched: number; sources: number; errors: number }> {
  const tracked = await db.select().from(sources).where(eq(sources.tracked, true));
  let fetched = 0;
  let errors = 0;

  // Sequential with per-source isolation: one bad handle must not stall the
  // rest, and X rate limits are per-endpoint so parallel fan-out buys little.
  for (const source of tracked) {
    try {
      fetched += await collectSource(source);
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[collect] @${source.handle}: ${message}`);
      await db
        .update(sources)
        .set({ lastError: message.slice(0, 500), lastErrorAt: new Date() })
        .where(eq(sources.id, source.id));
    }
  }

  return { fetched, sources: tracked.length, errors };
}

async function collectSource(source: typeof sources.$inferSelect): Promise<number> {
  // Handles get renamed; the numeric user id is the stable key. Resolve once.
  let userId = source.xUserId;
  if (!userId) {
    userId = await resolveUserId(source.handle);
    await db.update(sources).set({ xUserId: userId }).where(eq(sources.id, source.id));
  }

  const page = await fetchTimeline({
    userId,
    sinceId: source.lastTweetId ?? undefined,
    startTime: source.lastTweetId
      ? undefined
      : new Date(Date.now() - config.collectLookbackHours * 3_600_000),
  });

  for (const tweet of page.tweets) {
    await upsertPost(source, tweet, page);
  }

  await db
    .update(sources)
    .set({
      lastPolledAt: new Date(),
      // newest_id only moves forward; keep the old cursor when nothing new.
      ...(page.newestId ? { lastTweetId: page.newestId } : {}),
    })
    .where(eq(sources.id, source.id));

  if (page.tweets.length > 0) {
    console.log(`[collect] @${source.handle}: +${page.tweets.length}`);
  }
  return page.tweets.length;
}

async function upsertPost(
  source: typeof sources.$inferSelect,
  tweet: XTweet,
  page: TimelinePage,
) {
  const refs = tweet.referenced_tweets ?? [];
  const isReply = refs.some((r) => r.type === "replied_to");
  const isQuote = refs.some((r) => r.type === "quoted");
  const isRetweet = refs.some((r) => r.type === "retweeted");

  // Self-reply = the author replying to their OWN tweet (a thread continuation),
  // vs replying to someone else (a conversation). Detected by comparing authors
  // of this tweet and the tweet it replies to. Both author_ids are already
  // fetched (tweet.fields=author_id applies to included referenced tweets too).
  const repliedTo = refs.find((r) => r.type === "replied_to");
  const replyToTweetId = repliedTo?.id ?? null;
  const parent = repliedTo ? page.referenced.get(repliedTo.id) : undefined;
  const isSelfReply = Boolean(parent && parent.author_id === tweet.author_id);

  // Quoted / replied-to context often carries the thesis the author reacts
  // to — store its text inline so extraction sees the full picture.
  const referencedText =
    refs
      .map((r) => page.referenced.get(r.id))
      .filter((t): t is XTweet => Boolean(t))
      .map((t) => t.text)
      .join("\n---\n") || null;

  const media = (tweet.attachments?.media_keys ?? [])
    .map((k) => page.media.get(k))
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .map((m) => ({ type: m.type, url: m.url ?? m.preview_image_url }));

  await db
    .insert(rawPosts)
    .values({
      tweetId: tweet.id,
      sourceId: source.id,
      authorHandle: source.handle,
      text: tweet.text,
      lang: tweet.lang,
      postedAt: new Date(tweet.created_at),
      isReply,
      isSelfReply,
      isQuote,
      isRetweet,
      replyToTweetId,
      referencedText,
      media: media.length ? media : null,
      raw: tweet,
    })
    .onConflictDoNothing({ target: rawPosts.tweetId });
}
