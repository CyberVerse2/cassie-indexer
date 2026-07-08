export interface FeedCard {
  id: string;
  venue: string;
  venueLabel: string;
  instrument: string;
  category: string;
  ticker: string;
  direction: "long" | "short" | "yes" | "no";
  tradeType: "direct" | "derived" | null;
  sincePostedPct: number | null;
  currentPrice: number | null;
  entryPrice: number | null;
  logoUrl: string;
  postedAt: string;
  author: { handle: string; name: string; avatarUrl: string; profileUrl: string };
  text: string;
  headlineQuote: string;
  conviction: "low" | "medium" | "high" | null;
  horizon: string | null;
  sourceUrl: string | null;
}

export interface Status {
  lastFetchAt: string | null;
  routedIdeas: number;
}

export async function fetchIdeas(tab: string): Promise<FeedCard[]> {
  const res = await fetch(`/api/ideas?tab=${encodeURIComponent(tab)}&limit=50`);
  if (!res.ok) throw new Error(`ideas ${res.status}`);
  return (await res.json()).cards;
}

export async function fetchStatus(): Promise<Status> {
  const res = await fetch("/api/status");
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

export interface DerivationStep {
  text: string;
  basis: "quote" | "inference" | "market";
}

export interface IdeaDetail extends FeedCard {
  thesis: string;
  context: string | null;
  subjects: { label: string; kind: string }[];
  quotes: string[];
  assetClass: string;
  pipeline: { explanation: string; steps: DerivationStep[] } | null;
  alternatives: { venue: string; ticker: string; direction: string; note?: string }[] | null;
  unroutedReason: string | null;
  routeStatus: string;
  extractorModel: string;
}

export async function fetchIdea(id: string): Promise<IdeaDetail> {
  const res = await fetch(`/api/ideas/${id}`);
  if (!res.ok) throw new Error(`idea ${res.status}`);
  return res.json();
}
