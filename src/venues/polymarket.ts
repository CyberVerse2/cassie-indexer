import { config } from "../config";
import type { VenueCandidate } from "./types";

// Adapted from cassie packages/adapters (PolymarketMarketDataProvider): same
// Gamma search endpoint. We read prices straight off the Gamma market payload
// instead of the CLOB client — indexing needs a reference price, not a
// tradeable quote.

interface GammaMarket {
  conditionId: string;
  question: string;
  slug: string;
  icon?: string;
  image?: string;
  description?: string; // resolution criteria, prose
  outcomes?: string; // JSON string '["Yes","No"]'
  outcomePrices?: string; // JSON string '["0.62","0.38"]'
  clobTokenIds?: string; // JSON string '["<yesToken>","<noToken>"]'
  volumeNum?: number;
  liquidityNum?: number;
  endDate?: string;
}

interface GammaEvent {
  title: string;
  slug: string;
  markets?: GammaMarket[];
}

export async function searchMarkets(
  query: string,
  direction: "yes" | "no",
  limit = 5,
): Promise<VenueCandidate[]> {
  // /public-search ranks far better than /events?search= (which is nearly
  // random); cassie compensated with an AI query planner — we don't need one.
  const url = new URL(`${config.polymarketGammaUrl}/public-search`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit_per_type", String(limit));
  url.searchParams.set("events_status", "active");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Polymarket gamma ${res.status} for "${query}"`);
  const events = ((await res.json()) as { events?: GammaEvent[] }).events ?? [];

  const candidates: VenueCandidate[] = [];
  for (const event of events) {
    for (const market of event.markets ?? []) {
      if (!market.conditionId) continue;
      // Active events still carry already-resolved sub-markets ("...by January
      // 2026?" after January) — don't offer those to the ranker.
      if (market.endDate && new Date(market.endDate).getTime() < Date.now()) continue;
      let yesPrice: number | null = null;
      try {
        const outcomes: string[] = JSON.parse(market.outcomes ?? "[]");
        const prices: string[] = JSON.parse(market.outcomePrices ?? "[]");
        const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
        if (yesIdx >= 0) yesPrice = Number(prices[yesIdx]);
      } catch {
        // odd payloads happen; a candidate without a price is still rankable
      }

      candidates.push({
        venue: "polymarket",
        instrument: "prediction",
        ticker: market.conditionId,
        displayTicker: market.question.slice(0, 60),
        direction,
        markPrice:
          yesPrice === null ? null : direction === "yes" ? yesPrice : 1 - yesPrice,
        liquidityNote: `vol $${Math.round(market.volumeNum ?? 0).toLocaleString()}`,
        marketMeta: {
          question: market.question,
          slug: market.slug,
          eventSlug: event.slug,
          endDate: market.endDate,
          icon: market.icon ?? market.image ?? null,
          yesPrice,
        },
      });
    }
  }
  return candidates.slice(0, limit);
}

/** Resolution metadata for a market — the "trade params" a prediction needs
 * (when it settles, and on what criteria), fetched live for the detail view. */
export async function marketInfo(
  conditionId: string,
): Promise<{ endDate: string | null; criteria: string | null; volume: number | null } | null> {
  const url = new URL(`${config.polymarketGammaUrl}/markets`);
  url.searchParams.set("condition_ids", conditionId);
  const res = await fetch(url);
  if (!res.ok) return null;
  const markets = (await res.json()) as GammaMarket[];
  const market = markets[0];
  if (!market) return null;
  return {
    endDate: market.endDate ?? null,
    criteria: market.description?.trim() || null,
    volume: market.volumeNum ?? null,
  };
}

/** Historical odds of the held side at a past time. Unlike Gamma (spot only),
 * the CLOB /prices-history endpoint returns a timeseries per outcome token — so
 * a prediction gets a real entry baseline at post time, not the index-time hack.
 * Resolves the yes token from the conditionId, reads the nearest point to `at`,
 * and signs it for the held direction. Returns null if history is unavailable. */
export async function priceAt(
  conditionId: string,
  direction: "yes" | "no",
  at: Date,
): Promise<number | null> {
  // 1. conditionId → yes CLOB token id (+ outcome order).
  const marketUrl = new URL(`${config.polymarketGammaUrl}/markets`);
  marketUrl.searchParams.set("condition_ids", conditionId);
  const marketRes = await fetch(marketUrl);
  if (!marketRes.ok) return null;
  const market = ((await marketRes.json()) as GammaMarket[])[0];
  if (!market?.clobTokenIds) return null;
  let yesToken: string | null = null;
  try {
    const outcomes: string[] = JSON.parse(market.outcomes ?? "[]");
    const tokens: string[] = JSON.parse(market.clobTokenIds);
    const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
    yesToken = yesIdx >= 0 ? tokens[yesIdx] : tokens[0];
  } catch {
    return null;
  }
  if (!yesToken) return null;

  // 2. Timeseries in a window around `at`; pick the point nearest post time.
  const target = Math.floor(at.getTime() / 1000);
  const window = 6 * 3600; // ±6h, hourly fidelity
  const histUrl = new URL(`${config.polymarketClobUrl}/prices-history`);
  histUrl.searchParams.set("market", yesToken);
  histUrl.searchParams.set("startTs", String(target - window));
  histUrl.searchParams.set("endTs", String(target + window));
  histUrl.searchParams.set("fidelity", "60");
  const histRes = await fetch(histUrl);
  if (!histRes.ok) return null;
  const history = ((await histRes.json()) as { history?: { t: number; p: number }[] }).history ?? [];
  if (history.length === 0) return null;
  const nearest = history.reduce((best, p) =>
    Math.abs(p.t - target) < Math.abs(best.t - target) ? p : best,
  );

  const yesPrice = nearest.p;
  return direction === "no" ? 1 - yesPrice : yesPrice;
}

/** Current price of the held side, from Gamma (reference, not executable). */
export async function currentPrice(
  conditionId: string,
  direction: "yes" | "no",
): Promise<number | null> {
  const url = new URL(`${config.polymarketGammaUrl}/markets`);
  url.searchParams.set("condition_ids", conditionId);
  const res = await fetch(url);
  if (!res.ok) return null;
  const markets = (await res.json()) as GammaMarket[];
  const market = markets[0];
  if (!market) return null;
  try {
    const outcomes: string[] = JSON.parse(market.outcomes ?? "[]");
    const prices: string[] = JSON.parse(market.outcomePrices ?? "[]");
    const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
    if (yesIdx < 0) return null;
    const yes = Number(prices[yesIdx]);
    return direction === "yes" ? yes : 1 - yes;
  } catch {
    return null;
  }
}
