// Mirrors cassie's MarketCandidate (packages/core/schemas) trimmed to what an
// indexer needs: a venue-VALIDATED way to express an idea, with enough
// liquidity/pricing context for the ranker to judge it.
export interface VenueCandidate {
  venue: "hyperliquid" | "polymarket" | "equity" | "coingecko";
  instrument: "perp" | "shares" | "prediction" | "spot";
  ticker: string; // HL coin, equity symbol, CG coin id, or PM condition_id
  displayTicker: string;
  direction: "long" | "short" | "yes" | "no";
  markPrice?: number | null;
  liquidityNote?: string;
  marketMeta?: Record<string, unknown>; // PM: question/slug/endDate; HL: dex; CG: coin id
}
