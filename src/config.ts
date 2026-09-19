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
  get twitterApiIoKey() {
    return required("TWITTERAPI_IO_KEY");
  },
  twitterApiIoUrl: process.env.TWITTERAPI_IO_URL ?? "https://api.twitterapi.io",
  get geminiApiKey() {
    return required("GEMINI_API_KEY");
  },
  get deepseekApiKey() {
    return required("DEEPSEEK_API_KEY");
  },
  get openrouterApiKey() {
    return required("OPENROUTER_API_KEY");
  },
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  qwenModel: process.env.QWEN_MODEL ?? "qwen/qwen3.6-flash",
  jevModel: process.env.JEV_MODEL ?? "typesafe/jev-1.13",
  jevPassThreshold: Number(process.env.JEV_PASS_THRESHOLD ?? 0.3),
  polygonApiKey: process.env.POLYGON_API_KEY ?? "",
  hyperliquidApiUrl: process.env.HYPERLIQUID_API_URL ?? "https://api.hyperliquid.xyz",
  polymarketGammaUrl:
    process.env.POLYMARKET_GAMMA_API_URL ?? "https://gamma-api.polymarket.com",
  polymarketClobUrl: process.env.POLYMARKET_CLOB_API_URL ?? "https://clob.polymarket.com",
  // Daemon cadence. advanced_search bills per NEW tweet, so frequency is ~free —
  // 5-min polling costs the same as hourly but is far fresher.
  collectIntervalMs: Number(process.env.COLLECT_INTERVAL_MINUTES ?? 5) * 60_000,
  processBatchSize: Number(process.env.PROCESS_BATCH_SIZE ?? 25),
  extractorModel: process.env.EXTRACTOR_MODEL ?? "deepseek-flash",
  extractorVersion: "v6-deepseek-extract",
  routerVersion: "v2-qwen3.6-flash",
};
