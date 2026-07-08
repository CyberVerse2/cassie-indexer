import { config } from "../config";
import type { VenueCandidate } from "./types";

// Net-new (not in cassie): paste.trade's choice for equities. Two jobs:
// validate that a ticker really exists, and price it live + at post-time.

const API = "https://api.polygon.io";
const currentCache = new Map<string, { at: number; price: number | null }>();

async function pget<T>(
  path: string,
  params: Record<string, string> = {},
  opts: { retry429?: boolean; timeoutMs?: number } = {},
): Promise<T | null> {
  if (!config.polygonApiKey) return null; // equities degrade gracefully keyless
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("apiKey", config.polygonApiKey);

  // Polygon's lower tiers rate-limit aggressively; back off on 429 rather than
  // dropping the candidate.
  for (let attempt = 0; ; attempt++) {
    const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
    let res: Response;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") return null;
      throw err;
    }
    if (res.status === 404) return null;
    if ((opts.retry429 ?? true) && res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, (attempt + 1) * 1500));
      continue;
    }
    if (res.status === 429) return null;
    if (!res.ok) throw new Error(`Polygon ${res.status} ${path}`);
    return res.json() as Promise<T>;
  }
}

export async function validateTicker(
  ticker: string,
  direction: "long" | "short",
): Promise<VenueCandidate | null> {
  const data = await pget<{ results?: { ticker: string; name: string; market: string } }>(
    `/v3/reference/tickers/${ticker.toUpperCase()}`,
  );
  if (!data?.results) return null;

  return {
    venue: "equity",
    instrument: "shares",
    ticker: data.results.ticker,
    displayTicker: data.results.ticker,
    direction,
    markPrice: await currentPrice(data.results.ticker),
    liquidityNote: data.results.name,
    marketMeta: { name: data.results.name, market: data.results.market },
  };
}

/** Latest available minute-bar close. Plan recency may be delayed by Polygon tier. */
export async function currentPrice(ticker: string): Promise<number | null> {
  const symbol = ticker.toUpperCase();
  const cached = currentCache.get(symbol);
  if (cached && Date.now() - cached.at < 30_000) return cached.price;

  const now = Date.now();
  const from = now - 36 * 3_600_000;
  const latest = await pget<{ results?: { c: number; t: number }[] }>(
    `/v2/aggs/ticker/${symbol}/range/1/minute/${from}/${now}`,
    { adjusted: "true", sort: "desc", limit: "1" },
    { retry429: false, timeoutMs: 1_200 },
  );
  const price = latest?.results?.[0]?.c ?? (await previousClose(symbol));
  currentCache.set(symbol, { at: Date.now(), price });
  return price;
}

async function previousClose(ticker: string): Promise<number | null> {
  const data = await pget<{ results?: { c: number }[] }>(
    `/v2/aggs/ticker/${ticker}/prev`,
    { adjusted: "true" },
    { retry429: false, timeoutMs: 1_200 },
  );
  return data?.results?.[0]?.c ?? null;
}

/**
 * Price when the author posted. Off-hours rule (decision): the last trade
 * BEFORE the post — i.e. the price the author was looking at — not the next
 * open. Falls back through: minute bar at t → last minute bar ≤ t within the
 * prior 7 days (covers nights/weekends).
 */
export async function priceAt(
  ticker: string,
  at: Date,
): Promise<{ price: number; note: string } | null> {
  const t = at.getTime();
  const data = await pget<{ results?: { c: number; t: number }[] }>(
    `/v2/aggs/ticker/${ticker.toUpperCase()}/range/1/minute/${t - 7 * 86_400_000}/${t}`,
    { adjusted: "true", sort: "desc", limit: "1" },
  );
  const bar = data?.results?.[0];
  if (!bar) return null;
  const ageMin = Math.round((t - bar.t) / 60_000);
  return {
    price: bar.c,
    note: ageMin <= 2 ? "minute bar at post time" : `last trade ${ageMin}min before post (off-hours)`,
  };
}
