import type { schema } from "../db/client";

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

/** Compact feed card — everything the mockup renders, nothing more. */
export function toFeedCard(row: FeedRow) {
  const { idea, route, pricing, post, source } = row;
  return {
    id: idea.id,
    venue: route.venue,
    venueLabel: route.venue ? VENUE_LABEL[route.venue] ?? route.venue.toUpperCase() : "—",
    instrument: route.instrument,
    category: route.instrument ? CATEGORY[route.instrument] ?? "markets" : "markets",
    ticker: displayTicker(route),
    direction: route.direction,
    tradeType: route.tradeType,
    sincePostedPct: num(pricing?.sincePostedPct ?? null),
    currentPrice: num(pricing?.currentPrice ?? null),
    entryPrice: num(pricing?.entryPrice ?? null),
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
export function toDetail(row: FeedRow) {
  const { idea, route } = row;
  return {
    ...toFeedCard(row),
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
