import { generateText, Output } from "ai";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { config } from "../src/config";
import { closeDb, db, schema } from "../src/db/client";
import { horizonSchema } from "../src/processor/extract";
import { resolveModel } from "../src/util/model";
import { withRetry } from "../src/util/retry";

const { tradeIdeas } = schema;
const BATCH_SIZE = 40;

const classificationSchema = z.object({
  ideas: z.array(
    z.object({
      id: z.string().uuid(),
      horizon: horizonSchema,
    }),
  ),
});

const SYSTEM = `Normalize the intended holding period for every supplied trade idea.

Return exactly one result for every input id and use only these values:
- immediate: same session through 3 days
- short-term: 4 days through 4 weeks
- medium-term: over 4 weeks through 6 months
- long-term: over 6 months
- unspecified: timing cannot be determined from the supplied horizon or hold plan

Classify the intended holding period, not the age of the post. A dated catalyst determines the bucket when its timing is clear. Do not infer a duration from the asset class or thesis alone.`;

async function main() {
  const rows = await db
    .select({
      id: tradeIdeas.id,
      horizon: tradeIdeas.horizon,
      strategy: tradeIdeas.strategy,
    })
    .from(tradeIdeas);

  const classifications = new Map<string, z.infer<typeof horizonSchema>>();

  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const prompt = JSON.stringify(
      batch.map((row) => ({
        id: row.id,
        current_horizon: row.horizon,
        hold_plan: row.strategy?.hold?.text ?? null,
      })),
    );

    const result = await withRetry(() =>
      generateText({
        model: resolveModel(config.extractorModel),
        system: SYSTEM,
        prompt,
        output: Output.object({ schema: classificationSchema }),
      }),
    );

    const expectedIds = new Set(batch.map((row) => row.id));
    for (const item of result.output.ideas) {
      if (!expectedIds.has(item.id)) throw new Error(`Model returned unknown idea id ${item.id}`);
      if (classifications.has(item.id)) throw new Error(`Model returned duplicate idea id ${item.id}`);
      classifications.set(item.id, item.horizon);
    }

    const missing = batch.filter((row) => !classifications.has(row.id));
    if (missing.length) throw new Error(`Model omitted ${missing.length} ideas in batch ${offset / BATCH_SIZE + 1}`);
    console.log(`classified ${Math.min(offset + batch.length, rows.length)}/${rows.length}`);
  }

  if (classifications.size !== rows.length) {
    throw new Error(`Expected ${rows.length} classifications, received ${classifications.size}`);
  }

  await db.transaction(async (tx) => {
    for (const [id, horizon] of classifications) {
      await tx.update(tradeIdeas).set({ horizon }).where(eq(tradeIdeas.id, id));
    }
  });

  const counts = [...classifications.values()].reduce<Record<string, number>>((acc, horizon) => {
    acc[horizon] = (acc[horizon] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`normalized ${classifications.size} ideas`, counts);
}

try {
  await main();
} finally {
  await closeDb();
}
