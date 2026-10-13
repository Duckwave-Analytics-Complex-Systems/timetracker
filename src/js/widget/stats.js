// The Today strip (Projects tab) and the Stats tab.
import { niceScale } from '../core/charts.js';
import { addDays, dayKey, escapeHtml, fmtDate, fmtHM, money, startOfToday } from '../core/format.js';
import { bill, liveAdditions } from '../core/model.js';
import { colorVar, slotOf } from './colors.js';
import { state } from './store.js';

const RANGE_STORAGE_KEY = 'timetrack:stats-range';
const GAP = 2; // px of surface between stacked segments
const RANGES = {
  '7d': { n: 7, span: 1, label: 'last 7 days', title: 'Hours per day' },
  '30d': { n: 30, span: 1, label: 'last 30 days', title: 'Hours per day' },
  '12w': { n: 12, span: 7, label: 'last 12 weeks', title: 'Hours per week' },
};

const $ = (id) => document.getElementById(id);
const chartHost = $('chartHost');
const chartWrap = $('chartWrap');
const tipEl = $('chartTip');
const rangeSeg = $('rangeSeg');

let statsRange = localStorage.getItem(RANGE_STORAGE_KEY);
if (!RANGES[statsRange]) statsRange = '7d';
let selectedKey = null; // selected chart column (null = the newest one)
let currentBuckets = [];

/** True while the pointer is over the chart: redraws would drop the tooltip. */
export let chartHover = false;
export function resetChartHover() { chartHover = false; }
export function resetSelection() { selectedKey = null; }

// ---------------------------------------------------------------- data assembly

function dayMap() {
  const map = new Map(); // day -> Map(project_id -> seconds)
  const add = (day, pid, s) => {
    if (!(s > 0)) return;
    let m = map.get(day);
    if (!m) { m = new Map(); map.set(day, m); }
    m.set(pid, (m.get(pid) || 0) + s);
  };
  for (const r of state.dailyRows) add(r.day, r.project_id, r.seconds);
  for (const [d, pid, s] of liveAdditions(state.projects)) add(d, pid, s);
  return map;
}

/** Per-project entries sorted by time desc (each with its project record). */
function rowsFor(per) {
  const rows = [];
  for (const [pid, secs] of per) {
    const p = state.projects.find((x) => x.id === pid);
    if (p && secs > 0) rows.push({ pid, p, secs });
  }
  return rows.sort((a, b) => b.secs - a.secs);
}

/** Chart segments in fixed slot order; projects without a slot fold into "Other". */
function segmentsFor(per) {
  const known = [];
  const other = { pid: 'other', name: 'Other', secs: 0, color: 'var(--cat-other)', slot: 99 };
  for (const { pid, p, secs } of rowsFor(per)) {
    const slot = slotOf(pid);
    if (slot == null) other.secs += secs;
    else known.push({ pid, name: p.name, secs, color: `var(--cat-${slot + 1})`, slot });
  }
  known.sort((a, b) => a.slot - b.slot);
  if (other.secs > 0) known.push(other);
  return known;
}

// ---------------------------------------------------------------- Today strip

export function renderToday() {
  const per = dayMap().get(dayKey(new Date())) || new Map();
  const rows = rowsFor(per);
  $('todayTotal').textContent = fmtHM(rows.reduce((a, r) => a + r.secs, 0));

  const segs = segmentsFor(per);
  $('todayBar').innerHTML = segs.length
    ? segs.map((g) => `<span class="today-seg" style="flex:${g.secs};background:${g.color}" title="${escapeHtml(g.name)} · ${fmtHM(g.secs)}"></span>`).join('')
    : '<span class="today-seg empty" style="flex:1"></span>';

  const legend = $('todayLegend');
  if (!rows.length) {
    legend.innerHTML = '<span>Nothing tracked yet today</span>';
    return;
  }
  const chip = (r) => `<span class="chip"><i style="background:${colorVar(r.pid)}"></i><span class="chip-name">${escapeHtml(r.p.name)}</span><span class="chip-time">${fmtHM(r.secs)}</span></span>`;
  const more = rows.length > 4 ? `<span class="chip"><span class="chip-time">+${rows.length - 4} more</span></span>` : '';
  legend.innerHTML = rows.slice(0, 4).map(chip).join('') + more;
}

// ---------------------------------------------------------------- Stats

function buildBuckets(map, cfg) {
  const t0 = startOfToday();
  const buckets = [];
  for (let i = 0; i < cfg.n; i++) {
    const end = addDays(t0, -(cfg.n - 1 - i) * cfg.span);
    const start = addDays(end, -(cfg.span - 1));
    const per = new Map();
    let total = 0;
    for (let k = 0; k < cfg.span; k++) {
      const m = map.get(dayKey(addDays(start, k)));
      if (!m) continue;
      for (const [pid, s] of m) { per.set(pid, (per.get(pid) || 0) + s); total += s; }
    }
    buckets.push({ key: dayKey(start), start, end, span: cfg.span, per, total });
  }
  return buckets;
}

function computeStats(map, cfg) {
  const first = addDays(startOfToday(), -(cfg.n * cfg.span - 1));
  const perProject = new Map();
  let total = 0, active = 0, best = { secs: 0, day: null };
  for (let i = 0; i < cfg.n * cfg.span; i++) {
    const d = addDays(first, i);
    const m = map.get(dayKey(d));
    if (!m) continue;
    let dayTotal = 0;
    for (const [pid, s] of m) { dayTotal += s; perProject.set(pid, (perProject.get(pid) || 0) + s); }
    if (dayTotal > 0) {
      active++; total += dayTotal;
      if (dayTotal > best.secs) best = { secs: dayTotal, day: d };
    }
  }
  let billed = 0, anyRate = false;
  for (const { p, secs } of rowsFor(perProject)) {
    if (p.hourly_rate > 0) { billed += bill(p, secs); anyRate = true; }
  }
  return { total, active, best, perProject, billed, anyRate };
}

function bucketTitle(b, forDetail) {
  if (b.span === 1) {
    const today = startOfToday();
    if (forDetail && b.key === dayKey(today)) return 'Today';
    if (forDetail && b.key === dayKey(addDays(today, -1))) return 'Yesterday';
    return fmtDate(b.start, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  const o = { month: 'short', day: 'numeric' };
  return `${fmtDate(b.start, o)} – ${fmtDate(b.end, o)}`;
}

function chartSvg(buckets, cfg) {
  const W = 340, H = 176, L = 30, R = 6, T = 16, B = 22;
  const plotW = W - L - R, plotH = H - T - B;
  const maxH = Math.max(0, ...buckets.map((b) => b.total)) / 3600;
  if (maxH === 0) return '<div class="chart-empty">No time tracked in this period yet.</div>';

  const { step, top } = niceScale(maxH);
  const yOf = (h) => T + plotH - (h / top) * plotH;
  const n = buckets.length;
  const slot = plotW / n;
  const bw = Math.min(24, Math.max(4, slot * 0.68));
  const nTicks = Math.round(top / step);
  const n1 = (v) => Math.round(v * 100) / 100;

  let s = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(cfg.title)}, ${cfg.label}">`;
  for (let k = 0; k <= nTicks; k++) {
    const v = k * step, y = yOf(v);
    s += `<line class="${k === 0 ? 'axis' : 'grid'}" x1="${L}" x2="${W - R}" y1="${n1(y)}" y2="${n1(y)}"/>`;
    s += `<text x="${L - 5}" y="${n1(y + 3)}" text-anchor="end">${v}h</text>`;
  }

  buckets.forEach((b, i) => {
    const cx = L + slot * (i + 0.5);
    const x = cx - bw / 2;
    const sel = b.key === selectedKey;
    if (sel) s += `<rect class="sel-plate" x="${n1(cx - slot / 2)}" y="${T - 4}" width="${n1(slot)}" height="${plotH + 4}" rx="6"/>`;

    const segs = segmentsFor(b.per);
    let yBase = yOf(0);
    segs.forEach((g, k) => {
      const h = Math.max(1.5, (g.secs / 3600 / top) * plotH);
      const yTop = yBase - h;
      const visH = k === 0 ? h : Math.max(1, h - GAP); // surface gap under every non-bottom segment
      if (k === segs.length - 1) {
        const r = Math.min(4, bw / 2, visH); // rounded data-end, square at the baseline
        s += `<path style="fill:${g.color}" d="M${n1(x)},${n1(yTop + visH)} V${n1(yTop + r)} Q${n1(x)},${n1(yTop)} ${n1(x + r)},${n1(yTop)} H${n1(x + bw - r)} Q${n1(x + bw)},${n1(yTop)} ${n1(x + bw)},${n1(yTop + r)} V${n1(yTop + visH)} Z"/>`;
      } else {
        s += `<rect style="fill:${g.color}" x="${n1(x)}" y="${n1(yTop)}" width="${n1(bw)}" height="${n1(visH)}"/>`;
      }
      yBase = yTop;
    });

    if (sel && b.total > 0) {
      const lx = Math.max(L + 22, Math.min(cx, W - R - 22));
      s += `<text class="cap-label" x="${n1(lx)}" y="${n1(yBase - 4)}" text-anchor="middle">${fmtHM(b.total)}</text>`;
    }

    const labelled = cfg.span === 7 ? (n - 1 - i) % 3 === 0 : cfg.n === 30 ? (n - 1 - i) % 7 === 0 : true;
    if (labelled) {
      const txt = cfg.span === 7 || cfg.n === 30 ? fmtDate(b.start, { month: 'short', day: 'numeric' })
        : i === n - 1 ? 'Today' : fmtDate(b.start, { weekday: 'short' });
      s += `<text class="xtick${sel ? ' sel' : ''}" x="${n1(cx)}" y="${H - 6}" text-anchor="middle">${escapeHtml(txt)}</text>`;
    }
  });

  // Hit targets last so they sit on top; wider than the bars themselves.
  buckets.forEach((b, i) => {
    const cx = L + slot * (i + 0.5);
    s += `<rect class="hit" data-i="${i}" tabindex="0" role="button" aria-label="${escapeHtml(bucketTitle(b))}: ${fmtHM(b.total)}" x="${n1(cx - slot / 2)}" y="${T - 4}" width="${n1(slot)}" height="${plotH + B + 4}"/>`;
  });
  return s + '</svg>';
}

function meterRows(host, rows, emptyMsg) {
  if (!rows.length) { host.innerHTML = `<div class="meter-empty">${emptyMsg}</div>`; return; }
  const max = rows[0].secs;
  host.innerHTML = rows.map((r) => {
    const billTxt = r.p.hourly_rate > 0 ? ` · <span class="bill">${money(bill(r.p, r.secs))}</span>` : '';
    return `<div class="meter"><div class="meter-top"><i style="background:${colorVar(r.pid)}"></i><span class="meter-name">${escapeHtml(r.p.name)}</span><span class="meter-val">${fmtHM(r.secs)}${billTxt}</span></div><div class="meter-track"><div class="meter-fill" style="width:${((r.secs / max) * 100).toFixed(1)}%;background:${colorVar(r.pid)}"></div></div></div>`;
  }).join('');
}

export function renderStats() {
  const cfg = RANGES[statsRange];
  const map = dayMap();
  const buckets = buildBuckets(map, cfg);
  currentBuckets = buckets;
  if (!buckets.some((b) => b.key === selectedKey)) selectedKey = buckets[buckets.length - 1].key;
  const sel = buckets.find((b) => b.key === selectedKey);
  const st = computeStats(map, cfg);

  rangeSeg.querySelectorAll('button').forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.range === statsRange)));

  $('tileTotal').textContent = fmtHM(st.total);
  $('tileTotalSub').textContent = cfg.label;
  $('tileAvg').textContent = st.active ? fmtHM(st.total / st.active) : '—';
  $('tileAvgSub').textContent = st.active ? `${st.active} active day${st.active === 1 ? '' : 's'}` : 'no activity';
  $('tileBest').textContent = st.best.day ? fmtHM(st.best.secs) : '—';
  $('tileBestSub').textContent = st.best.day ? fmtDate(st.best.day, { weekday: 'short', month: 'short', day: 'numeric' }) : '';
  $('tileBill').textContent = st.anyRate ? money(st.billed) : '—';
  $('tileBillSub').textContent = st.anyRate ? 'at current rates' : 'no hourly rates set';

  // chart + legend (a legend only when there are 2+ series)
  $('chartTitle').textContent = cfg.title;
  const legendSegs = segmentsFor(st.perProject);
  $('chartLegend').innerHTML = legendSegs.length > 1
    ? legendSegs.map((g) => `<span class="chip"><i style="background:${g.color}"></i><span class="chip-name">${escapeHtml(g.name)}</span></span>`).join('')
    : '';
  chartHost.innerHTML = chartSvg(buckets, cfg);
  tipEl.classList.add('hidden');

  $('dayTitle').textContent = bucketTitle(sel, true);
  $('dayTotal').textContent = sel.total > 0 ? fmtHM(sel.total) : '';
  meterRows($('dayRows'), rowsFor(sel.per), 'No time tracked in this period.');

  $('projTotal').textContent = st.total > 0 ? fmtHM(st.total) : '';
  meterRows($('projRows'), rowsFor(st.perProject), `No time tracked in the ${cfg.label}.`);

  // screen-reader table view
  $('statsTable').innerHTML =
    `<caption>${escapeHtml(cfg.title)}, ${cfg.label}</caption><thead><tr><th>Period</th><th>Total</th><th>By project</th></tr></thead><tbody>` +
    buckets.map((b) => `<tr><td>${escapeHtml(bucketTitle(b))}</td><td>${fmtHM(b.total)}</td><td>${rowsFor(b.per).map((r) => `${escapeHtml(r.p.name)} ${fmtHM(r.secs)}`).join(', ')}</td></tr>`).join('') +
    '</tbody>';
}

// ---------------------------------------------------------------- chart interaction

function showTip(i, hit) {
  const b = currentBuckets[i];
  if (!b) return;
  const rows = rowsFor(b.per);
  tipEl.innerHTML =
    `<div class="tip-title">${escapeHtml(bucketTitle(b))}</div>` +
    `<div class="tip-total">${b.total > 0 ? fmtHM(b.total) : 'No time tracked'}</div>` +
    rows.slice(0, 5).map((r) => `<div class="tip-row"><i style="background:${colorVar(r.pid)}"></i><span class="n">${escapeHtml(r.p.name)}</span><span class="t">${fmtHM(r.secs)}</span></div>`).join('') +
    (rows.length > 5 ? `<div class="tip-row"><span class="n">+${rows.length - 5} more</span></div>` : '');
  tipEl.classList.remove('hidden');
  const wr = chartWrap.getBoundingClientRect();
  const hr = hit.getBoundingClientRect();
  const tw = tipEl.offsetWidth;
  let left = hr.left - wr.left + hr.width + 6;
  if (left + tw > wr.width) left = hr.left - wr.left - tw - 6;
  tipEl.style.left = `${Math.max(0, Math.min(left, wr.width - tw))}px`;
}
const hideTip = () => tipEl.classList.add('hidden');
const hitOf = (e) => e.target.closest && e.target.closest('.hit');

function selectBucket(i) {
  const b = currentBuckets[i];
  if (!b) return;
  selectedKey = b.key;
  renderStats();
}

chartHost.addEventListener('pointerenter', () => { chartHover = true; });
chartHost.addEventListener('pointerleave', () => { chartHover = false; hideTip(); });
chartHost.addEventListener('pointermove', (e) => {
  const hit = hitOf(e);
  if (hit) showTip(Number(hit.dataset.i), hit); else hideTip();
});
chartHost.addEventListener('click', (e) => {
  const hit = hitOf(e);
  if (hit) selectBucket(Number(hit.dataset.i));
});
chartHost.addEventListener('keydown', (e) => {
  const hit = hitOf(e);
  if (hit && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectBucket(Number(hit.dataset.i)); }
});
chartHost.addEventListener('focusin', (e) => {
  const hit = hitOf(e);
  if (hit) showTip(Number(hit.dataset.i), hit);
});
chartHost.addEventListener('focusout', hideTip);

rangeSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if (!btn) return;
  statsRange = btn.dataset.range;
  try { localStorage.setItem(RANGE_STORAGE_KEY, statsRange); } catch { /* ignore */ }
  selectedKey = null;
  renderStats();
});
