// Archive tab: ended (filed) projects. They keep their whole history and can
// be opened (read-only timer), restored to the main list, or deleted. Each row
// shows what the project earned and per tracked hour; the tiles on top add
// them up over every ended project.
import { api } from '../core/api.js';
import { escapeHtml, fmtDate, fmtHM, money, moneyIn } from '../core/format.js';
import { addMoney, fmtTotal, moneyOf, newTotal, singleCurrency } from '../core/money.js';
import { earned, effectiveRate } from '../core/model.js';
import { openEndDialog } from './end-project.js';
import { logoMarkup, openMenu } from './projects.js';
import { act, state } from './store.js';

const listEl = document.getElementById('archiveList');
const emptyEl = document.getElementById('archiveEmpty');
const summaryEl = document.getElementById('archiveSummary');

const tile = (label, value, sub = '') => `
  <div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div><div class="tile-sub">${sub}</div></div>`;

function renderSummary(rows) {
  summaryEl.classList.toggle('hidden', rows.length === 0);
  if (!rows.length) return;
  const seconds = rows.reduce((sum, p) => sum + p.total_seconds, 0);
  // The average rate only counts projects with a known amount, over their own hours.
  const paid = rows.filter((p) => earned(p, p.total_seconds) != null);
  // Per currency; a rate over projects in different currencies means nothing.
  const total = paid.reduce((t, p) => addMoney(t, p, earned(p, p.total_seconds)), newTotal());
  const code = singleCurrency(total);
  const amount = code === undefined ? null : total.get(code);
  const paidSeconds = paid.reduce((sum, p) => sum + p.total_seconds, 0);
  const rate = amount != null && paidSeconds > 0 ? amount / (paidSeconds / 3600) : null;
  const rateText = rate == null ? '—' : `${code ? moneyIn(rate, code) : money(rate)}/h`;
  const unpaid = rows.length - paid.length;
  summaryEl.innerHTML = [
    tile('Ended projects', rows.length),
    tile('Total tracked', fmtHM(seconds)),
    tile('Earned', `<span class="earnings">${paid.length ? fmtTotal(total) : '—'}</span>`, unpaid ? `${unpaid} without a payment` : ''),
    tile('Per hour', rateText, rate != null ? `over ${fmtHM(paidSeconds)}` : paid.length ? 'mixed currencies' : ''),
  ].join('');
}

function rowSub(p) {
  const parts = [p.archived_at ? `Ended ${fmtDate(new Date(p.archived_at))}` : 'Ended', fmtHM(p.total_seconds)];
  const amount = earned(p, p.total_seconds);
  if (amount != null) {
    parts.push(`<span class="earnings" title="${p.final_payment > 0 ? 'Final payment' : 'Hourly bill'}">${moneyOf(p, amount)}</span>`);
    const rate = effectiveRate(p, p.total_seconds);
    if (rate != null) parts.push(`${moneyOf(p, rate)}/h`);
  } else if (p.is_owner) {
    parts.push('<button class="link-btn" data-action="payment">Add payment</button>');
  }
  return parts.join(' · ');
}

export function renderArchive() {
  const rows = state.archived;
  emptyEl.classList.toggle('hidden', rows.length > 0);
  renderSummary(rows);
  listEl.innerHTML = rows.map((p) => `
      <article class="archive-row" data-id="${p.id}">
        ${logoMarkup(p)}
        <div class="archive-text" role="button" tabindex="0" title="Open project">
          <div class="card-name">${escapeHtml(p.name)}</div>
          <div class="archive-sub">${rowSub(p)}</div>
        </div>
        <button class="card-menu-btn" title="More">
          <svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/></svg>
        </button>
      </article>`).join('');
}

listEl.addEventListener('click', (e) => {
  const row = e.target.closest('.archive-row');
  const p = row && state.archived.find((x) => x.id === row.dataset.id);
  if (!p) return;
  const menuBtn = e.target.closest('.card-menu-btn');
  if (e.target.closest('[data-action="payment"]')) {
    e.stopPropagation();
    openEndDialog(p, 'payment');
  } else if (menuBtn) {
    e.stopPropagation();
    openMenu(
      menuBtn,
      [
        { action: 'open', label: 'Open project' },
        ...(p.is_owner ? [
          { action: 'payment', label: p.final_payment > 0 ? 'Edit final payment' : 'Set final payment' },
          { action: 'restore', label: 'Restore to projects' },
          { action: 'delete', label: 'Delete', danger: true },
        ] : []),
      ],
      (action) => {
        if (action === 'open') api.openProjectWindow(p.id);
        if (action === 'payment') openEndDialog(p, 'payment');
        if (action === 'restore') act(() => api.restoreProject(p.id));
        if (action === 'delete' && confirm(`Delete "${p.name}"? This removes its tracked time and schedule permanently.`)) {
          act(() => api.deleteProject(p.id));
        }
      },
    );
  } else if (e.target.closest('.archive-text')) {
    api.openProjectWindow(p.id);
  }
});
listEl.addEventListener('keydown', (e) => {
  const row = e.target.closest('.archive-text');
  if (row && (e.key === 'Enter' || e.key === ' ') && !e.target.closest('button')) {
    e.preventDefault();
    api.openProjectWindow(row.closest('.archive-row').dataset.id);
  }
});
