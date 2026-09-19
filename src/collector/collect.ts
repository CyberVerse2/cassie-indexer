import { eq, min } from "drizzle-orm";
import { db, schema } from "../db/client";
import { searchTweets, toSinceOperator, type TApiTweet } from "./twitterapi";

const { sources, rawPosts } = schema;
type Source = typeof sources.$inferSelect;

// How many authors to OR into one advanced_search query. Twitter's query grammar
// caps length (~512 chars); "from:handle OR " averages ~20 chars, so 20 leaves
// headroom for the since: clause. 80 handles → ~4 queries per cycle.
const BATCH_SIZE = 20;
export const LIVE_WINDOW_MINUTES = 5;
export const FIRST_WINDOW_MINUTES = 24 * 60;
const MAX_PAGES_LIVE = 10;
const MAX_PAGES_FIRST = 25;

/**
 * Stage 1 — Collector (twitterapi.io advanced_search).
 * One `(from:a OR from:b …) since:<watermark>` query per batch of authors
 * returns ONLY tweets newer than what we already have — so cost scales with new
 * tweets, not poll frequency. Lands them in raw_posts (idempotent on tweet_id).
 */
export function collectionWindowMinutes(oldestPostedAt: Date | null, now = new Date()): number {
  if (!oldestPostedAt || now.getTime() - oldestPostedAt.getTime() < 20 * 60 * 60 * 1000) {
    return FIRST_WINDOW_MINUTES;
  }
  return LIVE_WINDOW_MINUTES;
}

export async function collectAll(windowMinutes?: number): Promise<{
  fetched: number;
  sources: number;
  errors: number;
  windowMinutes: number;
}> {
  const tracked = await db.select().from(sources).where(eq(sources.tracked, true));
  const byHandle = new Map(tracked.map((s) => [s.handle.toLowerCase(), s]));
  const [coverage] = await db.select({ oldest: min(rawPosts.postedAt) }).from(rawPosts);
  const minutes = windowMinutes ?? collectionWindowMinutes(coverage.oldest ? new Date(coverage.oldest) : null);
  const since = new Date(Date.now() - minutes * 60_000);
  const maxPages = minutes > LIVE_WINDOW_MINUTES ? MAX_PAGES_FIRST : MAX_PAGES_LIVE;

  let fetched = 0;
  let errors = 0;

  for (const batch of chunk(tracked, BATCH_SIZE)) {
    try {
      fetched += await collectBatch(batch, since, byHandle, maxPages);
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[collect] batch ${batch[0].handle}…: ${message}`);
    }
  }

  await db
    .update(sources)
    .set({ lastPolledAt: new Date() })
    .where(eq(sources.tracked, true));

  return { fetched, sources: tracked.length, errors, windowMinutes: minutes };
}

async function collectBatch(
  batch: Source[],
  since: Date,
  byHandle: Map<string, Source>,
  maxPages: number,
): Promise<number> {
  // Exclude replies-to-others AT THE API (we discard them anyway) while keeping
  // self-threads: `-filter:replies OR filter:self_threads`. Cuts ~30% of fetched
  // (and billed) tweets. Verified against twitterapi.io's X-grammar passthrough.
  const authors = batch.map((s) => `from:${s.handle}`).join(" OR ");
  const query = `(${authors}) (-filter:replies OR filter:self_threads) since:${toSinceOperator(since)}`;
  let cursor = "";
  let inserted = 0;

  for (let page = 0; page < maxPages; page++) {
    const { tweets, hasNextPage, nextCursor } = await searchTweets({ query, cursor });
    if (tweets.length === 0) break;

    for (const tweet of tweets) {
      const handle = tweet.author?.userName?.toLowerCase();
      const source = handle ? byHandle.get(handle) : undefined;
      if (!source) continue; // defensive: search shouldn't return off-list authors
      if (await upsertPost(source, tweet)) inserted++;
    }

    if (!hasNextPage) break;
    cursor = nextCursor;
    if (page === maxPages - 1) {
      // Hit the cap with more pages available — the watermark will advance past
      // the unread older tweets, leaving a gap. Fine at steady cadence; a signal
      // to poll more often if it recurs.
      console.warn(`[collect] batch ${batch[0].handle}… hit page cap; older tweets skipped`);
    }
  }

  return inserted;
}

/** Map one twitterapi.io tweet into raw_posts. Returns false for retweets
 * (policy: pure RTs aren't the author's own view) so they're skipped. */
async function upsertPost(source: Source, tweet: TApiTweet): Promise<boolean> {
  const isRetweet = Boolean(tweet.retweeted_tweet) || tweet.text.startsWith("RT @");
  if (isRetweet) return false;

  const authorId = tweet.author?.id ?? null;
  const isReply = Boolean(tweet.isReply);
  // Self-reply = author continuing their own thread. One field, no expansion:
  // the replied-to user is the author themselves.
  const isSelfReply = isReply && authorId != null && tweet.inReplyToUserId === authorId;
  const isQuote = Boolean(tweet.quoted_tweet?.text);

  // Quoted context is INLINED by twitterapi.io — capture it here, free.
  const referencedText = tweet.quoted_tweet?.text ?? null;

  const mediaList = tweet.extendedEntities?.media ?? tweet.entities?.media ?? [];
  const media = mediaList
    .map((m) => ({ type: m.type ?? "photo", url: m.media_url_https }))
    .filter((m): m is { type: string; url: string } => Boolean(m.url));

  const inserted = await db
    .insert(rawPosts)
    .values({
      tweetId: tweet.id,
      sourceId: source.id,
      authorHandle: source.handle,
      text: tweet.text,
      lang: tweet.lang,
      postedAt: new Date(tweet.createdAt),
      isReply,
      isSelfReply,
      isQuote,
      isRetweet: false,
      replyToTweetId: tweet.inReplyToId ?? null,
      referencedText,
      media: media.length ? media : null,
      raw: tweet,
    })
    .onConflictDoNothing({ target: rawPosts.tweetId })
    .returning({ id: rawPosts.tweetId });
  // Empty when the tweet was already stored (overlap window) — only count new.
  return inserted.length > 0;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
