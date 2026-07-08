import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { config } from "../config";
import type { ExtractedIdea } from "./extract";
import type { VenueCandidate } from "../venues/types";
import * as hl from "../venues/hyperliquid";
import * as pm from "../venues/polymarket";
import * as polygon from "../venues/polygon";
import * as coingecko from "../venues/coingecko";
import { withRetry } from "../util/retry";

const openai = createOpenAI({ apiKey: config.openaiApiKey });

export interface DerivationStep {
  text: string;
  // provenance: grounded in a verbatim quote, our inference, or a market/venue fact
  basis: "quote" | "inference" | "market";
}

export interface Pipeline {
  explanation: string; // 1-2 sentence summary of the whole chain
  steps: DerivationStep[]; // author's words → belief → subject → instrument
}

export interface RouteDecision {
  status: "routed" | "unrouted";
  unroutedReason?: string;
  selected?: VenueCandidate;
  tradeType?: "direct" | "derived";
  pipeline?: Pipeline;
  alternatives: { venue: string; ticker: string; direction: string; note?: string }[];
}

/**
 * Bounded routing (decision: NOT an open tool-loop like cassie's agent).
 * 1. Deterministically gather venue-VALIDATED candidates for the idea.
 * 2. One LLM call ranks only those real candidates — it can pick or declare
 *    unrouted, but it cannot invent instruments.
 */
export async function routeIdea(idea: ExtractedIdea): Promise<RouteDecision> {
  const candidates = await gatherCandidates(idea);

  if (candidates.length === 0) {
    return {
      status: "unrouted",
      unroutedReason: "no venue-validated instrument for any candidate ticker",
      alternatives: [],
    };
  }

  const { object } = await withRetry(() =>
    generateObject({
    model: openai(config.extractorModel),
    system: `You pick the best tradeable expression for a trade idea from a list of venue-validated candidates. Prefer the most DIRECT expression of what the author actually said; a derived expression must not change the thesis. If every candidate distorts the idea, mark it unrouted. Never invent instruments not in the list.

Also produce the "pipeline": the reasoning chain from the author's words to the chosen instrument, as ordered steps. Tag each step's basis: "quote" when it rests on the author's verbatim words, "market" when it rests on a venue/market fact from the candidates, "inference" when it is your own mapping. Keep steps short and concrete.`,
    prompt: JSON.stringify({
      idea: {
        thesis: idea.thesis,
        direction: idea.direction,
        subjects: idea.subjects,
        quotes: idea.quotes,
        headline_quote: idea.headline_quote,
        asset_class: idea.asset_class,
      },
      candidates: candidates.map((c, i) => ({
        index: i,
        venue: c.venue,
        instrument: c.instrument,
        ticker: c.displayTicker,
        direction: c.direction,
        markPrice: c.markPrice,
        note: c.liquidityNote,
        meta: c.marketMeta,
      })),
    }),
    schema: z.object({
      decision: z.enum(["routed", "unrouted"]),
      selected_index: z.number().int().min(0).nullable(),
      trade_type: z
        .enum(["direct", "derived"])
        .nullable()
        .describe("direct = the author literally named this expression; derived = we mapped it."),
      pipeline: z.object({
        explanation: z.string(),
        steps: z.array(
          z.object({ text: z.string(), basis: z.enum(["quote", "inference", "market"]) }),
        ),
      }),
      unrouted_reason: z.string().nullable(),
    }),
    }),
  );

  const selected =
    object.decision === "routed" && object.selected_index !== null
      ? candidates[object.selected_index]
      : undefined;

  if (!selected) {
    return {
      status: "unrouted",
      unroutedReason: object.unrouted_reason ?? object.pipeline.explanation,
      pipeline: object.pipeline,
      alternatives: toAlternatives(candidates),
    };
  }

  return {
    status: "routed",
    selected,
    tradeType: object.trade_type ?? "derived",
    pipeline: object.pipeline,
    alternatives: toAlternatives(candidates.filter((c) => c !== selected)),
  };
}

async function gatherCandidates(idea: ExtractedIdea): Promise<VenueCandidate[]> {
  const out: VenueCandidate[] = [];
  const longShort = idea.direction === "long" || idea.direction === "short";
  const tickers = [...new Set(idea.candidate_tickers.map((t) => t.replace(/^\$/, "")))].slice(0, 4);

  if (longShort) {
    const dir = idea.direction as "long" | "short";
    for (const ticker of tickers) {
      try {
        if (idea.asset_class === "crypto") {
          // Perp first (deepest, matches paste.trade), spot as tail.
          const perp = await hl.searchPerp(ticker, dir);
          if (perp) out.push(perp);
          else {
            const spot = await coingecko.resolveCoin(ticker, dir);
            if (spot) out.push(spot);
          }
        } else {
          // Equity/ETF/commodity/fx — try HL synthetic stock perps too (they
          // exist on builder dexes). If a perp exists, use it as the direct
          // expression; Polygon shares are only the fallback for tickers HL
          // does not list.
          const perp = await hl.searchPerp(ticker, dir);
          if (perp) {
            out.push(perp);
          } else {
            const shares = await polygon.validateTicker(ticker, dir);
            if (shares) out.push(shares);
          }
        }
      } catch (err) {
        console.warn(`[route] candidate ${ticker} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Event/macro ideas (or anything yes/no) get a Polymarket sweep on the thesis.
  if (idea.direction === "yes" || idea.direction === "no" || idea.asset_class === "event" || idea.asset_class === "macro") {
    try {
      const side = idea.direction === "no" ? "no" : "yes";
      const query = idea.subjects[0]?.label ?? idea.thesis;
      out.push(...(await pm.searchMarkets(query, side, 4)));
    } catch (err) {
      console.warn(`[route] polymarket sweep failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return out;
}

function toAlternatives(candidates: VenueCandidate[]) {
  return candidates.slice(0, 5).map((c) => ({
    venue: c.venue,
    ticker: c.displayTicker,
    direction: c.direction,
    note: c.liquidityNote,
  }));
}
