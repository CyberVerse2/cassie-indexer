import { and, eq, gte, lte } from "drizzle-orm";
import { closeDb, db, schema } from "../src/db/client";
import { routeIdea } from "../src/processor/route";
import { priceRoute } from "../src/processor/price";
import type { ExtractedIdea } from "../src/processor/extract";

const { tradeIdeas, routes, routePricing } = schema;
const from = new Date("2026-09-19T20:07:53.000Z");
const to = new Date("2026-09-19T20:44:29.000Z");

function ideaFromRow(row: typeof tradeIdeas.$inferSelect): ExtractedIdea {
  return {
    thesis: row.thesis,
    reasoning: row.reasoning ?? [],
    subjects: row.subjects,
    direction: row.direction,
    stated_by_author: row.statedByAuthor ?? false,
    horizon: row.horizon ?? "unspecified",
    target: row.target,
    invalidation: row.invalidation,
    strategy: {
      exit: row.strategy?.exit ?? { text: "Close when the thesis breaks.", basis: "suggested" },
      hold: row.strategy?.hold ?? { text: row.horizon ?? "unspecified", basis: "suggested" },
      stop_loss: row.strategy?.stopLoss ?? { text: "Cut if the setup fails.", basis: "suggested" },
      take_profit: row.strategy?.takeProfit ?? { text: "Take profit into strength.", basis: "suggested" },
    },
    conviction: row.conviction ?? "medium",
    quotes: row.quotes,
    headline_quote: row.headlineQuote,
    asset_class: row.assetClass,
    context: row.context ?? "",
    candidate_tickers: row.candidateTickers,
  };
}

const rows = await db
  .select({ idea: tradeIdeas, route: routes })
  .from(tradeIdeas)
  .innerJoin(routes, eq(routes.ideaId, tradeIdeas.id))
  .where(
    and(
      gte(tradeIdeas.createdAt, from),
      lte(tradeIdeas.createdAt, to),
      eq(routes.status, "unrouted"),
    ),
  );

let routed = 0;
let stillUnrouted = 0;
let failed = 0;
for (const { idea, route } of rows) {
  try {
    const decision = await routeIdea(ideaFromRow(idea), idea.postedAt);
    const selected = decision.selected;
    await db
      .update(routes)
      .set({
        status: decision.status,
        unroutedReason: decision.unroutedReason ?? null,
        venue: selected?.venue ?? null,
        instrument: selected?.instrument ?? null,
        ticker: selected?.ticker ?? null,
        direction: selected?.direction ?? null,
        tradeType: decision.tradeType ?? null,
        pipeline: decision.pipeline ?? null,
        alternatives: decision.alternatives,
        marketMeta: selected?.marketMeta ?? null,
        routerVersion: "v3-definitive-evm",
      })
      .where(eq(routes.id, route.id));
    if (decision.status !== "routed" || !selected) {
      stillUnrouted++;
      console.log(`unrouted ${idea.id} ${idea.assetClass} ${decision.unroutedReason}`);
      continue;
    }
    const prices = await priceRoute(selected, idea.postedAt);
    await db
      .insert(routePricing)
      .values({
        routeId: route.id,
        entryPrice: prices.entryPrice?.toString(),
        entryPricedAt: prices.entryPrice !== null ? idea.postedAt : null,
        entryNote: prices.entryNote,
        currentPrice: prices.currentPrice?.toString(),
        currentPricedAt: prices.currentPrice !== null ? new Date() : null,
        sincePostedPct: prices.sincePostedPct?.toString(),
      })
      .onConflictDoUpdate({
        target: routePricing.routeId,
        set: {
          entryPrice: prices.entryPrice?.toString() ?? null,
          entryPricedAt: prices.entryPrice !== null ? idea.postedAt : null,
          entryNote: prices.entryNote,
          currentPrice: prices.currentPrice?.toString() ?? null,
          currentPricedAt: prices.currentPrice !== null ? new Date() : null,
          sincePostedPct: prices.sincePostedPct?.toString() ?? null,
        },
      });
    await db.update(tradeIdeas).set({ status: "priced" }).where(eq(tradeIdeas.id, idea.id));
    routed++;
    console.log(`routed ${idea.id} ${selected.ticker} ${selected.instrument}`);
  } catch (error) {
    failed++;
    console.error(`failed ${idea.id} ${error instanceof Error ? error.message : error}`);
  }
}
console.log(JSON.stringify({ considered: rows.length, routed, stillUnrouted, failed }));
await closeDb();
process.exit(failed ? 1 : 0);
