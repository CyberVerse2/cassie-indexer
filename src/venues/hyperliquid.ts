import { config } from "../config";
import type { VenueCandidate } from "./types";

// Adapted from cassie packages/adapters/index.ts (HyperliquidMarketDataProvider):
// same POST /info request types (perpDexs, metaAndAssetCtxs, allMids), reduced
// to indexer needs. candleSnapshot (price-at-post-time) is new here — cassie
// only ever needed live marks.

async function info<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${config.hyperliquidApiUrl}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid info ${res.status}: ${JSON.stringify(body)}`);
  return res.json() as Promise<T>;
}

interface PerpUniverseEntry {
  name: string;
  szDecimals: number;
  maxLeverage?: number;
  isDelisted?: boolean;
}

let universeCache: { at: number; entries: Map<string, { dex: string; meta: PerpUniverseEntry }> } | null = null;

/** Perp universe across the default dex + builder dexes (where HL's synthetic
 * stock perps live), cached for the run. */
async function perpUniverse(): Promise<Map<string, { dex: string; meta: PerpUniverseEntry }>> {
  if (universeCache && Date.now() - universeCache.at < 10 * 60_000) return universeCache.entries;

  const entries = new Map<string, { dex: string; meta: PerpUniverseEntry }>();
  const dexes = await info<({ name: string } | null)[]>({ type: "perpDexs" });
  const dexNames = ["", ...dexes.filter(Boolean).map((d) => d!.name)];

  for (const dex of dexNames) {
    try {
      const [meta] = await info<[{ universe: PerpUniverseEntry[] }, unknown]>({
        type: "metaAndAssetCtxs",
        ...(dex ? { dex } : {}),
      });
      for (const u of meta.universe) {
        if (u.isDelisted) continue;
        // Builder-dex assets are namespaced ("xyz:INTC") — index the bare
        // symbol too so ticker lookups hit them. First dex seen wins.
        const key = u.name.toUpperCase();
        const bare = key.includes(":") ? key.split(":")[1] : key;
        if (!entries.has(key)) entries.set(key, { dex, meta: u });
        if (!entries.has(bare)) entries.set(bare, { dex, meta: u });
      }
    } catch {
      // A builder dex failing to answer shouldn't kill the sweep.
    }
  }

  universeCache = { at: Date.now(), entries };
  return entries;
}

export async function searchPerp(
  ticker: string,
  direction: "long" | "short",
): Promise<VenueCandidate | null> {
  const universe = await perpUniverse();
  const hit = universe.get(ticker.toUpperCase());
  if (!hit) return null;

  return {
    venue: "hyperliquid",
    instrument: "perp",
    ticker: hit.meta.name,
    displayTicker: ticker.toUpperCase(),
    direction,
    markPrice: await livePrice(hit.meta.name, hit.dex),
    liquidityNote: `maxLeverage ${hit.meta.maxLeverage ?? "?"}${hit.dex ? ` (dex: ${hit.dex})` : ""}`,
    marketMeta: { dex: hit.dex, szDecimals: hit.meta.szDecimals },
  };
}

export async function livePrice(coin: string, dex = ""): Promise<number | null> {
  const mids = await info<Record<string, string>>({ type: "allMids", ...(dex ? { dex } : {}) });
  const mid = mids[coin];
  return mid ? Number(mid) : null;
}

/** Mark at (or just before) a timestamp via 1m candles, widening to 1h for
 * older posts. This is the entry-price primitive for P&L-since-posted. */
export async function priceAt(coin: string, at: Date): Promise<number | null> {
  for (const interval of ["1m", "1h"] as const) {
    const windowMs = interval === "1m" ? 60 * 60_000 : 48 * 3_600_000;
    const candles = await info<{ t: number; c: string }[]>({
      type: "candleSnapshot",
      req: {
        coin,
        interval,
        startTime: at.getTime() - windowMs,
        endTime: at.getTime() + 60_000,
      },
    });
    const before = candles.filter((c) => c.t <= at.getTime());
    const candle = before.at(-1) ?? candles[0];
    if (candle) return Number(candle.c);
  }
  return null;
}
