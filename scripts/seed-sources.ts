import { readFileSync } from "node:fs";
import { db, schema, closeDb } from "../src/db/client";

interface SourceEntry {
  handle: string;
  name: string | null;
  profile_url: string;
  tracked: boolean;
}

const entries: SourceEntry[] = JSON.parse(
  readFileSync(new URL("../data/twitter_sources.json", import.meta.url), "utf8"),
);

let inserted = 0;
for (const entry of entries) {
  const result = await db
    .insert(schema.sources)
    .values({
      handle: entry.handle,
      name: entry.name,
      profileUrl: entry.profile_url,
      tracked: entry.tracked,
    })
    .onConflictDoUpdate({
      target: schema.sources.handle,
      set: { name: entry.name, profileUrl: entry.profile_url, tracked: entry.tracked },
    })
    .returning({ handle: schema.sources.handle });
  inserted += result.length;
}

console.log(`Seeded ${inserted}/${entries.length} sources`);
await closeDb();
