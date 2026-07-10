import { writeFileSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { db, schema } from "../src/db/client";
import { extractIdeas, type ExtractionResult, type ExtractedIdea } from "../src/processor/extract";

// A/B: run the SAME posts through gpt-5.4-mini and gpt-5.4-nano and dump the
// FULL extraction for each so it can be analysed by hand. Writes markdown.
const { rawPosts } = schema;

const IDS = [
  "2074530855490637887", // au_xbt $ZEC (quote)
  "2074490297799541144", // TheLongInvest $WYFI breakout
  "2074637905008423196", // zerohedge WTI oil collar
  "2074505641943515533", // TheLongInvest $SNDK -36%
  "2074923974224470445", // pequityresearch $GOOGL/$META capex
  "2074993180378800156", // S&P bond rating relay
  "2074954175952429266", // US notified Israel
  "2074886159449391396", // Polymarket Fed-hike odds
  "2074943575507271922", // OInvests $MU watchlist question
  "2075005500253438390", // SK brokerages margins
];

const posts = await db.select().from(rawPosts).where(inArray(rawPosts.tweetId, IDS));
const byId = new Map(posts.map((p) => [p.tweetId, p]));

function idea(i: ExtractedIdea): string {
  const s = i.strategy;
  return [
    `- **direction:** ${i.direction} · **stated_by_author:** ${i.stated_by_author} · **conviction:** ${i.conviction ?? "—"} · **asset_class:** ${i.asset_class}`,
    `- **tickers:** ${i.candidate_tickers.join(", ") || "—"}`,
    `- **target:** ${i.target ?? "—"} · **invalidation:** ${i.invalidation ?? "—"}`,
    `- **thesis:** ${i.thesis}`,
    `- **reasoning:**`,
    ...i.reasoning.map((r, n) => `    ${n + 1}. ${r}`),
    `- **strategy:**`,
    `    - take_profit (${s.take_profit.basis}): ${s.take_profit.text}`,
    `    - stop_loss (${s.stop_loss.basis}): ${s.stop_loss.text}`,
    `    - hold (${s.hold.basis}): ${s.hold.text}`,
    `    - exit (${s.exit.basis}): ${s.exit.text}`,
    `- **context:** ${i.context}`,
    `- **quotes:** ${i.quotes.map((q) => `“${q}”`).join(" | ")}`,
  ].join("\n");
}

function block(r: ExtractionResult): string {
  if (!r.is_idea) return `**is_idea: false** — ${r.reject_reason ?? "—"}`;
  return `**is_idea: true** (${r.ideas.length} idea${r.ideas.length === 1 ? "" : "s"})\n\n${r.ideas.map(idea).join("\n\n---\n\n")}`;
}

async function run(post: (typeof posts)[number], model: string) {
  return extractIdeas({
    authorHandle: post.authorHandle,
    text: post.text,
    referencedText: post.referencedText,
    isReply: post.isReply,
    isSelfReply: post.isSelfReply,
    isQuote: post.isQuote,
    postedAt: post.postedAt,
    model,
  });
}

const MODELS: [string, string][] = [
  ["mini", "gpt-5.4-mini"],
  ["nano", "gpt-5.4-nano"],
  ["gemini-3.1-flash-lite", "gemini-3.1-flash-lite"],
];

const out: string[] = ["# mini vs nano vs gemini-3.1-flash-lite — full extraction A/B\n"];
for (const id of IDS) {
  const post = byId.get(id);
  if (!post) continue;
  const results = await Promise.all(MODELS.map(([, m]) => run(post, m).catch((e) => e as Error)));
  out.push(
    `\n## @${post.authorHandle}  \`${id}\``,
    `\n> ${post.text.replace(/\s+/g, " ")}`,
    post.referencedText ? `\n> **[quoted]** ${post.referencedText.replace(/\s+/g, " ")}` : "",
  );
  MODELS.forEach(([label], i) => {
    const r = results[i];
    out.push(`\n### ${label}\n${r instanceof Error ? `ERROR: ${r.message}` : block(r)}`);
  });
  out.push(`\n---`);
  console.log(`done: @${post.authorHandle}`);
}

writeFileSync("ab-results.md", out.join("\n"));
console.log("\nwritten → ab-results.md (repo root)");
process.exit(0);
