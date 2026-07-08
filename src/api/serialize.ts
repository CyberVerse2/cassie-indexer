import type { schema } from "../db/client";
import * as hl from "../venues/hyperliquid";
import * as pm from "../venues/polymarket";
import * as polygon from "../venues/polygon";
import * as coingecko from "../venues/coingecko";

type IdeaRow = typeof schema.tradeIdeas.$inferSelect;
type RouteRow = typeof schema.routes.$inferSelect;
type PricingRow = typeof schema.routePricing.$inferSelect;
type PostRow = typeof schema.rawPosts.$inferSelect;
type SourceRow = typeof schema.sources.$inferSelect;

export interface FeedRow {
  idea: IdeaRow;
  route: RouteRow;
  pricing: PricingRow | null;
  post: PostRow | null;
  source: SourceRow | null;
}

// instrument → feed tab bucket
const CATEGORY: Record<string, string> = {
  perp: "perps",
  shares: "stocks",
  spot: "tokens",
  prediction: "markets",
};

const VENUE_LABEL: Record<string, string> = {
  hyperliquid: "HYPERLIQUID",
  equity: "STOCKS",
  coingecko: "SPOT",
  polymarket: "POLYMARKET",
};

function bareTicker(ticker: string | null): string {
  if (!ticker) return "";
  // strip builder-dex namespace ("xyz:INTC" → "INTC")
  return (ticker.includes(":") ? ticker.split(":").pop()! : ticker).toUpperCase();
}

type PmMeta = { question?: string; slug?: string; eventSlug?: string; icon?: string };
type HlMeta = { dex?: string };

function displayTicker(route: RouteRow): string {
  // Polymarket: the market question is the title, never the condition_id.
  if (route.venue === "polymarket") {
    const q = (route.marketMeta as PmMeta | null)?.question;
    if (q) return q;
  }
  const base = bareTicker(route.ticker);
  if (route.instrument === "perp") return `${base}-USD`;
  return base;
}

function logoUrl(idea: IdeaRow, route: RouteRow): string {
  // Polymarket has no ticker logo — use the market's own icon (or none).
  if (route.venue === "polymarket") {
    return (route.marketMeta as PmMeta | null)?.icon ?? "";
  }
  const base = bareTicker(route.ticker) || (idea.candidateTickers[0] ?? "");
  const kind = idea.assetClass === "crypto" ? "crypto" : "symbol";
  return `https://api.elbstream.com/logos/${kind}/${base}`;
}

function num(v: string | null): number | null {
  return v === null ? null : Number(v);
}

function sincePostedPct(entryPrice: number | null, currentPrice: number | null): number | null {
  if (entryPrice === null || currentPrice === null || entryPrice === 0) return null;
  return Number((((currentPrice - entryPrice) / entryPrice) * 100).toFixed(4));
}

async function liveCurrentPrice(route: RouteRow): Promise<number> {
  if (!route.venue || !route.ticker || !route.direction) {
    throw new Error("routed idea is missing venue, ticker, or direction");
  }

  switch (route.venue) {
    case "hyperliquid": {
      const price = await hl.livePrice(route.ticker, (route.marketMeta as HlMeta | null)?.dex ?? "");
      if (price === null) throw new Error(`Hyperliquid returned no live price for ${route.ticker}`);
      return price;
    }
    case "equity": {
      const price = await polygon.currentPrice(route.ticker);
      if (price === null) throw new Error(`Polygon returned no live price for ${route.ticker}`);
      return price;
    }
    case "coingecko": {
      const price = await coingecko.currentPrice(route.ticker);
      if (price === null) throw new Error(`CoinGecko returned no live price for ${route.ticker}`);
      return price;
    }
    case "polymarket": {
      const price = await pm.currentPrice(route.ticker, route.direction === "no" ? "no" : "yes");
      if (price === null) throw new Error(`Polymarket returned no live price for ${route.ticker}`);
      return price;
    }
  }
}

/** Compact feed card — everything the mockup renders, nothing more. */
export async function toFeedCard(row: FeedRow) {
  const { idea, route, pricing, post, source } = row;
  const entryPrice = num(pricing?.entryPrice ?? null);
  let currentPrice: number | null = null;
  let currentPriceError: string | null = null;
  try {
    currentPrice = await liveCurrentPrice(route);
  } catch (err) {
    currentPriceError = err instanceof Error ? err.message : String(err);
  }

  return {
    id: idea.id,
    venue: route.venue,
    venueLabel: route.venue ? VENUE_LABEL[route.venue] ?? route.venue.toUpperCase() : "—",
    instrument: route.instrument,
    category: route.instrument ? CATEGORY[route.instrument] ?? "markets" : "markets",
    ticker: displayTicker(route),
    direction: route.direction,
    tradeType: route.tradeType,
    sincePostedPct: sincePostedPct(entryPrice, currentPrice),
    currentPrice,
    currentPriceError,
    entryPrice,
    logoUrl: logoUrl(idea, route),
    postedAt: idea.postedAt,
    author: {
      handle: idea.authorHandle,
      name: source?.name ?? idea.authorHandle,
      avatarUrl: `https://unavatar.io/x/${idea.authorHandle}`,
      profileUrl: source?.profileUrl ?? `https://x.com/${idea.authorHandle}`,
    },
    // nested-quote text: the author's own words (full tweet), UI truncates
    text: post?.text ?? idea.headlineQuote,
    headlineQuote: idea.headlineQuote,
    conviction: idea.conviction,
    horizon: idea.horizon,
    sourceUrl: post ? `https://x.com/${idea.authorHandle}/status/${post.tweetId}` : null,
  };
}

/** Full detail — adds the reasoning the card hides. */
export async function toDetail(row: FeedRow) {
  const { idea, route } = row;
  return {
    ...(await toFeedCard(row)),
    thesis: idea.thesis,
    context: idea.context,
    subjects: idea.subjects,
    quotes: idea.quotes,
    assetClass: idea.assetClass,
    pipeline: route.pipeline,
    alternatives: route.alternatives,
    unroutedReason: route.unroutedReason,
    routeStatus: route.status,
    extractorModel: idea.model,
  };
}
