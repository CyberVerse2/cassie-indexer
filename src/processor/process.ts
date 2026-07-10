import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client";
import { config } from "../config";
import { extractIdeas } from "./extract";
import { routeIdea } from "./route";
import { priceRoute } from "./price";
import { assembleThread } from "./thread";
import { fetchTweetsText } from "../collector/twitter";

const { rawPosts, tradeIdeas, routes, routePricing } = schema;
type Post = typeof rawPosts.$inferSelect;

/**
 * Resolve the referenced-tweet context for a thread root. Legacy rows carry it
 * inline (eager expansion); new rows don't — so we fetch the QUOTED tweet's
 * text lazily here, only for a post that has actually reached extraction. (A
 * self-thread's own parents are already in the assembled text; replies to other
 * people are skipped before this runs, so in practice this resolves quotes.)
 */
async function resolveReferencedText(root: Post): Promise<string | null> {
  if (root.referencedText) return root.referencedText;
  const refs = (root.raw as { referenced_tweets?: { type: string; id: string }[] } | null)
    ?.referenced_tweets;
  const ids = (refs ?? []).filter((r) => r.type === "quoted").map((r) => r.id);
  if (ids.length === 0) return null;
  try {
    const texts = await fetchTweetsText(ids);
    return ids.map((id) => texts.get(id)).filter(Boolean).join("\n---\n") || null;
  } catch (err) {
    console.warn(
      `[process] quoted-context fetch failed for ${root.tweetId}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Stage 2 — Processor. Drains raw_posts where status='pending' (from the DB,
 * never from X) through gate+extract → route → price.
 *
 * Thread-aware: a self-author reply chain is assembled and extracted ONCE as a
 * single unit (anchored to the thread root), so a thesis spread across several
 * tweets yields one idea instead of duplicates + orphan fragments.
 */
export async function processPending(): Promise<{
  posts: number;
  ideas: number;
  routed: number;
  failed: number;
}> {
  const pending = await db
    .select()
    .from(rawPosts)
    .where(eq(rawPosts.status, "pending"))
    .orderBy(asc(rawPosts.postedAt))
    .limit(config.processBatchSize);

  const handled = new Set<string>();
  let posts = 0;
  let ideas = 0;
  let routed = 0;
  let failed = 0;

  for (const post of pending) {
    if (handled.has(post.tweetId)) continue;

    // Expand this post into its full thread (may pull in members outside the
    // current batch — that's fine, they get marked handled too).
    const thread = await assembleThread(post);
    for (const t of thread) handled.add(t.tweetId);
    posts += thread.length;

    try {
      const result = await processThread(thread);
      ideas += result.ideas;
      routed += result.routed;
    } catch (err) {
      failed += thread.length;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[process] thread @${post.authorHandle} (${post.tweetId}): ${message}`);
      await db
        .update(rawPosts)
        .set({ status: "failed", processError: message.slice(0, 500) })
        .where(inArray(rawPosts.tweetId, thread.map((t) => t.tweetId)));
    }
  }

  return { posts, ideas, routed, failed };
}

/** Remove any existing ideas (and their routes/pricing) anchored to these
 * posts, so reprocessing a thread — or a thread growing across runs — replaces
 * rather than duplicates. */
async function deleteIdeasForPosts(tweetIds: string[]) {
  const ideaRows = await db
    .select({ id: tradeIdeas.id })
    .from(tradeIdeas)
    .where(inArray(tradeIdeas.tweetId, tweetIds));
  const ideaIds = ideaRows.map((r) => r.id);
  if (ideaIds.length === 0) return;

  const routeRows = await db
    .select({ id: routes.id })
    .from(routes)
    .where(inArray(routes.ideaId, ideaIds));
  const routeIds = routeRows.map((r) => r.id);
  if (routeIds.length) await db.delete(routePricing).where(inArray(routePricing.routeId, routeIds));
  await db.delete(routes).where(inArray(routes.ideaId, ideaIds));
  await db.delete(tradeIdeas).where(inArray(tradeIdeas.id, ideaIds));
}

async function processThread(thread: Post[]): Promise<{ ideas: number; routed: number }> {
  const root = thread[0];
  const memberIds = thread.map((t) => t.tweetId);

  // Idempotent: clear anything previously extracted from any thread member.
  await deleteIdeasForPosts(memberIds);

  // Policy: don't process replies to OTHER people. We keep originals, quotes,
  // and self-threads (a self-reply chain is rooted at an original/quote, so its
  // root is not a reply-to-others). A thread whose root replies to someone else
  // is conversation, not the author's own call — skip the whole thing.
  if (root.isReply && !root.isSelfReply) {
    await db
      .update(rawPosts)
      .set({ status: "processed", processedAt: new Date(), ideasExtracted: 0, processError: null })
      .where(inArray(rawPosts.tweetId, memberIds));
    return { ideas: 0, routed: 0 };
  }

  // Assemble the thread into one text block. Numbering only when multi-tweet so
  // single posts are unchanged; tweet text stays verbatim for quote checks.
  const assembledText =
    thread.length === 1
      ? root.text
      : thread.map((t, i) => `(${i + 1}/${thread.length}) ${t.text}`).join("\n\n");

  // Self-quote: the author quoting their OWN earlier tweet — treat its context
  // as fully theirs. twitterapi.io inlines quoted_tweet with its author.
  const rawRoot = root.raw as {
    author?: { id?: string };
    quoted_tweet?: { author?: { id?: string } };
  } | null;
  const isSelfQuote =
    root.isQuote &&
    Boolean(rawRoot?.quoted_tweet?.author?.id) &&
    rawRoot?.quoted_tweet?.author?.id === rawRoot?.author?.id;

  // Images across all thread members — charts/screenshots the model should read.
  const imageUrls = thread
    .flatMap((t) => (t.media ?? []) as { type: string; url?: string }[])
    .filter((m) => m.type !== "video" && m.url)
    .map((m) => m.url!)
    .slice(0, 4);

  // ① Gate + extract — one call for the whole thread, opportunity-first.
  const extraction = await extractIdeas({
    authorHandle: root.authorHandle,
    text: assembledText,
    referencedText: await resolveReferencedText(root),
    isReply: root.isReply,
    isSelfReply: root.isSelfReply,
    isSelfQuote,
    isQuote: root.isQuote,
    imageUrls,
    postedAt: root.postedAt,
  });

  let routedCount = 0;

  for (const idea of extraction.ideas) {
    // Anchor every idea to the thread root: its posted_at is the entry-price
    // baseline, its tweet is the card's source link + preview.
    const [ideaRow] = await db
      .insert(tradeIdeas)
      .values({
        tweetId: root.tweetId,
        authorHandle: root.authorHandle,
        postedAt: root.postedAt,
        thesis: idea.thesis,
        reasoning: idea.reasoning,
        subjects: idea.subjects,
        direction: idea.direction,
        statedByAuthor: idea.stated_by_author,
        horizon: idea.horizon,
        target: idea.target,
        invalidation: idea.invalidation,
        strategy: {
          exit: idea.strategy.exit,
          hold: idea.strategy.hold,
          stopLoss: idea.strategy.stop_loss,
          takeProfit: idea.strategy.take_profit,
        },
        conviction: idea.conviction,
        quotes: idea.quotes,
        headlineQuote: idea.headline_quote,
        assetClass: idea.asset_class,
        context: idea.context,
        references: extraction.references.length ? extraction.references : null,
        candidateTickers: idea.candidate_tickers,
        extractorVersion: config.extractorVersion,
        model: config.extractorModel,
      })
      .returning();

    // ② Route — bounded ranking over venue-validated candidates.
    const decision = await routeIdea(idea);
    const [routeRow] = await db
      .insert(routes)
      .values({
        ideaId: ideaRow.id,
        status: decision.status,
        unroutedReason: decision.unroutedReason,
        venue: decision.selected?.venue,
        instrument: decision.selected?.instrument,
        ticker: decision.selected?.ticker,
        direction: decision.selected?.direction,
        tradeType: decision.tradeType,
        pipeline: decision.pipeline,
        alternatives: decision.alternatives,
        marketMeta: decision.selected?.marketMeta,
        routerVersion: config.routerVersion,
      })
      .returning();

    if (decision.status !== "routed" || !decision.selected) {
      await db.update(tradeIdeas).set({ status: "unrouted" }).where(eq(tradeIdeas.id, ideaRow.id));
      continue;
    }
    routedCount++;
    await db.update(tradeIdeas).set({ status: "routed" }).where(eq(tradeIdeas.id, ideaRow.id));

    // ③ Price — entry at the thread's posted time + current.
    try {
      const prices = await priceRoute(decision.selected, root.postedAt);
      await db.insert(routePricing).values({
        routeId: routeRow.id,
        entryPrice: prices.entryPrice?.toString(),
        entryPricedAt: prices.entryPrice !== null ? root.postedAt : null,
        entryNote: prices.entryNote,
        currentPrice: prices.currentPrice?.toString(),
        currentPricedAt: prices.currentPrice !== null ? new Date() : null,
        sincePostedPct: prices.sincePostedPct?.toString(),
      });
      await db.update(tradeIdeas).set({ status: "priced" }).where(eq(tradeIdeas.id, ideaRow.id));
    } catch (err) {
      console.warn(`[price] idea ${ideaRow.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ④ Finalize every member of the thread. The root carries the idea count.
  await db
    .update(rawPosts)
    .set({ status: "processed", processedAt: new Date(), ideasExtracted: 0, processError: null })
    .where(inArray(rawPosts.tweetId, memberIds));
  await db
    .update(rawPosts)
    .set({ ideasExtracted: extraction.ideas.length })
    .where(eq(rawPosts.tweetId, root.tweetId));

  if (extraction.ideas.length > 0) {
    const tag = thread.length > 1 ? `thread×${thread.length}` : "post";
    console.log(
      `[process] @${root.authorHandle} ${tag} ${root.tweetId}: ${extraction.ideas.length} idea(s), ${routedCount} routed`,
    );
  }

  return { ideas: extraction.ideas.length, routed: routedCount };
}
