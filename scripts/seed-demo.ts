import { eq } from "drizzle-orm";
import { db, schema, closeDb } from "../src/db/client";

// Realistic idea-bearing tweets for existing tracked handles. Inserted as
// pending raw_posts so `bun run process` turns them into genuine cards
// (real routing, real prices). Handles must exist in `sources` (seeded).
const DEMO: { handle: string; minsAgo: number; text: string }[] = [
  {
    handle: "blknoiz06",
    minsAgo: 22,
    text: "SOL/ETH ratio just reclaimed the level it lost in March. every time this flips it runs for weeks. long SOL here, this is the cleanest chart in majors.",
  },
  {
    handle: "zephyr_z9",
    minsAgo: 48,
    text: "HYPE consolidating under ATH for 9 days now. OI building, funding still flat. this is a coiled spring and I want to be long before the expansion.",
  },
  {
    handle: "ThinkingUSD",
    minsAgo: 130,
    text: "everyone is max long here. funding is the highest it's been all cycle and the crowd is euphoric. short ETH, the pain trade is down.",
  },
  {
    handle: "degentradingLSD",
    minsAgo: 75,
    text: "btc reclaiming 100k with spot volume finally showing up instead of just perps. dips are for buying. long.",
  },
  {
    handle: "HiCagr",
    minsAgo: 96,
    text: "NVDA coiling into earnings, semis leadership completely intact and the AI capex cycle is nowhere near done. long NVDA.",
  },
];

let inserted = 0;
for (const d of DEMO) {
  const [src] = await db.select().from(schema.sources).where(eq(schema.sources.handle, d.handle));
  if (!src) {
    console.warn(`skip @${d.handle}: not in sources`);
    continue;
  }
  const res = await db
    .insert(schema.rawPosts)
    .values({
      tweetId: `demo-${d.handle}-${d.minsAgo}`,
      sourceId: src.id,
      authorHandle: d.handle,
      text: d.text,
      lang: "en",
      postedAt: new Date(Date.now() - d.minsAgo * 60_000),
    })
    .onConflictDoNothing()
    .returning({ id: schema.rawPosts.tweetId });
  inserted += res.length;
}

console.log(`Seeded ${inserted} demo posts (run \`bun run process\` to index them)`);
await closeDb();
