import { Hono } from "hono";
import { cors } from "hono/cors";
import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import { db, schema } from "../db/client";
import { toFeedCard, toDetail, type FeedRow } from "./serialize";

const { tradeIdeas, routes, routePricing, rawPosts, sources } = schema;

const app = new Hono();
app.use("/api/*", cors());

const baseSelect = {
  idea: tradeIdeas,
  route: routes,
  pricing: routePricing,
  post: rawPosts,
  source: sources,
};

function tabFilter(tab: string): SQL | undefined {
  switch (tab) {
    case "perps":
      return sql`${routes.instrument} = 'perp' and ${routes.ticker} not like 'xyz:%'`;
    case "stocks":
      return sql`${routes.instrument} = 'shares' or ${routes.ticker} like 'xyz:%'`;
    case "tokens":
      return eq(routes.instrument, "spot");
    case "markets":
      return eq(routes.instrument, "prediction");
    default:
      return undefined;
  }
}

/** GET /api/ideas?tab=all|perps|stocks|tokens&limit=&cursor=<ISO postedAt> */
app.get("/api/ideas", async (c) => {
  const tab = (c.req.query("tab") ?? "all").toLowerCase();
  const limit = Math.min(Number(c.req.query("limit") ?? 30), 100);
  const cursor = c.req.query("cursor");

  const filters: SQL[] = [eq(routes.status, "routed")];
  const routeTab = tabFilter(tab);
  if (routeTab) filters.push(routeTab);
  if (cursor) filters.push(lt(tradeIdeas.postedAt, new Date(cursor)));

  const rows = (await db
    .select(baseSelect)
    .from(tradeIdeas)
    .innerJoin(routes, eq(routes.ideaId, tradeIdeas.id))
    .leftJoin(routePricing, eq(routePricing.routeId, routes.id))
    .leftJoin(rawPosts, eq(rawPosts.tweetId, tradeIdeas.tweetId))
    .leftJoin(sources, eq(sources.handle, tradeIdeas.authorHandle))
    .where(and(...filters))
    .orderBy(desc(tradeIdeas.postedAt))
    .limit(limit)) as FeedRow[];

  const cards = await Promise.all(rows.map(toFeedCard));
  const nextCursor =
    rows.length === limit ? rows[rows.length - 1].idea.postedAt.toISOString() : null;

  return c.json({ cards, nextCursor });
});

/** GET /api/ideas/:id — full detail incl. pipeline + alternatives */
app.get("/api/ideas/:id", async (c) => {
  const [row] = (await db
    .select(baseSelect)
    .from(tradeIdeas)
    .innerJoin(routes, eq(routes.ideaId, tradeIdeas.id))
    .leftJoin(routePricing, eq(routePricing.routeId, routes.id))
    .leftJoin(rawPosts, eq(rawPosts.tweetId, tradeIdeas.tweetId))
    .leftJoin(sources, eq(sources.handle, tradeIdeas.authorHandle))
    .where(eq(tradeIdeas.id, c.req.param("id")))
    .limit(1)) as FeedRow[];

  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(await toDetail(row));
});

/** GET /api/authors/:handle — the track record no single tweet contains. */
app.get("/api/authors/:handle", async (c) => {
  const handle = c.req.param("handle");
  const rows = (await db
    .select(baseSelect)
    .from(tradeIdeas)
    .innerJoin(routes, eq(routes.ideaId, tradeIdeas.id))
    .leftJoin(routePricing, eq(routePricing.routeId, routes.id))
    .leftJoin(rawPosts, eq(rawPosts.tweetId, tradeIdeas.tweetId))
    .leftJoin(sources, eq(sources.handle, tradeIdeas.authorHandle))
    .where(eq(tradeIdeas.authorHandle, handle))) as FeedRow[];

  const routedRows = rows.filter((row) => row.route.status === "routed");
  const cards = await Promise.all(routedRows.map(toFeedCard));
  const priced = cards
    .map((card) => card.sincePostedPct)
    .filter((pct): pct is number => pct !== null);
  const avgSincePosted =
    priced.length === 0
      ? null
      : Number((priced.reduce((sum, pct) => sum + pct, 0) / priced.length).toFixed(2));

  return c.json({
    handle,
    ideas: rows.length,
    routed: routedRows.length,
    avgSincePosted,
    winners: priced.filter((pct) => pct > 0).length,
  });
});

/** meta for the "live · Nm ago" header */
app.get("/api/status", async (c) => {
  const [latest] = await db
    .select({ at: sql<string>`max(${rawPosts.fetchedAt})` })
    .from(rawPosts);
  const [counts] = await db
    .select({ ideas: sql<number>`count(*)::int` })
    .from(tradeIdeas)
    .innerJoin(routes, eq(routes.ideaId, tradeIdeas.id))
    .where(eq(routes.status, "routed"));
  return c.json({ lastFetchAt: latest?.at ?? null, routedIdeas: counts?.ideas ?? 0 });
});

const port = Number(process.env.API_PORT ?? 8787);
console.log(`[api] listening on http://localhost:${port}`);

export default { port, fetch: app.fetch };
