// SVG chart builders that return markup strings. Colors come from CSS
// classes (`ch-*`) and custom properties (--cat-N, --ch-*), so the same chart
// renders dark in the app (css/project.css) and light in the printable
// report (js/project/report-style.js).
import { addDays, daysBetween, escapeHtml, fmtDate } from './format.js';

const r2 = (v) => Math.round(v * 100) / 100;

/** A round axis maximum with at most `maxTicks` gridlines. */
export function niceScale(maxV, maxTicks = 4) {
  const steps = [0.25, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 20, 24, 40, 50, 100, 150, 200, 250, 400, 500, 1000, 2000, 5000];
  const want = Math.max(maxV, 0.25);
  const step = steps.find((s) => Math.ceil(want / s) <= maxTicks) || Math.ceil(want / maxTicks);
  return { step, top: Math.ceil(want / step) * step };
}

function yAxis(s, { L, R, W, T, plotH, step, top }) {
  const yOf = (v) => T + plotH - (v / top) * plotH;
  for (let k = 0; k <= Math.round(top / step); k++) {
    const v = k * step, y = r2(yOf(v));
    s.push(`<line class="${k === 0 ? 'ch-axis' : 'ch-grid'}" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/>`);
    s.push(`<text class="ch-label" x="${L - 6}" y="${r2(y + 3)}" text-anchor="end">${v}h</text>`);
  }
  return yOf;
}

/** Bar chart of hours per week. weeks: [{ start: Date, hours }] */
export function weeklyBarsSvg(weeks, { W = 560, H = 190 } = {}) {
  const L = 36, R = 8, T = 14, B = 24;
  const plotW = W - L - R, plotH = H - T - B;
  const maxH = Math.max(0, ...weeks.map((w) => w.hours));
  if (maxH === 0) return '<div class="ch-empty">No hours tracked in this period yet.</div>';

  const { step, top } = niceScale(maxH);
  const s = [`<svg class="ch" viewBox="0 0 ${W} ${H}" role="img" aria-label="Hours per week">`];
  const yOf = yAxis(s, { L, R, W, T, plotH, step, top });
  const n = weeks.length;
  const slot = plotW / n;
  const bw = Math.min(26, Math.max(4, slot * 0.62));
  const every = Math.ceil(n / 8);

  weeks.forEach((w, i) => {
    const cx = L + slot * (i + 0.5);
    const cur = i === n - 1;
    if (w.hours > 0) {
      const y = yOf(w.hours);
      const h = Math.max(1.5, T + plotH - y);
      s.push(`<rect class="ch-bar${cur ? ' cur' : ''}" x="${r2(cx - bw / 2)}" y="${r2(T + plotH - h)}" width="${r2(bw)}" height="${r2(h)}" rx="3"><title>Week of ${escapeHtml(fmtDate(w.start, { month: 'short', day: 'numeric' }))}: ${w.hours.toFixed(1)} h</title></rect>`);
      if (n <= 14) s.push(`<text class="ch-value" x="${r2(cx)}" y="${r2(T + plotH - h - 4)}" text-anchor="middle">${w.hours.toFixed(w.hours < 10 ? 1 : 0)}</text>`);
    }
    if ((n - 1 - i) % every === 0) {
      s.push(`<text class="ch-label${cur ? ' strong' : ''}" x="${r2(cx)}" y="${H - 7}" text-anchor="middle">${escapeHtml(cur ? 'This wk' : fmtDate(w.start, { month: 'short', day: 'numeric' }))}</text>`);
    }
  });
  return s.join('') + '</svg>';
}

/** Cumulative hours: actual vs plan vs budget (see `burnupSeries` in metrics.js). */
export function burnupSvg(series, { W = 560, H = 220 } = {}) {
  const L = 40, R = 14, T = 16, B = 24;
  const plotW = W - L - R, plotH = H - T - B;
  const { start, days, actual, planned, budgetH, base = 0, todayIndex, dueIndex } = series;
  const lastActual = actual.length ? actual[actual.length - 1].value : 0;
  const maxV = Math.max(lastActual, budgetH || 0, ...(planned || []).map((p) => p.value));
  if (maxV === 0) return '<div class="ch-empty">Track time or set a budget to see the burn-up chart.</div>';

  const { step, top } = niceScale(maxV * 1.08, 5);
  const s = [`<svg class="ch" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative hours versus plan">`];
  const yOf = yAxis(s, { L, R, W, T, plotH, step, top });
  const xOf = (i) => L + (Math.max(0, Math.min(days, i)) / days) * plotW;

  // x ticks: about six dates across the range
  const tickStep = [1, 2, 7, 14, 30, 61, 91, 182, 365].find((d) => days / d <= 6) || 365;
  for (let i = 0; i <= days; i += tickStep) {
    s.push(`<text class="ch-label" x="${r2(xOf(i))}" y="${H - 7}" text-anchor="middle">${escapeHtml(fmtDate(addDays(start, i), { month: 'short', day: 'numeric' }))}</text>`);
  }

  if (budgetH) {
    const y = r2(yOf(budgetH));
    s.push(`<line class="ch-budget" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/>`);
    s.push(`<text class="ch-label ch-budget-label" x="${L + 4}" y="${r2(y - 4)}">Budget ${Math.round(budgetH)} h</text>`);
  }
  if (dueIndex != null && dueIndex >= 0 && dueIndex < days) {
    const x = r2(xOf(dueIndex + 1));
    s.push(`<line class="ch-due" x1="${x}" x2="${x}" y1="${T}" y2="${T + plotH}"/>`);
  }
  if (planned?.length) {
    const pts = [`${xOf(0)},${yOf(0)}`, ...planned.map((p) => `${r2(xOf(p.i + 1))},${r2(yOf(p.value))}`)];
    s.push(`<polyline class="ch-plan" points="${pts.join(' ')}"/>`);
  }
  if (actual.length) {
    const pts = [`${xOf(0)},${r2(yOf(base))}`, ...actual.map((p) => `${r2(xOf(p.i + 1))},${r2(yOf(p.value))}`)];
    const lastX = r2(xOf(actual[actual.length - 1].i + 1));
    s.push(`<path class="ch-area" d="M${xOf(0)},${yOf(0)} L${pts.join(' L')} L${lastX},${yOf(0)} Z"/>`);
    s.push(`<polyline class="ch-actual" points="${pts.join(' ')}"/>`);
    s.push(`<circle class="ch-dot" cx="${lastX}" cy="${r2(yOf(lastActual))}" r="3.5"/>`);
  }
  if (todayIndex >= 0 && todayIndex < days) {
    const x = r2(xOf(todayIndex + 1));
    s.push(`<line class="ch-today" x1="${x}" x2="${x}" y1="${T - 4}" y2="${T + plotH}"/>`);
    s.push(`<text class="ch-label ch-today-label" x="${x}" y="${T - 6}" text-anchor="middle">Today</text>`);
  }
  return s.join('') + '</svg>';
}

/** Ring showing a 0..1 fraction (null shows "—"). */
export function donutSvg(fraction, caption, size = 104) {
  const r = 40, c = 2 * Math.PI * r;
  const f = fraction == null ? 0 : Math.max(0, Math.min(1, fraction));
  const value = fraction == null ? '—' : `${Math.round(fraction * 100)}%`;
  return `<svg class="ch-donut" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="${escapeHtml(`${value} ${caption}`)}">
    <circle class="ch-donut-track" cx="50" cy="50" r="${r}"/>
    <circle class="ch-donut-fill" cx="50" cy="50" r="${r}" stroke-dasharray="${r2(c)}" stroke-dashoffset="${r2(c * (1 - f))}" transform="rotate(-90 50 50)"/>
    <text class="ch-donut-value" x="50" y="52" text-anchor="middle">${value}</text>
    <text class="ch-donut-caption" x="50" y="66" text-anchor="middle">${escapeHtml(caption)}</text>
  </svg>`;
}

/**
 * Static Gantt for the report. rows: metrics.phaseRows.
 * opts: { start, end, today, due, completion }
 */
export function ganttSvg(rows, { start, end, today, due, W = 760 } = {}) {
  if (!rows.length) return '<div class="ch-empty">No phases scheduled yet.</div>';
  const LBL = 190, R = 30, HEAD = 24, ROW = 24;
  const H = HEAD + rows.length * ROW + 6;
  const days = daysBetween(start, end) + 1;
  const plotW = W - LBL - R;
  const xOf = (d) => LBL + (daysBetween(start, d) / days) * plotW;
  const dayW = plotW / days;
  const trunc = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const s = [`<svg class="ch ch-gantt" viewBox="0 0 ${W} ${H}" role="img" aria-label="Schedule">`];

  // month gridlines + labels
  for (let m = new Date(start.getFullYear(), start.getMonth(), 1); m <= end; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
    const x = r2(Math.max(LBL, xOf(m)));
    s.push(`<line class="ch-grid" x1="${x}" x2="${x}" y1="${HEAD - 6}" y2="${H}"/>`);
    const next = new Date(m.getFullYear(), m.getMonth() + 1, 1);
    if (xOf(next) - x > 34) {
      const label = fmtDate(m, { month: 'short', ...(m.getMonth() === 0 || m <= start ? { year: '2-digit' } : {}) });
      s.push(`<text class="ch-label" x="${r2(x + 4)}" y="${HEAD - 10}">${escapeHtml(label)}</text>`);
    }
  }
  s.push(`<line class="ch-axis" x1="${LBL}" x2="${W - R}" y1="${HEAD}" y2="${HEAD}"/>`);

  rows.forEach((r, i) => {
    const y = HEAD + i * ROW;
    const color = `var(--cat-${r.color + 1})`;
    if (i % 2 === 1) s.push(`<rect class="ch-zebra" x="0" y="${y}" width="${W}" height="${ROW}"/>`);
    s.push(`<text class="ch-row-label" x="6" y="${y + ROW / 2 + 4}">${escapeHtml(trunc(r.name, 28))}</text>`);
    const x1 = xOf(r.start);
    if (r.kind === 'milestone') {
      const cx = r2(x1 + dayW / 2), cy = y + ROW / 2;
      s.push(`<path style="fill:${color}" d="M${cx},${cy - 7} L${cx + 7},${cy} L${cx},${cy + 7} L${cx - 7},${cy} Z"/>`);
      return;
    }
    const w = Math.max(3, xOf(addDays(r.end, 1)) - x1);
    s.push(`<rect style="fill:${color}" fill-opacity="0.25" x="${r2(x1)}" y="${y + 5}" width="${r2(w)}" height="${ROW - 10}" rx="3"/>`);
    if (r.progress > 0) s.push(`<rect style="fill:${color}" x="${r2(x1)}" y="${y + 5}" width="${r2((w * r.progress) / 100)}" height="${ROW - 10}" rx="3"/>`);
    s.push(`<text class="ch-label" x="${r2(x1 + w + 4)}" y="${y + ROW / 2 + 3}">${r.progress}%</text>`);
  });

  if (due && due >= start && due <= end) {
    const x = r2(xOf(addDays(due, 1)));
    s.push(`<line class="ch-due" x1="${x}" x2="${x}" y1="${HEAD - 4}" y2="${H}"/>`);
  }
  if (today >= start && today <= end) {
    const x = r2(xOf(today) + dayW / 2);
    s.push(`<line class="ch-today" x1="${x}" x2="${x}" y1="${HEAD - 4}" y2="${H}"/>`);
  }
  return s.join('') + '</svg>';
}
