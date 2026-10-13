// Styles for the progress report. A JS string (not a .css file) because it
// is embedded in the exported HTML file, which must be self-contained. Every
// rule is scoped under .rpt so the in-app preview can't leak into the app.
// Light "paper" look, system fonts, prints cleanly on A4/Letter.
export const REPORT_CSS = `
.rpt {
  --ink: #1d2230; --ink-2: #4a5263; --ink-3: #7c8496; --line: #e3e6ee; --paper: #ffffff; --tint: #f5f7fb;
  --accent: #0f8a73; --money: #a5660a;
  --ok: #1c8a55; --warn: #a76a00; --bad: #c23b33; --info: #2f6fca; --idle: #6b7080;
  --cat-1: #2f6fca; --cat-2: #c4501f; --cat-3: #138a61; --cat-4: #a86f00;
  --cat-5: #b8406c; --cat-6: #1d7a1d; --cat-7: #6c5fd6; --cat-8: #c94848; --cat-other: #8a8f9c;
  --ch-bar: #0f8a73; --ch-grid: #eceef3; --ch-axis: #cfd4de; --ch-text: #7c8496;
  max-width: 900px; margin: 0 auto; padding: 40px 44px 28px;
  background: var(--paper); color: var(--ink);
  font: 13px/1.5 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.rpt * { box-sizing: border-box; }
.rpt h1, .rpt h2, .rpt p { margin: 0; }

/* header */
.rpt .rpt-head { display: flex; justify-content: space-between; gap: 24px; padding-bottom: 22px; border-bottom: 3px solid var(--accent); }
.rpt .rpt-title { display: flex; gap: 16px; align-items: flex-start; min-width: 0; }
.rpt .rpt-logo { width: 56px; height: 56px; border-radius: 12px; object-fit: cover; flex-shrink: 0; border: 1px solid var(--line); }
.rpt .rpt-logo-ph { display: flex; align-items: center; justify-content: center; background: var(--tint); color: var(--accent); font-size: 24px; font-weight: 700; }
.rpt .rpt-kicker { font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--accent); }
.rpt h1 { font-size: 28px; line-height: 1.15; font-weight: 700; letter-spacing: -.01em; margin-top: 2px; }
.rpt .rpt-desc { margin-top: 6px; color: var(--ink-2); max-width: 460px; }
.rpt .rpt-meta { margin: 0; display: grid; gap: 6px; min-width: 210px; font-size: 12px; }
.rpt .rpt-meta div { display: flex; justify-content: space-between; gap: 14px; }
.rpt .rpt-meta dt { color: var(--ink-3); }
.rpt .rpt-meta dd { margin: 0; font-weight: 600; text-align: right; }

/* sections */
.rpt .rpt-section { margin-top: 26px; break-inside: avoid; }
.rpt .rpt-section > h2 { font-size: 12px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
.rpt .rpt-two { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.rpt .rpt-muted, .rpt .empty-note, .rpt .ch-empty { color: var(--ink-3); font-size: 12.5px; }
.rpt .ch-empty { padding: 26px 0; text-align: center; background: var(--tint); border-radius: 10px; }

/* summary */
.rpt .rpt-summary { display: flex; gap: 22px; align-items: center; }
.rpt .rpt-lead { font-size: 15px; line-height: 1.55; color: var(--ink); }
.rpt .notes { margin: 10px 0 0; padding: 0; list-style: none; display: grid; gap: 5px; }
.rpt .notes li { position: relative; padding-left: 18px; color: var(--ink-2); font-size: 12.5px; }
.rpt .notes li::before { content: ""; position: absolute; left: 2px; top: .55em; width: 8px; height: 8px; border-radius: 50%; background: var(--ok); }
.rpt .notes li.tone-warn::before { background: var(--warn); }
.rpt .notes li.tone-bad::before { background: var(--bad); }

/* pills */
.rpt .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; white-space: nowrap; background: #eef0f4; color: var(--idle); }
.rpt .pill.tone-ok { background: #e3f4ea; color: var(--ok); }
.rpt .pill.tone-warn { background: #fbefd8; color: var(--warn); }
.rpt .pill.tone-bad { background: #fbe4e2; color: var(--bad); }
.rpt .pill.tone-info { background: #e4edfb; color: var(--info); }

/* kpis */
.rpt .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.rpt .kpi { border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; background: var(--paper); border-top: 3px solid var(--accent); }
.rpt .kpi.tone-bad { border-top-color: var(--bad); }
.rpt .kpi.tone-warn { border-top-color: var(--warn); }
.rpt .kpi.tone-money { border-top-color: var(--money); }
.rpt .kpi-label { font-size: 11px; color: var(--ink-3); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
.rpt .kpi-value { font-size: 21px; font-weight: 700; margin-top: 2px; }
.rpt .kpi.tone-bad .kpi-value { color: var(--bad); }
.rpt .kpi.tone-warn .kpi-value { color: var(--warn); }
.rpt .kpi.tone-money .kpi-value { color: var(--money); }
.rpt .kpi-sub { font-size: 11.5px; color: var(--ink-3); }

/* progress bars */
.rpt .pbars { display: grid; gap: 14px; }
.rpt .pbar-top { display: flex; justify-content: space-between; font-size: 12.5px; font-weight: 600; }
.rpt .pbar-track { position: relative; height: 12px; border-radius: 6px; background: #eceef3; margin-top: 5px; }
.rpt .pbar-fill { height: 100%; border-radius: 6px; background: var(--accent); }
.rpt .pbar-fill.tone-info { background: var(--info); }
.rpt .pbar-fill.tone-money { background: var(--money); }
.rpt .pbar-fill.tone-warn { background: var(--warn); }
.rpt .pbar-fill.tone-bad { background: var(--bad); }
.rpt .pbar-marker { position: absolute; top: -4px; bottom: -4px; width: 3px; margin-left: -1.5px; border-radius: 2px; background: var(--ink); }
.rpt .pbar-detail { margin-top: 4px; font-size: 11.5px; color: var(--ink-3); }
.rpt .pbar-key { display: inline-block; width: 3px; height: 10px; border-radius: 2px; background: var(--ink); vertical-align: -1px; margin-left: 4px; }

/* table */
.rpt .table-wrap { overflow: visible; }
.rpt .ptable { width: 100%; border-collapse: collapse; font-size: 12px; }
.rpt .ptable th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-3); font-weight: 700; padding: 6px 8px; border-bottom: 2px solid var(--line); }
.rpt .ptable td { padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
.rpt .ptable tfoot td { font-weight: 700; border-bottom: none; border-top: 2px solid var(--line); }
.rpt .ptable .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.rpt .ptable .nowrap { white-space: nowrap; }
.rpt .ptable .over { color: var(--bad); font-weight: 700; }
.rpt .muted-row td { color: var(--ink-3); }
.rpt .dot { display: inline-block; width: 9px; height: 9px; border-radius: 3px; margin-right: 7px; vertical-align: 0; }
.rpt .dot.ms { transform: rotate(45deg) scale(.9); border-radius: 1px; }
.rpt .mini { display: inline-block; width: 48px; height: 6px; border-radius: 3px; background: #eceef3; margin-right: 7px; vertical-align: 1px; overflow: hidden; }
.rpt .mini span { display: block; height: 100%; }

/* charts (shared ch-* classes) */
.rpt .ch { display: block; width: 100%; height: auto; }
.rpt .ch text { font-family: inherit; }
.rpt .ch-grid { stroke: var(--ch-grid); stroke-width: 1; }
.rpt .ch-axis { stroke: var(--ch-axis); stroke-width: 1; }
.rpt .ch-label { fill: var(--ch-text); font-size: 10px; }
.rpt .ch-label.strong { fill: var(--ink); font-weight: 700; }
.rpt .ch-value { fill: var(--ink-2); font-size: 9.5px; font-weight: 600; }
.rpt .ch-row-label { fill: var(--ink); font-size: 11px; }
.rpt .ch-zebra { fill: #f7f8fb; }
.rpt .ch-bar { fill: var(--ch-bar); opacity: .78; }
.rpt .ch-bar.cur { opacity: 1; }
.rpt .ch-actual { fill: none; stroke: var(--accent); stroke-width: 2.5; stroke-linejoin: round; }
.rpt .ch-area { fill: var(--accent); opacity: .1; }
.rpt .ch-dot { fill: var(--accent); stroke: #fff; stroke-width: 2; }
.rpt .ch-plan { fill: none; stroke: var(--info); stroke-width: 1.8; stroke-dasharray: 5 4; }
.rpt .ch-budget { stroke: var(--money); stroke-width: 1.5; stroke-dasharray: 2 3; }
.rpt .ch-budget-label { fill: var(--money); font-weight: 700; }
.rpt .ch-today { stroke: var(--ink); stroke-width: 1.5; }
.rpt .ch-today-label { fill: var(--ink); font-weight: 700; }
.rpt .ch-due { stroke: var(--bad); stroke-width: 1.5; stroke-dasharray: 4 3; }
.rpt .ch-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11px; color: var(--ink-3); margin: 0 0 6px; }
.rpt .ch-legend span { display: inline-flex; align-items: center; gap: 6px; }
.rpt .ch-legend i { display: inline-block; width: 16px; height: 0; border-top: 2.5px solid var(--accent); }
.rpt .ch-legend i.lg-plan { border-top: 2px dashed var(--info); }
.rpt .ch-legend i.lg-budget { border-top: 2px dotted var(--money); }
.rpt .ch-legend i.lg-today { border-top: 2px solid var(--ink); width: 2px; height: 11px; border-top: none; background: var(--ink); }
.rpt .ch-legend i.lg-due { width: 2px; height: 11px; border-top: none; border-left: 2px dashed var(--bad); }
.rpt .ch-legend i.lg-progress { height: 9px; border: none; border-radius: 2px; background: var(--cat-1); }
.rpt .ch-legend i.lg-remaining { height: 9px; border: none; border-radius: 2px; background: var(--cat-1); opacity: .25; }
.rpt .ch-donut { flex-shrink: 0; }
.rpt .ch-donut-track { fill: none; stroke: #eceef3; stroke-width: 10; }
.rpt .ch-donut-fill { fill: none; stroke: var(--accent); stroke-width: 10; stroke-linecap: round; }
.rpt .ch-donut-value { fill: var(--ink); font-size: 21px; font-weight: 700; }
.rpt .ch-donut-caption { fill: var(--ink-3); font-size: 9px; text-transform: uppercase; letter-spacing: .08em; }

/* forecast / billing stats */
.rpt .rpt-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.rpt .rpt-stat { background: var(--paper); padding: 11px 14px; }
.rpt .rpt-stat:last-child:nth-child(3n + 2) { grid-column: span 2; }
.rpt .rpt-stat:last-child:nth-child(3n + 1) { grid-column: span 3; }
.rpt .rpt-stat-label { font-size: 11px; color: var(--ink-3); font-weight: 600; }
.rpt .rpt-stat-value { font-size: 17px; font-weight: 700; margin-top: 1px; }
.rpt .rpt-stat-sub { font-size: 11px; color: var(--ink-3); }

/* upcoming */
.rpt .rpt-upcoming { list-style: none; margin: 0; padding: 0; }
.rpt .rpt-upcoming li { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--line); }
.rpt .rpt-up-date { width: 74px; font-weight: 700; font-size: 12.5px; display: flex; flex-direction: column; line-height: 1.2; }
.rpt .rpt-up-date small { font-weight: 400; color: var(--ink-3); font-size: 10.5px; }
.rpt .rpt-up-name { flex: 1; color: var(--ink-2); }
.rpt .rpt-up-name b { color: var(--ink); }

.rpt .rpt-notes p { margin: 0 0 8px; color: var(--ink-2); line-height: 1.6; }
.rpt .rpt-foot { margin-top: 32px; padding-top: 12px; border-top: 1px solid var(--line); display: flex; justify-content: space-between; gap: 12px; font-size: 10.5px; color: var(--ink-3); }

@media (max-width: 720px) {
  .rpt { padding: 24px 18px; }
  .rpt .rpt-head, .rpt .rpt-summary { flex-direction: column; align-items: flex-start; }
  .rpt .kpis, .rpt .rpt-stats { grid-template-columns: 1fr 1fr; }
  .rpt .rpt-two { grid-template-columns: 1fr; }
}

/* standalone file */
body.rpt-page { margin: 0; background: #eef0f4; padding: 24px 0; }
body.rpt-page .rpt { box-shadow: 0 2px 24px rgba(20, 30, 50, .08); border-radius: 6px; }
@page { margin: 14mm 12mm; }
@media print {
  body.rpt-page { background: #fff; padding: 0; }
  body.rpt-page .rpt { box-shadow: none; border-radius: 0; padding: 0; max-width: none; }
}
`;
