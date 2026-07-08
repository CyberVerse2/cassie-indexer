<script lang="ts">
  import { fetchIdeas, fetchStatus, type FeedCard, type Status } from "./lib/api";
  import { timeAgo } from "./lib/format";
  import TradeCard from "./lib/TradeCard.svelte";
  import IdeaDetail from "./lib/IdeaDetail.svelte";

  // Minimal hash router: #/i/<id> → detail, anything else → feed. Shareable,
  // back-button works, no router dependency.
  function parseHash(): { name: "feed" } | { name: "detail"; id: string } {
    const m = location.hash.match(/^#\/i\/(.+)$/);
    return m ? { name: "detail", id: decodeURIComponent(m[1]) } : { name: "feed" };
  }
  let route = $state(parseHash());
  $effect(() => {
    const on = () => (route = parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  });

  const TABS = ["all", "perps", "stocks", "tokens", "markets"];
  const TAB_LABEL: Record<string, string> = {
    all: "All",
    perps: "Perps",
    stocks: "Stocks",
    tokens: "Tokens",
    markets: "Markets",
  };

  let tab = $state("all");
  let cards = $state<FeedCard[]>([]);
  let status = $state<Status | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load(which: string) {
    loading = true;
    error = null;
    try {
      cards = await fetchIdeas(which);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    load(tab);
  });

  $effect(() => {
    fetchStatus().then((s) => (status = s)).catch(() => {});
    const id = setInterval(() => fetchStatus().then((s) => (status = s)).catch(() => {}), 60_000);
    return () => clearInterval(id);
  });
</script>

{#if route.name === "detail"}
  <IdeaDetail id={route.id} />
{:else}
<header class="masthead">
  <div class="brand">
    <h1>The Desk</h1>
    <div class="live">
      <span class="dot"></span>
      <span>live</span>
      {#if status?.lastFetchAt}
        <span class="ago">· {timeAgo(status.lastFetchAt)} ago</span>
      {/if}
    </div>
  </div>
  <nav class="tabs">
    {#each TABS as t}
      <button class="tab" class:active={tab === t} onclick={() => (tab = t)}>
        {TAB_LABEL[t]}
      </button>
    {/each}
  </nav>
</header>

<main>
  {#if loading}
    <p class="state">Loading the desk…</p>
  {:else if error}
    <p class="state err">Couldn't reach the API: {error}</p>
  {:else if cards.length === 0}
    <p class="state">No ideas in this bucket yet.</p>
  {:else}
    {#each cards as card (card.id)}
      <TradeCard {card} />
    {/each}
  {/if}
</main>
{/if}

<style>
  .masthead {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--bg);
    padding: 20px 18px 0;
    border-bottom: 1px solid var(--line);
  }
  .brand {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h1 { font-size: 22px; font-weight: 800; letter-spacing: -0.01em; }
  .live {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    color: var(--muted);
  }
  .live .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 8px var(--green);
  }
  .ago { color: var(--faint); }

  .tabs { display: flex; gap: 6px; margin-top: 16px; }
  .tab {
    background: transparent;
    border: none;
    color: var(--muted);
    font-family: var(--sans);
    font-size: 15px;
    font-weight: 600;
    padding: 8px 14px;
    border-radius: 9px;
    cursor: pointer;
    margin-bottom: 6px;
  }
  .tab.active { background: var(--surface-2); color: var(--ink); }
  .tab:hover:not(.active) { color: var(--ink); }

  .state {
    padding: 60px 18px;
    text-align: center;
    color: var(--muted);
  }
  .state.err { color: var(--red); }
</style>
