import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/client";
import * as pm from "../src/venues/polymarket";

// One-shot: give every routed Polymarket idea a real entry baseline (CLOB odds
// at post time) instead of the index-time price. Read path recomputes current +
// since-posted live, but the stored entry is what a reprice must correct.
const { routes, tradeIdeas, routePricing } = schema;

const rows = await db
  .select({
    routeId: routes.id,
    ticker: routes.ticker,
    direction: routes.direction,
    postedAt: tradeIdeas.postedAt,
    pricingId: routePricing.id,
  })
  .from(routes)
  .innerJoin(tradeIdeas, eq(tradeIdeas.id, routes.ideaId))
  .leftJoin(routePricing, eq(routePricing.routeId, routes.id))
  .where(eq(routes.venue, "polymarket"));

let fixed = 0;
let fallback = 0;
for (const r of rows) {
  if (!r.ticker || !r.direction) continue;
  const side = r.direction === "no" ? "no" : "yes";
  const [current, historical] = await Promise.all([
    pm.currentPrice(r.ticker, side),
    pm.priceAt(r.ticker, side, r.postedAt),
  ]);
  const entry = historical ?? current;
  const note =
    historical !== null
      ? "PM odds at post time (CLOB history)"
      : "PM price at index time (no historical odds)";
  if (historical !== null) fixed++;
  else fallback++;

  const since =
    entry !== null && current !== null && entry !== 0
      ? Number((((current - entry) / entry) * 100).toFixed(4))
      : null;

  const values = {
    entryPrice: entry?.toString() ?? null,
    entryPricedAt: entry !== null ? r.postedAt : null,
    entryNote: note,
    currentPrice: current?.toString() ?? null,
    currentPricedAt: current !== null ? new Date() : null,
    sincePostedPct: since?.toString() ?? null,
  };

  if (r.pricingId) {
    await db.update(routePricing).set(values).where(eq(routePricing.id, r.pricingId));
  } else {
    await db.insert(routePricing).values({ routeId: r.routeId, ...values });
  }
  console.log(`${side.toUpperCase()} ${r.ticker.slice(0, 12)}… entry=${entry} current=${current} (${note})`);
}

console.log(`\nDone: ${fixed} with post-time odds, ${fallback} fell back to index-time.`);
process.exit(0);
