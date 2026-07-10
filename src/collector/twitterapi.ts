import { config } from "../config";

// twitterapi.io — third-party X data provider. Replaces the official X API v2 as
// the collector's source: ~33x cheaper ($0.00015/tweet vs $0.005), and richer —
// quoted/retweeted tweets are INLINED (no expansion to buy) and inReplyToUserId
// lets us detect self-replies in one call. Auth is a single x-api-key header.

export interface TApiTweet {
  id: string;
  url?: string;
  text: string;
  createdAt: string; // "Thu Jul 09 01:45:06 +0000 2026"
  lang?: string;
  source?: string;
  isReply?: boolean;
  inReplyToId?: string | null;
  inReplyToUserId?: string | null;
  inReplyToUsername?: string | null;
  conversationId?: string | null;
  author?: { id?: string; userName?: string };
  quoted_tweet?: TApiTweet | null;
  retweeted_tweet?: TApiTweet | null;
  entities?: { media?: { type?: string; media_url_https?: string }[] };
  extendedEntities?: { media?: { type?: string; media_url_https?: string }[] };
}

interface LastTweetsResponse {
  status?: string;
  msg?: string;
  data?: { tweets?: TApiTweet[]; pin_tweet?: TApiTweet | null };
  has_next_page?: boolean;
  next_cursor?: string;
}

async function get(path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${config.twitterApiIoUrl}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "x-api-key": config.twitterApiIoKey } });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
      continue;
    }
    if (res.status === 402) {
      throw new Error("twitterapi.io: credits exhausted (402) — recharge the account");
    }
    if (!res.ok) {
      throw new Error(`twitterapi.io ${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
  }
}

/** One page (~20 tweets) of a user's recent tweets. Pass the previous
 * next_cursor to page further back; "" starts at the newest.
 *
 * NOTE: prefer searchTweets() for the collector — last_tweets has no since
 * filter, so frequent polling re-bills the whole page. Kept for completeness. */
export async function fetchLastTweets(opts: {
  userName: string;
  cursor?: string;
  includeReplies?: boolean;
}): Promise<{ tweets: TApiTweet[]; hasNextPage: boolean; nextCursor: string }> {
  const data = (await get("/twitter/user/last_tweets", {
    userName: opts.userName,
    cursor: opts.cursor ?? "",
    includeReplies: String(opts.includeReplies ?? false),
  })) as LastTweetsResponse;
  return {
    tweets: data.data?.tweets ?? [],
    hasNextPage: Boolean(data.has_next_page),
    nextCursor: data.next_cursor ?? "",
  };
}

interface SearchResponse {
  tweets?: TApiTweet[];
  has_next_page?: boolean;
  next_cursor?: string;
}

/** Advanced search — the collector's workhorse. A query like
 * `(from:a OR from:b) since:2026-07-09_10:00:00_UTC` returns ONLY tweets newer
 * than the watermark across a whole batch of authors, so we pay per new tweet,
 * not per poll. Latest = reverse-chronological, unfiltered. */
export async function searchTweets(opts: {
  query: string;
  cursor?: string;
}): Promise<{ tweets: TApiTweet[]; hasNextPage: boolean; nextCursor: string }> {
  const data = (await get("/twitter/tweet/advanced_search", {
    query: opts.query,
    queryType: "Latest",
    cursor: opts.cursor ?? "",
  })) as SearchResponse;
  return {
    tweets: data.tweets ?? [],
    hasNextPage: Boolean(data.has_next_page),
    nextCursor: data.next_cursor ?? "",
  };
}

/** since: operator wants `YYYY-MM-DD_HH:MM:SS_UTC`. */
export function toSinceOperator(at: Date): string {
  return at.toISOString().replace("T", "_").replace(/\.\d+Z$/, "_UTC");
}
