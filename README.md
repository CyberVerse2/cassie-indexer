# cassie-indexer

Indexes trade ideas from ~80 tracked X/Twitter accounts (`data/twitter_sources.json`), hourly, into Postgres.

A **trade idea** is a post where the author expresses a directional view on a specific market subject, such that you could act on it: a nameable **subject**, an assignable **direction**, and a **price consequence** expressible through some instrument. The author's verbatim words are the evidence; our interpretation is stored separately. See `docs/learning/` for the full spec and architecture.

## Pipeline

```
hourly tick
├── Collector   X API v2 timelines → raw_posts   (cursor per source, idempotent on tweet_id)
└── Processor   raw_posts → gate+extract → route → price → trade_ideas / routes / route_pricing
```

Two stages decoupled by the DB: a collector failure never loses LLM work, a processor failure never re-hits X, and reprocessing with new extraction logic drains from `raw_posts` without refetching.

- **Extraction**: one structured `gpt-5.4-mini` call (Vercel AI SDK + Zod) with OpenAI web search for subject/ticker/context enrichment only; quotes are mechanically verified as substrings of the post.
- **Routing**: deterministic venue search (Hyperliquid perps incl. builder-dex stock perps, Polymarket, Polygon equities, CoinGecko spot) → one bounded LLM ranking call over *validated* candidates only. Unroutable ideas keep a row with `unrouted_reason`.
- **Pricing**: entry at post-time is stored as the baseline; current price is fetched live from the selected venue when the feed is read.

## Setup

```bash
bun install
cp .env.example .env          # fill in X_BEARER_TOKEN, OPENAI_API_KEY, POLYGON_API_KEY
createdb cassie_indexer
bunx drizzle-kit push
bun run seed                  # load data/twitter_sources.json into sources
```

## Run

```bash
bun run collect      # collector only
bun run process      # processor only (drains pending raw_posts)
bun run run-once     # one full sweep
bun run daemon       # hourly loop
```

## Serve the feed

```bash
bun run demo && bun run process   # optional: populate realistic demo cards
bun run api                       # read API on :8787
cd web && bun install && bun run dev   # "The Desk" feed on :5173 (proxies /api)
```

Endpoints: `GET /api/ideas?tab=all|perps|stocks|tokens|markets`, `GET /api/ideas/:id` (full detail incl. `pipeline`), `GET /api/authors/:handle` (track record), `GET /api/status`.

## Notes

- Venue search is adapted from the `cassie` monorepo's adapters (same Hyperliquid `/info` request types, Polymarket Gamma). Execution stays in cassie — this indexer holds no trading keys.
- Polygon key is optional; without it, equity ideas gather only HL stock-perp candidates.
- Polymarket entry price is the price at index time (Gamma has no historical odds); the hourly cadence keeps that gap ≤1h.
