// Interactive Gantt chart for the Schedule tab.
//
// Plain absolutely-positioned divs (easier to drag than SVG). The timeline
// always starts on a Monday, so week gridlines are a repeating background.
//
//   drag a bar      -> move it (dates shift, length kept)
//   drag an edge    -> change its start or end date
//   click           -> edit it in the phase dialog
//
// Changes are snapped to whole days and only saved on release.
import { addDays, daysBetween, dayKey, escapeHtml, fmtDate, fmtDay, fmtHours, parseDay, startOfWeek } from '../core/format.js';
import { isMilestone, phaseStatusLabel } from './metrics.js';

export const ZOOMS = {
  day: { px: 30, pad: 3, minDays: 35 },
  week: { px: 12, pad: 7, minDays: 98 },
  month: { px: 4, pad: 21, minDays: 300 },
};
const LABEL_W = 240;
const CLICK_SLOP_PX = 4;

let drag = null; // the drag in progress, if any

/** True while the user is dragging a bar (don't re-render underneath them). */
export function isDragging() {
  return drag != null;
}

function timelineRange(project, rows, today, zoom) {
  const dates = [today, parseDay(project.start_day), parseDay(project.due_day)];
  for (const r of rows) dates.push(r.start, r.end);
  const known = dates.filter(Boolean);
  const z = ZOOMS[zoom];
  const start = startOfWeek(addDays(new Date(Math.min(...known)), -z.pad));
  let end = addDays(new Date(Math.max(...known)), z.pad);
  if (daysBetween(start, end) + 1 < z.minDays) end = addDays(start, z.minDays - 1);
  return { start, end, days: daysBetween(start, end) + 1 };
}

function headerHtml(start, end, px, zoom) {
  const x = (d) => daysBetween(start, d) * px;
  let months = '';
  for (let m = new Date(start.getFullYear(), start.getMonth(), 1); m <= end; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
    const left = Math.max(0, x(m));
    const right = Math.min(x(addDays(end, 1)), x(new Date(m.getFullYear(), m.getMonth() + 1, 1)));
    const w = right - left;
    const label = w > 90 ? fmtDate(m, { month: 'long', year: 'numeric' }) : w > 36 ? fmtDate(m, { month: 'short' }) : '';
    months += `<div class="g-month" style="left:${left}px;width:${w}px">${escapeHtml(label)}</div>`;
  }

  let ticks = '';
  if (zoom === 'day') {
    for (let d = start, i = 0; d <= end; d = addDays(d, 1), i++) {
      const we = d.getDay() === 0 || d.getDay() === 6;
      ticks += `<div class="g-tick${we ? ' we' : ''}" style="left:${i * px}px;width:${px}px"><b>${d.getDate()}</b>${fmtDate(d, { weekday: 'narrow' })}</div>`;
    }
  } else if (zoom === 'week') {
    for (let d = start; d <= end; d = addDays(d, 7)) {
      ticks += `<div class="g-tick" style="left:${x(d)}px;width:${7 * px}px"><b>${d.getDate()}</b></div>`;
    }
  }
  return `<div class="g-months">${months}</div>${ticks ? `<div class="g-ticks">${ticks}</div>` : ''}`;
}

function backgroundHtml(start, end, px, zoom, today, due) {
  const x = (d) => daysBetween(start, d) * px;
  let html = '';
  if (zoom !== 'month') {
    for (let d = addDays(start, 5); d <= end; d = addDays(d, 7)) {
      html += `<div class="g-weekend" style="left:${x(d)}px;width:${2 * px}px"></div>`;
    }
  }
  if (due && due >= start && due <= end) {
    html += `<div class="g-due" style="left:${x(addDays(due, 1))}px" title="Due ${escapeHtml(fmtDate(due))}"><span>Due</span></div>`;
  }
  if (today >= start && today <= end) {
    html += `<div class="g-today" style="left:${x(today) + px / 2}px"><span>Today</span></div>`;
  }
  return html;
}

function labelHtml(r) {
  const st = phaseStatusLabel(r);
  const hours = isMilestone(r)
    ? fmtDay(r.start_day, true)
    : `${fmtHours(r.spentH)}${r.estimated_hours > 0 ? ` / ${fmtHours(r.estimated_hours)}` : ''} · ${r.progress}%`;
  return `
    <div class="g-label" role="button" tabindex="0" data-edit="${r.id}" title="Edit">
      <i class="${isMilestone(r) ? 'ms' : ''}" style="background:var(--cat-${r.color + 1})"></i>
      <div class="g-label-text">
        <div class="g-name">${escapeHtml(r.name)}</div>
        <div class="g-sub${r.overBudget ? ' over' : ''}">${hours}</div>
      </div>
      <span class="pill tone-${st.tone}">${st.text}</span>
    </div>`;
}

function barHtml(r, x, px) {
  const color = `var(--cat-${r.color + 1})`;
  const tip = isMilestone(r)
    ? `${r.name} · ${fmtDay(r.start_day, true)}`
    : `${r.name} · ${fmtDay(r.start_day)} → ${fmtDay(r.end_day, true)} · ${r.progress}% · ${fmtHours(r.spentH)} tracked${r.estimated_hours > 0 ? ` of ${fmtHours(r.estimated_hours)}` : ''}`;
  if (isMilestone(r)) {
    return `<div class="g-ms" data-id="${r.id}" style="left:${x(r.start) + px / 2}px;--c:${color}" title="${escapeHtml(tip)}">
      <span class="g-ms-diamond"></span><span class="g-ms-label">${escapeHtml(r.name)}</span></div>`;
  }
  const width = x(addDays(r.end, 1)) - x(r.start);
  const used = r.estimated_hours > 0 ? Math.min(1, r.spentH / r.estimated_hours) : 0;
  return `
    <div class="g-bar${width < 110 ? ' narrow' : ''}" data-id="${r.id}" style="left:${x(r.start)}px;width:${width}px;--c:${color}" title="${escapeHtml(tip)}">
      <div class="g-bar-fill" style="width:${r.progress}%"></div>
      <span class="g-bar-label">${escapeHtml(r.name)} · ${r.progress}%</span>
      ${r.estimated_hours > 0 ? `<div class="g-hours${r.overBudget ? ' over' : ''}"><div style="width:${(used * 100).toFixed(1)}%"></div></div>` : ''}
      <span class="g-handle l" data-handle="start"></span><span class="g-handle r" data-handle="end"></span>
    </div>`;
}

/**
 * Renders the chart into `host`.
 * ctx: { project, metrics, zoom, onEdit(row), onMove(row, startKey, endKey) }
 */
export function renderGantt(host, ctx) {
  const { project, metrics, zoom } = ctx;
  const rows = metrics.phaseRows;
  const today = metrics.today;
  const { px } = ZOOMS[zoom];
  const { start, end, days } = timelineRange(project, rows, today, zoom);
  const width = days * px;
  const x = (d) => daysBetween(start, d) * px;

  const prevScroll = host.querySelector('.g-scroll');
  const keepScroll = prevScroll && host.dataset.zoom === zoom ? prevScroll.scrollLeft : null;

  // Summary row: the whole project, filled to its completion.
  const pStart = parseDay(project.start_day);
  const pDue = parseDay(project.due_day);
  const summaryBar = pStart && pDue && pDue >= pStart
    ? `<div class="g-bar summary" style="left:${x(pStart)}px;width:${x(addDays(pDue, 1)) - x(pStart)}px">
         <div class="g-bar-fill" style="width:${Math.round((metrics.completion ?? 0) * 100)}%"></div>
       </div>`
    : '<div class="g-hint">Set a start and due date above to see the project span.</div>';

  host.dataset.zoom = zoom;
  host.innerHTML = `
    <div class="gantt" style="--px:${px}px;--label-w:${LABEL_W}px">
      <div class="g-scroll">
        <div class="g-inner" style="width:${LABEL_W + width}px">
          <div class="g-head">
            <div class="g-corner">${rows.length} item${rows.length === 1 ? '' : 's'}</div>
            <div class="g-scale" style="width:${width}px">${headerHtml(start, end, px, zoom)}</div>
          </div>
          <div class="g-body">
            <div class="g-bg ${zoom}" style="width:${width}px">${backgroundHtml(start, end, px, zoom, today, metrics.due)}</div>
            <div class="g-row summary-row">
              <div class="g-label static">
                <i class="proj"></i>
                <div class="g-label-text">
                  <div class="g-name">Project</div>
                  <div class="g-sub">${pStart ? fmtDay(project.start_day) : '—'} → ${pDue ? fmtDay(project.due_day, true) : '—'}</div>
                </div>
              </div>
              <div class="g-track" style="width:${width}px">${summaryBar}</div>
            </div>
            ${rows.map((r) => `
              <div class="g-row">
                ${labelHtml(r)}
                <div class="g-track" style="width:${width}px">${barHtml(r, x, px)}</div>
              </div>`).join('')}
            ${rows.length ? '' : '<div class="g-empty">No phases yet. Add the first phase to build the schedule.</div>'}
          </div>
        </div>
      </div>
      <div class="g-drag-tip hidden"></div>
    </div>`;

  const scroller = host.querySelector('.g-scroll');
  // Today sits ~30% into the visible timeline (the sticky labels cover LABEL_W).
  scroller.scrollLeft = keepScroll ?? Math.max(0, x(today) - (scroller.clientWidth - LABEL_W) * 0.3);

  wireInteractions(host, ctx, { rows, px });
}

/** Scrolls the chart so today is in view. */
export function scrollToToday(host) {
  const line = host.querySelector('.g-today');
  const scroller = host.querySelector('.g-scroll');
  if (line && scroller) scroller.scrollTo({ left: line.offsetLeft - (scroller.clientWidth - LABEL_W) * 0.3, behavior: 'smooth' });
}

function wireInteractions(host, ctx, { rows, px }) {
  const tip = host.querySelector('.g-drag-tip');
  const byId = (id) => rows.find((r) => r.id === id);

  host.querySelectorAll('[data-edit]').forEach((el) => {
    const open = () => ctx.onEdit(byId(el.dataset.edit));
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });

  host.querySelectorAll('.g-bar[data-id], .g-ms[data-id]').forEach((el) => {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const row = byId(el.dataset.id);
      drag = {
        el, row,
        mode: e.target.dataset.handle || 'move',
        x0: e.clientX,
        left0: el.offsetLeft,
        width0: el.offsetWidth,
        moved: false,
        startKey: row.start_day,
        endKey: row.end_day,
      };
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
    });

    el.addEventListener('pointermove', (e) => {
      if (!drag || drag.el !== el) return;
      const dx = e.clientX - drag.x0;
      if (Math.abs(dx) >= CLICK_SLOP_PX) drag.moved = true;
      if (!drag.moved) return;

      const span = daysBetween(drag.row.start, drag.row.end);
      let delta = Math.round(dx / px);
      let s = drag.row.start, en = drag.row.end;
      if (drag.mode === 'move') { s = addDays(s, delta); en = addDays(en, delta); }
      if (drag.mode === 'start') { delta = Math.min(delta, span); s = addDays(s, delta); }
      if (drag.mode === 'end') { delta = Math.max(delta, -span); en = addDays(en, delta); }
      drag.startKey = dayKey(s);
      drag.endKey = dayKey(en);

      if (el.classList.contains('g-ms')) {
        el.style.left = `${drag.left0 + delta * px}px`;
      } else {
        const left = drag.mode === 'end' ? drag.left0 : drag.left0 + delta * px;
        const w = drag.mode === 'move' ? drag.width0 : drag.width0 + (drag.mode === 'end' ? delta : -delta) * px;
        el.style.left = `${left}px`;
        el.style.width = `${w}px`;
      }
      const days = daysBetween(s, en) + 1;
      tip.textContent = isMilestone(drag.row)
        ? fmtDate(s, { weekday: 'short', month: 'short', day: 'numeric' })
        : `${fmtDate(s, { month: 'short', day: 'numeric' })} → ${fmtDate(en, { month: 'short', day: 'numeric' })} · ${days} day${days === 1 ? '' : 's'}`;
      const hostRect = host.getBoundingClientRect();
      tip.style.left = `${Math.min(e.clientX - hostRect.left + 12, hostRect.width - 180)}px`;
      tip.style.top = `${e.clientY - hostRect.top - 34}px`;
      tip.classList.remove('hidden');
    });

    const finish = () => {
      if (!drag || drag.el !== el) return;
      const d = drag;
      drag = null;
      tip.classList.add('hidden');
      el.classList.remove('dragging');
      if (!d.moved) ctx.onEdit(d.row);
      else if (d.startKey !== d.row.start_day || d.endKey !== d.row.end_day) ctx.onMove(d.row, d.startKey, d.endKey);
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
  });
}
