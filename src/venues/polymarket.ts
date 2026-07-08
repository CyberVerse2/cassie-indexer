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
  outcomes?: string; // JSON string '["Yes","No"]'
  outcomePrices?: string; // JSON string '["0.62","0.38"]'
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
