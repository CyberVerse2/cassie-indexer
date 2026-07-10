import { eq, isNull } from "drizzle-orm";
import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { db, schema } from "../src/db/client";
import { config } from "../src/config";
import { withRetry } from "../src/util/retry";

// One-shot: give every existing idea a complete strategy without re-running
// extraction. Uses the stored idea (thesis, reasoning, quotes, horizon,
// target, invalidation) plus the routed instrument + entry price. Same
// provenance rule as the extractor: author-stated legs are basis 'author',
// gap-fills are basis 'suggested'.
const { tradeIdeas, routes, routePricing } = schema;
const openai = createOpenAI({ apiKey: config.openaiApiKey });

const component = z.object({
  text: z.string(),
  basis: z.enum(["author", "suggested"]),
});
const strategySchema = z.object({
  exit: component,
  hold: component,
  stop_loss: component,
  take_profit: component,
});

const SYSTEM = `You write the trade strategy for an already-extracted trade idea: exit (overall exit plan), hold (how long), stop_loss (where to cut), take_profit (where to take gains). Each component under ~15 words.

Provenance is strict: if the supplied idea contains the author's own level/timing for a component (target, invalidation, horizon, or something in their quotes), use it and tag basis "author", staying close to their words. Where the author said nothing, construct a disciplined, conservative suggestion tagged "suggested" — a percent from the entry price, a level the author referenced, or "hold to resolution" for a prediction market — consistent with their conviction, horizon, and the instrument's typical volatility. NEVER tag a suggestion as "author". NEVER invent an author level.`;

const rows = await db
  .select({
    id: tradeIdeas.id,
    thesis: tradeIdeas.thesis,
    reasoning: tradeIdeas.reasoning,
    direction: tradeIdeas.direction,
    horizon: tradeIdeas.horizon,
    conviction: tradeIdeas.conviction,
    target: tradeIdeas.target,
    invalidation: tradeIdeas.invalidation,
    quotes: tradeIdeas.quotes,
    assetClass: tradeIdeas.assetClass,
    instrument: routes.instrument,
    ticker: routes.ticker,
    entryPrice: routePricing.entryPrice,
  })
  .from(tradeIdeas)
  .leftJoin(routes, eq(routes.ideaId, tradeIdeas.id))
  .leftJoin(routePricing, eq(routePricing.routeId, routes.id))
  .where(isNull(tradeIdeas.strategy));

console.log(`${rows.length} ideas need a strategy`);
let done = 0;
let failed = 0;

for (const row of rows) {
  try {
    const { object } = await withRetry(() =>
      generateObject({
        model: openai(config.extractorModel),
        system: SYSTEM,
        prompt: JSON.stringify({
          thesis: row.thesis,
          reasoning: row.reasoning,
          direction: row.direction,
          horizon: row.horizon,
          conviction: row.conviction,
          author_target: row.target,
          author_invalidation: row.invalidation,
          quotes: row.quotes,
          asset_class: row.assetClass,
          instrument: row.instrument,
          ticker: row.ticker,
          entry_price: row.entryPrice,
        }),
        schema: strategySchema,
      }),
    );
    await db
      .update(tradeIdeas)
      .set({
        strategy: {
          exit: object.exit,
          hold: object.hold,
          stopLoss: object.stop_loss,
          takeProfit: object.take_profit,
        },
      })
      .where(eq(tradeIdeas.id, row.id));
    done++;
    if (done % 10 === 0) console.log(`${done}/${rows.length}`);
  } catch (err) {
    failed++;
    console.error(`idea ${row.id}: ${err instanceof Error ? err.message : err}`);
  }
}

console.log(`Done: ${done} strategies written, ${failed} failed.`);
process.exit(0);
