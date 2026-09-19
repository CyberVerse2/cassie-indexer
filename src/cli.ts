import { collectAll, LIVE_WINDOW_MINUTES } from "./collector/collect";
import { processPending } from "./processor/process";
import { closeDb } from "./db/client";
import { config } from "./config";

async function runOnce() {
  const started = new Date();
  const collected = await collectAll();
  console.log(
    `[collect] done: ${collected.fetched} posts from ${collected.sources} sources (${collected.errors} errors) window=${collected.windowMinutes}m`,
  );
  const p = collected.windowMinutes > LIVE_WINDOW_MINUTES
    ? await drainPending()
    : await processPending({ fetched: started });
  console.log(
    `[process] done: ${p.posts} posts → ${p.ideas} ideas (${p.routed} routed, ${p.failed} failed)`,
  );
}

async function drainPending() {
  const total = { posts: 0, ideas: 0, routed: 0, failed: 0 };
  for (let i = 0; i < 40; i++) {
    const p = await processPending();
    total.posts += p.posts;
    total.ideas += p.ideas;
    total.routed += p.routed;
    total.failed += p.failed;
    if (p.posts === 0) break;
  }
  return total;
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
      const mins = Math.round(config.collectIntervalMs / 60_000);
      console.log(`[daemon] loop started — every ${mins} min`);
      // Run immediately, then every interval. A failed sweep logs and waits for
      // the next tick — the daemon itself never dies. The interval starts AFTER
      // each sweep completes, so a slow drain never overlaps the next collect.
      for (;;) {
        try {
          await runOnce();
        } catch (err) {
          console.error(`[daemon] sweep failed: ${err instanceof Error ? err.message : err}`);
        }
        await new Promise((r) => setTimeout(r, config.collectIntervalMs));
      }
    }
    default:
      console.error(`Unknown command: ${cmd}. Use collect | process | run | daemon`);
      process.exitCode = 1;
  }

  if (cmd !== "daemon") await closeDb();
}

main();
