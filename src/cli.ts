import { collectAll } from "./collector/collect";
import { processPending } from "./processor/process";
import { closeDb } from "./db/client";
import { config } from "./config";

const HOUR_MS = 3_600_000;

async function runOnce() {
  const collected = await collectAll();
  console.log(
    `[collect] done: ${collected.fetched} posts from ${collected.sources} sources (${collected.errors} errors)`,
  );
  // Drain until a batch comes back short — empties the backlog within a run
  // while keeping each DB drain bounded.
  for (;;) {
    const p = await processPending();
    console.log(
      `[process] done: ${p.posts} posts → ${p.ideas} ideas (${p.routed} routed, ${p.failed} failed)`,
    );
    if (p.posts < config.processBatchSize) break;
  }
}

async function main() {
  const cmd = process.argv[2] ?? "run";

  switch (cmd) {
    case "collect": {
      const r = await collectAll();
      console.log(`[collect] ${r.fetched} posts from ${r.sources} sources (${r.errors} errors)`);
      break;
    }
    case "process": {
      const r = await processPending();
      console.log(`[process] ${r.posts} posts → ${r.ideas} ideas (${r.routed} routed, ${r.failed} failed)`);
      break;
    }
    case "run": {
      await runOnce();
      break;
    }
    case "daemon": {
      console.log("[daemon] hourly loop started");
      // Run immediately, then every hour. A failed sweep logs and waits for
      // the next tick — the daemon itself never dies.
      for (;;) {
        try {
          await runOnce();
        } catch (err) {
          console.error(`[daemon] sweep failed: ${err instanceof Error ? err.message : err}`);
        }
        await new Promise((r) => setTimeout(r, HOUR_MS));
      }
    }
    default:
      console.error(`Unknown command: ${cmd}. Use collect | process | run | daemon`);
      process.exitCode = 1;
  }

  if (cmd !== "daemon") await closeDb();
}

main();
