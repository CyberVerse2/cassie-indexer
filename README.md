# cassie-indexer

Indexes trade ideas from ~90 tracked X/Twitter accounts (`data/twitter_sources.json`), every five minutes, into Postgres.

A **trade idea** is a post where the author expresses a directional view on a specific market subject, such that you could act on it: a nameable **subject**, an assignable **direction**, and a **price consequence** expressible through some instrument. The author's verbatim words are the evidence; our interpretation is stored separately.

## Pipeline

```
5-minute tick
├── Collector   X API v2 timelines → raw_posts   (cursor per source, idempotent on tweet_id)
└── Processor   raw_posts → gate+extract → route → price → trade_ideas / routes / route_pricing
```

Two stages decoupled by the DB: a collector failure never loses LLM work, a processor failure never re-hits X, and reprocessing with new extraction logic drains from `raw_posts` without refetching.

- **Gate + extraction**: a high-recall Jev pre-gate (`typesafe/jev-1.13` via OpenRouter Decisions, pass at `noul >= 0.3`) stops genuine non-opportunities before GPT-5.6 Luna extraction. Luna uses OpenAI web search in the same call as the idea JSON. Quotes are mechanically verified as substrings of the post.
- **Routing**: Definitive search for a listed EVM stock or token. Stocks must match an issuer catalog. Tokens keep listed Definitive markets and rank them by liquidity. Cassie then checks an executable buy-and-sell quote and writes an asset-specific plan before the idea is published. Unroutable ideas keep a row with `unrouted_reason`.
- **Pricing**: entry at post-time is stored as the baseline; current price is fetched live from the selected venue when the feed is read.

## Setup

```bash
bun install
cp .env.example .env          # fill in Twitter, OpenRouter, and market-data keys
createdb cassie_indexer
bunx drizzle-kit push
bun run seed                  # load data/twitter_sources.json into sources
```

## Run

```bash
bun run collect      # collector only
bun run process      # processor only (drains pending raw_posts)
bun run run-once     # one full sweep
bun run daemon       # 5-minute loop
```

## Reading the feed

This repo is the **indexer only** — it collects, extracts, routes, and prices ideas
into Postgres. The read API and UI live in **cassie-terminal** (the fullstack app),
which reads this same database directly. To populate realistic demo cards for it:

```bash
bun run demo && bun run process   # optional: seed + process demo cards
```

Then run cassie-terminal (`npm run dev`) — it serves `/api/ideas`, `/api/ideas/:id`,
`/api/authors/:handle`, and `/api/status` from its own SvelteKit backend.

## Notes

- Venue search is adapted from the `cassie` monorepo's adapters (same Hyperliquid `/info` request types, Polymarket Gamma). Execution stays in cassie — this indexer holds no trading keys.
- Polygon key is optional; without it, equity ideas gather only HL stock-perp candidates.
- Polymarket entry price is the price at index time (Gamma has no historical odds); the hourly cadence keeps that gap ≤1h.
