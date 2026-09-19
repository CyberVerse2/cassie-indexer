import { z } from "zod";
import { search } from "../venues/definitive";
import { preparePlan } from "./plan";
import type { ExtractedIdea } from "./extract";
import type { VenueCandidate } from "../venues/types";
import { generateQwenJson } from "../util/qwen";
import { withRetry } from "../util/retry";

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
export async function routeIdea(idea: ExtractedIdea, postedAt = new Date()): Promise<RouteDecision> {
  const candidates = await gatherCandidates(idea);

  if (candidates.length === 0) {
    return {
      status: "unrouted",
      unroutedReason: "no venue-validated instrument for any candidate ticker",
      alternatives: [],
    };
  }

  const object = await withRetry(() =>
    generateQwenJson({
      system: `You pick the best tradeable expression for a trade idea from a list of venue-validated candidates. Prefer the most DIRECT expression of what the author actually said; a derived expression must not change the thesis. If every candidate distorts the idea, mark it unrouted. Never invent instruments not in the list.

Return JSON only with exactly this shape:
{"decision":"routed"|"unrouted","selected_index":number|null,"trade_type":"direct"|"derived"|null,"pipeline":{"explanation":string,"steps":[{"text":string,"basis":"quote"|"market"|"inference"}]},"unrouted_reason":string|null}

For a routed decision, selected_index must be one of the supplied candidate indexes. For an unrouted decision, selected_index and trade_type must be null and unrouted_reason must explain why every candidate distorts the idea.

The pipeline is the reasoning chain from the author's words to the chosen instrument. Tag each step's basis: "quote" when it rests on the author's verbatim words, "market" when it rests on a venue/market fact from the candidates, and "inference" when it is your own mapping. Keep steps short and concrete.`,
      content: JSON.stringify({
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
      maxTokens: 1_000,
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

  let plan;
  try{plan=await preparePlan(idea,selected.marketMeta!.definitive,postedAt);}catch(error){return {status:"unrouted",unroutedReason:error instanceof Error?error.message:"Plan unavailable",alternatives:toAlternatives(candidates)};}
  selected.marketMeta={...selected.marketMeta,executionPlan:plan};
  return {
    status: "routed",
    selected,
    tradeType: object.trade_type ?? "derived",
    pipeline: object.pipeline,
    alternatives: toAlternatives(candidates.filter((c) => c !== selected)),
  };
}

async function gatherCandidates(idea: ExtractedIdea): Promise<VenueCandidate[]> {
  if(idea.direction!=='long'||['event','fx'].includes(idea.asset_class))return [];
  const tickers=[...new Set(idea.candidate_tickers.map(t=>t.replace(/^\$/, '').toUpperCase()))].slice(0,4);
  const candidates:VenueCandidate[]=[];
  for(const ticker of tickers)candidates.push(...await search(ticker,idea.asset_class==='crypto'?'spot':'shares'));
  return candidates;
}

function toAlternatives(candidates: VenueCandidate[]) {
  return candidates.slice(0, 5).map((c) => ({
    venue: c.venue,
    ticker: c.displayTicker,
    direction: c.direction,
    note: c.liquidityNote,
  }));
}
