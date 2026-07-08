import { config } from "../config";
import type { VenueCandidate } from "./types";

// Net-new (not in cassie): spot fallback for crypto that has no Hyperliquid
// perp — paste.trade's pattern (platform: "coingecko").

const API = "https://api.coingecko.com/api/v3";

async function cget<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (config.coingeckoApiKey) headers["x-cg-demo-api-key"] = config.coingeckoApiKey;
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`CoinGecko ${res.status} ${path}`);
  return res.json() as Promise<T>;
}

/** symbol → best coin id (exact symbol match, highest market-cap rank). */
export async function resolveCoin(
  symbol: string,
  direction: "long" | "short",
): Promise<VenueCandidate | null> {
  const data = await cget<{ coins: { id: string; symbol: string; name: string; market_cap_rank: number | null }[] }>(
    "/search",
    { query: symbol },
  );
  const match = data?.coins
    .filter((c) => c.symbol.toLowerCase() === symbol.toLowerCase())
    .sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9))[0];
  if (!match) return null;

  return {
    venue: "coingecko",
    instrument: "spot",
    ticker: match.id,
    displayTicker: match.symbol.toUpperCase(),
    direction,
    markPrice: await currentPrice(match.id),
    liquidityNote: `${match.name} (rank ${match.market_cap_rank ?? "?"})`,
    marketMeta: { coinId: match.id, name: match.name },
  };
}

export async function currentPrice(coinId: string): Promise<number | null> {
  const data = await cget<Record<string, { usd?: number }>>("/simple/price", {
    ids: coinId,
    vs_currencies: "usd",
  });
  return data?.[coinId]?.usd ?? null;
}

/** Nearest market-chart point to the post time (free tier: hourly granularity
 * beyond 1 day — good enough for a spot-tail baseline). */
export async function priceAt(coinId: string, at: Date): Promise<number | null> {
  const from = Math.floor(at.getTime() / 1000) - 3 * 3600;
  const to = Math.floor(at.getTime() / 1000) + 3600;
  const data = await cget<{ prices: [number, number][] }>(
    `/coins/${coinId}/market_chart/range`,
    { vs_currency: "usd", from: String(from), to: String(to) },
  );
  if (!data?.prices?.length) return null;
  const target = at.getTime();
  const nearest = data.prices.reduce((best, p) =>
    Math.abs(p[0] - target) < Math.abs(best[0] - target) ? p : best,
  );
  return nearest[1];
}
