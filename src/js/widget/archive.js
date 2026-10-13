// Archive tab: filed projects. They keep their whole history and can be
// opened (read-only timer), restored to the main list, or deleted.
import { api } from '../core/api.js';
import { escapeHtml, fmtDate, fmtHM, money } from '../core/format.js';
import { bill } from '../core/model.js';
import { logoMarkup, openMenu } from './projects.js';
import { act, state } from './store.js';

const listEl = document.getElementById('archiveList');
const emptyEl = document.getElementById('archiveEmpty');

export function renderArchive() {
  const rows = state.archived;
  emptyEl.classList.toggle('hidden', rows.length > 0);
  listEl.innerHTML = rows.map((p) => {
    const filed = p.archived_at ? `Filed ${fmtDate(new Date(p.archived_at))}` : 'Filed';
    const billed = p.hourly_rate > 0 ? ` · <span class="earnings">${money(bill(p, p.total_seconds))}</span>` : '';
    return `
      <article class="archive-row" data-id="${p.id}">
        ${logoMarkup(p)}
        <div class="archive-text" role="button" tabindex="0" title="Open project">
          <div class="card-name">${escapeHtml(p.name)}</div>
          <div class="archive-sub">${filed} · ${fmtHM(p.total_seconds)}${billed}</div>
        </div>
        <button class="card-menu-btn" title="More">
          <svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/></svg>
        </button>
      </article>`;
  }).join('');
}

listEl.addEventListener('click', (e) => {
  const row = e.target.closest('.archive-row');
  const p = row && state.archived.find((x) => x.id === row.dataset.id);
  if (!p) return;
  const menuBtn = e.target.closest('.card-menu-btn');
  if (menuBtn) {
    e.stopPropagation();
    openMenu(
      menuBtn,
      [
        { action: 'open', label: 'Open project' },
        { action: 'restore', label: 'Restore to projects' },
        { action: 'delete', label: 'Delete', danger: true },
      ],
      (action) => {
        if (action === 'open') api.openProjectWindow(p.id);
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
  if (row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    api.openProjectWindow(row.closest('.archive-row').dataset.id);
  }
});
