<script lang="ts">
  import { fetchIdea, type IdeaDetail } from "./api";
  import { fmtPrice, fmtPct, timeAgo, isBull } from "./format";

  let { id }: { id: string } = $props();

  let idea = $state<IdeaDetail | null>(null);
  let error = $state<string | null>(null);
  let avatarBroken = $state(false);
  let logoBroken = $state(false);

  $effect(() => {
    idea = null;
    error = null;
    fetchIdea(id)
      .then((d) => (idea = d))
      .catch((e) => (error = e instanceof Error ? e.message : String(e)));
  });

  function back() {
    if (history.length > 1) history.back();
    else location.hash = "";
  }

  const BASIS_LABEL: Record<string, string> = {
    quote: "from the author",
    market: "market fact",
    inference: "our inference",
  };
</script>

<div class="wrap">
  <button class="back" onclick={back}>← The Desk</button>

  {#if error}
    <p class="state err">Couldn't load this idea: {error}</p>
  {:else if !idea}
    <p class="state">Loading…</p>
  {:else}
    {@const bull = isBull(idea.direction)}
    {@const pctPos = (idea.sincePostedPct ?? 0) >= 0}

    <header class="head" style:--accent={bull ? "var(--green)" : "var(--red)"}>
      <div class="badges">
        <span class="venue">{idea.venueLabel}</span>
        <span class="dir" class:bull class:bear={!bull}>{idea.direction.toUpperCase()}</span>
        {#if idea.tradeType}<span class="chip">{idea.tradeType}</span>{/if}
        {#if idea.routeStatus === "unrouted"}<span class="chip warn">unrouted</span>{/if}
      </div>

      <div class="title-row">
        {#if idea.logoUrl && !logoBroken}
          <img class="logo" src={idea.logoUrl} alt="" onerror={() => (logoBroken = true)} />
        {:else}
          <span class="logo logo-fallback">{idea.ticker[0]}</span>
        {/if}
        <h1 class:prediction={idea.instrument === "prediction"}>{idea.ticker}</h1>
      </div>

      <div class="metrics">
        <div class="metric">
          <div class="m-val">{fmtPrice(idea.currentPrice)}</div>
          <div class="m-lab">CURRENT</div>
        </div>
        <div class="metric">
          <div class="m-val muted">{fmtPrice(idea.entryPrice)}</div>
          <div class="m-lab">ENTRY</div>
        </div>
        <div class="metric">
          <div class="m-val" class:up={pctPos} class:down={!pctPos}>{fmtPct(idea.sincePostedPct)}</div>
          <div class="m-lab">SINCE POSTED</div>
        </div>
      </div>
    </header>

    <section class="block">
      <h2>Thesis</h2>
      <p class="thesis">{idea.thesis}</p>
    </section>

    {#if idea.context}
      <section class="block">
        <h2>What it is</h2>
        <p class="context">{idea.context}</p>
      </section>
    {/if}

    {#if idea.pipeline}
      <section class="block">
        <h2>How we got here</h2>
        <p class="explain">{idea.pipeline.explanation}</p>
        <ol class="steps">
          {#each idea.pipeline.steps as step, i}
            <li>
              <span class="step-n">{i + 1}</span>
              <span class="step-text">{step.text}</span>
              <span class="basis basis-{step.basis}">{BASIS_LABEL[step.basis] ?? step.basis}</span>
            </li>
          {/each}
        </ol>
      </section>
    {/if}

    {#if idea.routeStatus === "unrouted" && idea.unroutedReason}
      <section class="block">
        <h2>Why unrouted</h2>
        <p class="context">{idea.unroutedReason}</p>
      </section>
    {/if}

    {#if idea.alternatives && idea.alternatives.length}
      <section class="block">
        <h2>Alternatives considered</h2>
        <ul class="alts">
          {#each idea.alternatives as alt}
            <li>
              <span class="alt-ticker">{alt.ticker}</span>
              <span class="alt-dir">{alt.direction}</span>
              <span class="alt-venue">{alt.venue}</span>
              {#if alt.note}<span class="alt-note">{alt.note}</span>{/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <section class="block">
      <h2>Evidence</h2>
      <ul class="quotes">
        {#each idea.quotes as q}<li>“{q}”</li>{/each}
      </ul>
    </section>

    <section class="block source">
      {#if idea.author.avatarUrl && !avatarBroken}
        <img class="avatar" src={idea.author.avatarUrl} alt="" onerror={() => (avatarBroken = true)} />
      {:else}
        <span class="avatar avatar-fallback">{idea.author.name[0]}</span>
      {/if}
      <div class="src-body">
        <div class="src-head">
          <span class="name">{idea.author.name}</span>
          <span class="handle">@{idea.author.handle}</span>
          <span class="dot">·</span>
          <span class="time">{timeAgo(idea.postedAt)} ago</span>
        </div>
        <p class="src-text">{idea.text}</p>
        {#if idea.sourceUrl}
          <a class="src-link" href={idea.sourceUrl} target="_blank" rel="noreferrer">view on X ↗</a>
        {/if}
      </div>
    </section>

    <footer class="prov">
      {#each idea.subjects as s}<span class="chip">{s.label} · {s.kind}</span>{/each}
      {#if idea.conviction}<span class="chip">{idea.conviction} conviction</span>{/if}
      {#if idea.horizon}<span class="chip">{idea.horizon}</span>{/if}
      <span class="chip faint">{idea.assetClass}</span>
      <span class="chip faint">{idea.extractorModel}</span>
    </footer>
  {/if}
</div>

<style>
  .wrap { padding: 18px 20px 60px; }
  .back {
    background: none;
    border: none;
    color: var(--muted);
    font: inherit;
    font-size: 14px;
    cursor: pointer;
    padding: 6px 0;
    margin-bottom: 12px;
  }
  .back:hover { color: var(--ink); }
  .state { padding: 60px 0; text-align: center; color: var(--muted); }
  .state.err { color: var(--red); }

  .head {
    border-bottom: 1px solid var(--line);
    padding-bottom: 20px;
    margin-bottom: 8px;
  }
  .badges { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .venue {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 4px 8px;
  }
  .dir { font-family: var(--mono); font-size: 13px; font-weight: 700; }
  .dir.bull { color: var(--green); }
  .dir.bear { color: var(--red); }

  .title-row { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
  .logo {
    width: 34px; height: 34px; border-radius: 50%;
    background: var(--surface-2); border: 1px solid var(--line); object-fit: cover;
  }
  .logo-fallback { display: grid; place-items: center; font-weight: 700; color: var(--muted); }
  h1 { font-size: 34px; font-weight: 800; letter-spacing: -0.02em; }
  h1.prediction { font-size: 22px; line-height: 1.25; letter-spacing: 0; }

  .metrics { display: flex; gap: 32px; margin-top: 20px; font-family: var(--mono); }
  .m-val { font-size: 22px; font-weight: 700; }
  .m-val.muted { color: var(--faint); }
  .m-val.up { color: var(--green); }
  .m-val.down { color: var(--red); }
  .m-lab { font-size: 10px; letter-spacing: 0.08em; color: var(--faint); margin-top: 5px; }

  .block { padding: 20px 0; border-bottom: 1px solid var(--line); }
  .block h2 {
    font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--faint); margin-bottom: 10px;
  }
  .thesis { font-size: 18px; line-height: 1.5; }
  .context, .explain { font-size: 15px; line-height: 1.55; color: #cfd4db; }
  .explain { margin-bottom: 14px; }

  .steps { list-style: none; display: flex; flex-direction: column; gap: 10px; }
  .steps li {
    display: grid;
    grid-template-columns: 24px 1fr auto;
    align-items: start;
    gap: 10px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px 14px;
  }
  .step-n {
    font-family: var(--mono); font-size: 12px; color: var(--faint);
    background: var(--surface-2); border-radius: 6px; text-align: center; padding: 2px 0;
  }
  .step-text { font-size: 14.5px; line-height: 1.45; }
  .basis {
    font-size: 10.5px; letter-spacing: 0.03em; white-space: nowrap;
    border-radius: 999px; padding: 3px 9px; height: fit-content;
  }
  .basis-quote { color: var(--green); background: rgba(47, 208, 122, 0.1); }
  .basis-market { color: var(--blue); background: rgba(74, 158, 255, 0.1); }
  .basis-inference { color: var(--muted); background: var(--surface-2); }

  .alts { list-style: none; display: flex; flex-direction: column; gap: 8px; }
  .alts li { display: flex; align-items: baseline; gap: 10px; font-size: 14px; }
  .alt-ticker { font-family: var(--mono); font-weight: 700; }
  .alt-dir { color: var(--muted); }
  .alt-venue { font-size: 11px; color: var(--faint); font-family: var(--mono); }
  .alt-note { color: var(--faint); font-size: 13px; }

  .quotes { list-style: none; display: flex; flex-direction: column; gap: 8px; }
  .quotes li {
    font-size: 15px; line-height: 1.5; color: #cfd4db;
    border-left: 2px solid var(--line); padding-left: 12px; font-style: italic;
  }

  .source { display: flex; gap: 12px; }
  .avatar {
    width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0;
    background: var(--surface-2); object-fit: cover;
  }
  .avatar-fallback { display: grid; place-items: center; font-weight: 700; color: var(--muted); }
  .src-head { display: flex; align-items: center; gap: 6px; font-size: 14px; }
  .name { font-weight: 700; }
  .handle, .dot, .time { color: var(--muted); font-size: 13px; }
  .src-text { margin-top: 6px; font-size: 15px; line-height: 1.5; color: #cfd4db; }
  .src-link { display: inline-block; margin-top: 8px; font-size: 13px; color: var(--blue); text-decoration: none; }
  .src-link:hover { text-decoration: underline; }

  .prov { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 18px; }
  .chip {
    font-size: 12px; color: var(--muted);
    background: var(--surface-2); border-radius: 999px; padding: 3px 10px;
  }
  .chip.warn { color: var(--red); }
  .chip.faint { color: var(--faint); }
</style>
