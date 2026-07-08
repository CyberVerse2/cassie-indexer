import type { VenueCandidate } from "../venues/types";
import * as hl from "../venues/hyperliquid";
import * as pm from "../venues/polymarket";
import * as polygon from "../venues/polygon";
import * as coingecko from "../venues/coingecko";

export interface PriceResult {
  entryPrice: number | null;
  entryNote: string | null;
  currentPrice: number | null;
  sincePostedPct: number | null;
}

/** Entry = price when the author posted; current = now. Direction-signed
 * P&L happens at read time — we store raw prices. */
export async function priceRoute(selected: VenueCandidate, postedAt: Date): Promise<PriceResult> {
  let entryPrice: number | null = null;
  let entryNote: string | null = null;
  let currentPrice: number | null = null;

  switch (selected.venue) {
    case "hyperliquid": {
      entryPrice = await hl.priceAt(selected.ticker, postedAt);
      entryNote = entryPrice !== null ? "HL candle close at post time" : null;
      currentPrice = await hl.livePrice(
        selected.ticker,
        (selected.marketMeta?.dex as string) ?? "",
      );
      break;
    }
    case "equity": {
      const entry = await polygon.priceAt(selected.ticker, postedAt);
      entryPrice = entry?.price ?? null;
      entryNote = entry?.note ?? null;
      currentPrice = await polygon.currentPrice(selected.ticker);
      break;
    }
    case "coingecko": {
      entryPrice = await coingecko.priceAt(selected.ticker, postedAt);
      entryNote = entryPrice !== null ? "CoinGecko nearest chart point" : null;
      currentPrice = await coingecko.currentPrice(selected.ticker);
      break;
    }
    case "polymarket": {
      // No historical odds endpoint on Gamma: entry baseline is the price at
      // indexing time. Honest note recorded; hourly cadence keeps the gap small.
      currentPrice = await pm.currentPrice(
        selected.ticker,
        selected.direction === "no" ? "no" : "yes",
      );
      entryPrice = currentPrice;
      entryNote = "PM price at index time (no historical odds)";
      break;
    }
  }

  const sincePostedPct =
    entryPrice !== null && currentPrice !== null && entryPrice !== 0
      ? Number((((currentPrice - entryPrice) / entryPrice) * 100).toFixed(4))
      : null;

  return { entryPrice, entryNote, currentPrice, sincePostedPct };
}
