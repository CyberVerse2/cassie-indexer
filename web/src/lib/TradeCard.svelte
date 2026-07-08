<script lang="ts">
  import type { FeedCard } from "./api";
  import { timeAgo, fmtPrice, fmtPct, isBull } from "./format";

  let { card }: { card: FeedCard } = $props();

  const bull = $derived(isBull(card.direction));
  const pctPositive = $derived((card.sincePostedPct ?? 0) >= 0);
  let avatarBroken = $state(false);
  let logoBroken = $state(false);

  function open() {
    location.hash = `#/i/${card.id}`;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
<article
  class="card"
  style:--accent={bull ? "var(--green)" : "var(--red)"}
  role="link"
  tabindex="0"
  onclick={open}
  onkeydown={(e) => (e.key === "Enter" ? open() : null)}
>
  <div class="rail"></div>

  <header class="top">
    <div class="badges">
      <span class="venue">{card.venueLabel}</span>
      <span class="dir" class:bull class:bear={!bull}>{card.direction.toUpperCase()}</span>
    </div>
    <div class="pnl" class:up={pctPositive} class:down={!pctPositive}>
      <div class="pct">{fmtPct(card.sincePostedPct)}</div>
      <div class="pnl-label">SINCE POSTED</div>
    </div>
  </header>

  <div class="headline">
    <div class="ticker-row">
      {#if card.logoUrl && !logoBroken}
        <img class="logo" src={card.logoUrl} alt="" onerror={() => (logoBroken = true)} />
      {:else}
        <span class="logo logo-fallback">{card.ticker[0]}</span>
      {/if}
      <h2 class="ticker" class:prediction={card.instrument === "prediction"}>{card.ticker}</h2>
    </div>
    <div class="price">
      <span class="now">{fmtPrice(card.currentPrice)}</span>
      {#if card.entryPrice !== null}
        <span class="entry">entry {fmtPrice(card.entryPrice)}</span>
      {/if}
      {#if card.tradeType}
        <span class="tradetype">{card.tradeType}</span>
      {/if}
    </div>
  </div>

  <div class="quote">
    {#if !avatarBroken}
      <img class="avatar" src={card.author.avatarUrl} alt="" onerror={() => (avatarBroken = true)} />
    {:else}
      <span class="avatar avatar-fallback">{card.author.name[0]}</span>
    {/if}
    <div class="quote-body">
      <div class="quote-head">
        <span class="name">{card.author.name}</span>
        <span class="handle">@{card.author.handle}</span>
        <span class="dot">·</span>
        <span class="time">{timeAgo(card.postedAt)}</span>
      </div>
      <p class="text">{card.text}</p>
    </div>
  </div>

  <footer class="foot">
    {#if card.conviction}
      <span class="chip conviction-{card.conviction}">{card.conviction} conviction</span>
    {/if}
    {#if card.horizon}
      <span class="chip">{card.horizon}</span>
    {/if}
    {#if card.sourceUrl}
      <a
        class="src"
        href={card.sourceUrl}
        target="_blank"
        rel="noreferrer"
        onclick={(e) => e.stopPropagation()}
      >view on X ↗</a>
    {/if}
  </footer>
</article>

<style>
  .card {
    position: relative;
    padding: 22px 22px 20px 28px;
    border-bottom: 1px solid var(--line);
    background: transparent;
    cursor: pointer;
    transition: background 0.12s ease;
  }
  .card:hover { background: #0b0c0e; }
  .card:focus-visible { outline: none; background: #0b0c0e; }
  .rail {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: var(--accent);
    opacity: 0.85;
  }

  .top {
    display: flex;
    align-items: center;
  }
  .badges { display: flex; align-items: center; gap: 12px; }
  .venue {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 4px 8px;
  }
  .dir {
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .dir.bull { color: var(--green); }
  .dir.bear { color: var(--red); }

  /* Float the % top-right so it doesn't push the ticker down (mockup rhythm). */
  .pnl {
    position: absolute;
    top: 22px;
    right: 22px;
    text-align: right;
  }
  .pct {
    font-family: var(--mono);
    font-size: 40px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.02em;
  }
  .pnl.up .pct { color: var(--green); }
  .pnl.down .pct { color: var(--red); }
  .pnl-label {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.09em;
    color: var(--faint);
    margin-top: 7px;
  }

  .headline { margin-top: 16px; }
  .ticker-row { display: flex; align-items: center; gap: 11px; }
  .logo {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--surface-2);
    border: 1px solid var(--line);
    object-fit: cover;
  }
  .logo-fallback {
    display: grid;
    place-items: center;
    font-weight: 700;
    font-size: 14px;
    color: var(--muted);
  }
  .ticker {
    font-size: 33px;
    font-weight: 700;
    letter-spacing: -0.015em;
  }
  /* Prediction titles are sentences, not symbols — smaller, wrap normally. */
  .ticker.prediction {
    font-size: 19px;
    line-height: 1.3;
    letter-spacing: 0;
    padding-right: 90px; /* clear the floating % */
  }
  .price {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin-top: 8px;
    font-family: var(--mono);
  }
  .now { font-size: 16px; color: var(--ink); }
  .entry { font-size: 13px; color: var(--faint); }
  .tradetype {
    font-size: 11px;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 1px 6px;
    letter-spacing: 0.03em;
  }

  .quote {
    display: flex;
    gap: 12px;
    margin-top: 18px;
    padding: 15px 16px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 14px;
  }
  .avatar {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--surface);
    object-fit: cover;
  }
  .avatar-fallback {
    display: grid;
    place-items: center;
    font-weight: 700;
    color: var(--muted);
  }
  .quote-body { min-width: 0; }
  .quote-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
  }
  .name { font-weight: 700; }
  .handle, .dot, .time { color: var(--muted); font-size: 13px; }
  .text {
    margin-top: 5px;
    font-size: 15px;
    line-height: 1.45;
    color: #cfd4db;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 18px;
    flex-wrap: wrap;
  }
  .chip {
    font-size: 12px;
    color: var(--muted);
    background: var(--surface-2);
    border-radius: 999px;
    padding: 3px 10px;
  }
  .conviction-high { color: var(--green); }
  .conviction-low { color: var(--faint); }
  .src {
    margin-left: auto;
    font-size: 13px;
    color: var(--blue);
    text-decoration: none;
  }
  .src:hover { text-decoration: underline; }
</style>
