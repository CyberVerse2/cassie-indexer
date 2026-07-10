import { config } from "../config";

const API = "https://api.x.com/2";

export interface XTweet {
  id: string;
  text: string;
  created_at: string;
  lang?: string;
  author_id: string;
  referenced_tweets?: { type: "retweeted" | "quoted" | "replied_to"; id: string }[];
  attachments?: { media_keys?: string[] };
}

export interface XMedia {
  media_key: string;
  type: string;
  url?: string;
  preview_image_url?: string;
}

export interface TimelinePage {
  tweets: XTweet[];
  media: Map<string, XMedia>;
  newestId?: string;
}

async function xGet(path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.xBearerToken}` },
    });
    if (res.status === 429 && attempt < 3) {
      const reset = Number(res.headers.get("x-rate-limit-reset") ?? 0) * 1000;
      const waitMs = Math.min(Math.max(reset - Date.now(), 2_000), 60_000);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (!res.ok) {
      throw new Error(`X API ${res.status} ${path}: ${(await res.text()).slice(0, 300)}`);
    }
    return res.json();
  }
}

export async function resolveUserId(handle: string): Promise<string> {
  const data = await xGet(`/users/by/username/${handle}`, {});
  const id = data?.data?.id;
  if (!id) throw new Error(`Could not resolve user id for @${handle}`);
  return id;
}

/**
 * Fetch a user's timeline since a cursor (since_id) or a start_time backfill
 * window. Includes quoted/replied-to tweets and media so the processor sees
 * the full picture without another API call.
 */
export async function fetchTimeline(opts: {
  userId: string;
  sinceId?: string;
  startTime?: Date;
}): Promise<TimelinePage> {
  const params: Record<string, string> = {
    max_results: "100",
    "tweet.fields": "created_at,lang,referenced_tweets,attachments,author_id",
    // NOTE: we deliberately do NOT expand referenced_tweets.id. The parent of a
    // self-reply is the same author's own tweet, which this very timeline pull
    // already returns — expanding it re-fetches (and re-bills) tweets we own.
    // Self-threads are reassembled locally (thread.ts); quoted context is
    // fetched lazily in the processor only for posts that reach extraction.
    expansions: "attachments.media_keys",
    "media.fields": "type,url,preview_image_url",
    exclude: "retweets", // policy: pure RTs are not the author's own view
  };
  if (opts.sinceId) params.since_id = opts.sinceId;
  else if (opts.startTime) params.start_time = opts.startTime.toISOString();

  const tweets: XTweet[] = [];
  const media = new Map<string, XMedia>();
  let newestId: string | undefined;
  let nextToken: string | undefined;

  // Bounded pagination: 5 pages x 100 tweets per source per run is plenty for
  // an hourly cadence and caps damage from a runaway backfill.
  for (let page = 0; page < 5; page++) {
    if (nextToken) params.pagination_token = nextToken;
    const data = await xGet(`/users/${opts.userId}/tweets`, params);

    for (const t of data?.data ?? []) tweets.push(t);
    for (const m of data?.includes?.media ?? []) media.set(m.media_key, m);

    newestId = newestId ?? data?.meta?.newest_id ?? undefined;
    nextToken = data?.meta?.next_token;
    if (!nextToken) break;
  }

  return { tweets, media, newestId };
}

/**
 * Fetch the text of specific tweets by id (up to 100 per call). Used to pull
 * quoted-tweet context lazily — only for posts that actually reach extraction —
 * instead of eagerly expanding every referenced tweet at collection time.
 */
export async function fetchTweetsText(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const data = await xGet("/tweets", {
    ids: ids.slice(0, 100).join(","),
    "tweet.fields": "text",
  });
  for (const t of data?.data ?? []) if (t?.id && t?.text) out.set(t.id, t.text);
  return out;
}

/**
 * Project-level post consumption for the current billing window. Lets the
 * collector log real usage so cost decisions are measured, not guessed.
 */
export async function fetchUsage(): Promise<{
  projectUsage: number | null;
  projectCap: number | null;
  capResetDay: number | null;
} | null> {
  try {
    const data = await xGet("/usage/tweets", {});
    const u = data?.data ?? data;
    return {
      projectUsage: Number(u?.project_usage ?? u?.projectUsage) || null,
      projectCap: Number(u?.project_cap ?? u?.projectCap) || null,
      capResetDay: Number(u?.cap_reset_day ?? u?.capResetDay) || null,
    };
  } catch (err) {
    console.warn(`[collect] usage lookup failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
