import { expect, test } from "bun:test";
import { historyTicker } from "./polygon";

test("maps share tickers to Polygon stocks", () => {
  expect(historyTicker("NVDA", "shares")).toBe("NVDA");
  expect(historyTicker("$MSFT", "shares")).toBe("MSFT");
});

test("maps spot tickers to Polygon crypto pairs", () => {
  expect(historyTicker("BTC", "spot")).toBe("X:BTCUSD");
  expect(historyTicker("ETH-USD", "spot")).toBe("X:ETHUSD");
});
