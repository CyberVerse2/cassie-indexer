function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/cassie_indexer",
  get xBearerToken() {
    return required("X_BEARER_TOKEN");
  },
  get openaiApiKey() {
    return required("OPENAI_API_KEY");
  },
  polygonApiKey: process.env.POLYGON_API_KEY ?? "",
  coingeckoApiKey: process.env.COINGECKO_API_KEY ?? "",
  hyperliquidApiUrl: process.env.HYPERLIQUID_API_URL ?? "https://api.hyperliquid.xyz",
  polymarketGammaUrl:
    process.env.POLYMARKET_GAMMA_API_URL ?? "https://gamma-api.polymarket.com",
  collectLookbackHours: Number(process.env.COLLECT_LOOKBACK_HOURS ?? 24),
  processBatchSize: Number(process.env.PROCESS_BATCH_SIZE ?? 25),
  extractorModel: process.env.EXTRACTOR_MODEL ?? "gpt-5.4-mini",
  extractorVersion: "v1",
  routerVersion: "v1",
};
