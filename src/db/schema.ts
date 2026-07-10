import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// sources — tracked X accounts. Cursor state lives here so the collector is
// restartable: last_tweet_id is the since_id for the next poll.
// ---------------------------------------------------------------------------
export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  handle: text("handle").notNull().unique(),
  xUserId: text("x_user_id").unique(), // resolved lazily; stable across renames
  name: text("name"),
  profileUrl: text("profile_url"),
  tracked: boolean("tracked").notNull().default(true),
  lastTweetId: text("last_tweet_id"), // collector cursor (since_id)
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// raw_posts — durable landing zone for everything the collector fetches.
// Keyed on the X tweet id so overlapping windows upsert idempotently.
// The processor drains rows where status = 'pending'.
// ---------------------------------------------------------------------------
export const rawPosts = pgTable(
  "raw_posts",
  {
    tweetId: text("tweet_id").primaryKey(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id),
    authorHandle: text("author_handle").notNull(),
    text: text("text").notNull(),
    lang: text("lang"),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    isReply: boolean("is_reply").notNull().default(false),
    isSelfReply: boolean("is_self_reply").notNull().default(false), // reply to own thread
    isRetweet: boolean("is_retweet").notNull().default(false),
    isQuote: boolean("is_quote").notNull().default(false),
    replyToTweetId: text("reply_to_tweet_id"), // parent tweet id (for thread reassembly)
    referencedText: text("referenced_text"), // quoted/replied-to tweet text, if fetched
    media: jsonb("media").$type<{ type: string; url?: string }[]>(),
    raw: jsonb("raw"), // full API payload, for reprocessing without refetch
    status: text("status", { enum: ["pending", "processed", "failed"] })
      .notNull()
      .default("pending"),
    processError: text("process_error"),
    ideasExtracted: integer("ideas_extracted"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    index("raw_posts_status_idx").on(t.status, t.postedAt),
    index("raw_posts_source_idx").on(t.sourceId, t.postedAt),
  ],
);

// ---------------------------------------------------------------------------
// trade_ideas — output of gate+extract. One belief = one row; instruments are
// expressions on routes, not extra ideas. Verbatim quotes are frozen evidence.
// extractor_version + model make reprocessing auditable.
// ---------------------------------------------------------------------------
export const tradeIdeas = pgTable(
  "trade_ideas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tweetId: text("tweet_id")
      .notNull()
      .references(() => rawPosts.tweetId),
    authorHandle: text("author_handle").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    thesis: text("thesis").notNull(), // interpreted reading, our words
    reasoning: jsonb("reasoning").$type<string[]>(), // author's investment case (setup→edge→payoff)
    subjects: jsonb("subjects")
      .$type<{ label: string; kind: "asset" | "company" | "sector" | "macro" | "event" }[]>()
      .notNull(),
    direction: text("direction", { enum: ["long", "short", "yes", "no"] }).notNull(),
    statedByAuthor: boolean("stated_by_author"), // true = author's explicit call; false = opportunity we derived
    horizon: text("horizon", {
      enum: ["immediate", "short-term", "medium-term", "long-term", "unspecified"],
    }),
    target: text("target"), // author's stated price target / upside, if any (verbatim-ish)
    invalidation: text("invalidation"), // author's stated stop / level that kills the thesis, if any
    // Complete trade strategy — every idea gets one. Components the author
    // stated are basis:'author'; gaps are filled with basis:'suggested' so a
    // derived stop can never masquerade as the author's plan.
    strategy: jsonb("strategy").$type<{
      exit: { text: string; basis: "author" | "suggested" };
      hold: { text: string; basis: "author" | "suggested" };
      stopLoss: { text: string; basis: "author" | "suggested" };
      takeProfit: { text: string; basis: "author" | "suggested" };
    }>(),
    conviction: text("conviction", { enum: ["low", "medium", "high"] }),
    quotes: jsonb("quotes").$type<string[]>().notNull(), // verbatim, frozen
    headlineQuote: text("headline_quote").notNull(),
    assetClass: text("asset_class", {
      enum: ["crypto", "equity", "etf", "commodity", "fx", "macro", "event"],
    }).notNull(),
    context: text("context"), // plain-English explainer of the subject, no view
    references: jsonb("references").$type<{ url: string; title: string | null }[]>(), // web-search citations behind enrichment
    candidateTickers: jsonb("candidate_tickers").$type<string[]>().notNull(),
    status: text("status", { enum: ["extracted", "routed", "unrouted", "priced"] })
      .notNull()
      .default("extracted"),
    extractorVersion: text("extractor_version").notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("trade_ideas_status_idx").on(t.status),
    index("trade_ideas_author_idx").on(t.authorHandle, t.postedAt),
  ],
);

// ---------------------------------------------------------------------------
// routes — the selected tradeable expression for an idea, chosen by the
// bounded ranker over venue-validated candidates. Unroutable ideas keep a row
// with status 'unrouted' + reason so the index stays honest.
// ---------------------------------------------------------------------------
export const routes = pgTable(
  "routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ideaId: uuid("idea_id")
      .notNull()
      .references(() => tradeIdeas.id),
    status: text("status", { enum: ["routed", "unrouted"] }).notNull(),
    unroutedReason: text("unrouted_reason"),
    venue: text("venue", { enum: ["hyperliquid", "polymarket", "equity", "coingecko"] }),
    instrument: text("instrument", { enum: ["perp", "shares", "prediction", "spot"] }),
    ticker: text("ticker"),
    direction: text("direction", { enum: ["long", "short", "yes", "no"] }),
    tradeType: text("trade_type", { enum: ["direct", "derived"] }),
    // pipeline: the derivation chain from the author's words to this instrument.
    // (Named "pipeline" per product naming; distinct from the system's
    // collector→processor pipeline.)
    pipeline: jsonb("pipeline").$type<{
      explanation: string;
      steps: { text: string; basis: "quote" | "inference" | "market" }[];
    }>(),
    alternatives: jsonb("alternatives").$type<
      { venue: string; ticker: string; direction: string; note?: string }[]
    >(),
    marketMeta: jsonb("market_meta"), // venue-specific: PM condition_id/slug, HL szDecimals, etc.
    routerVersion: text("router_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("routes_idea_idx").on(t.ideaId)],
);

// ---------------------------------------------------------------------------
// route_pricing — P&L baseline for a routed expression: price when the author
// posted, and the latest observed price. Separate table so a re-price never
// touches routing state.
// ---------------------------------------------------------------------------
export const routePricing = pgTable(
  "route_pricing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    routeId: uuid("route_id")
      .notNull()
      .references(() => routes.id)
      .unique(),
    entryPrice: numeric("entry_price", { precision: 20, scale: 8 }),
    entryPricedAt: timestamp("entry_priced_at", { withTimezone: true }),
    entryNote: text("entry_note"), // e.g. "prior close (posted off-hours)"
    currentPrice: numeric("current_price", { precision: 20, scale: 8 }),
    currentPricedAt: timestamp("current_priced_at", { withTimezone: true }),
    sincePostedPct: numeric("since_posted_pct", { precision: 10, scale: 4 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);
