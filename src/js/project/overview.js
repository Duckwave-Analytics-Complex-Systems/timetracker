// Overview tab: health, headline numbers, progress, hours per phase, charts.
import { burnupSvg, donutSvg, weeklyBarsSvg } from '../core/charts.js';
import { escapeHtml, fmtHours } from '../core/format.js';
import { burnupLegendHtml, healthPill, kpiTilesHtml, notesHtml, phaseTableHtml, progressBarsHtml } from './blocks.js';
import { burnupSeries, HEALTH, summarySentence, weeklySeries } from './metrics.js';

export function renderOverview(host, { live, m }) {
  const { project } = live;
  host.innerHTML = `
    <section class="health tone-${HEALTH[m.health].tone}">
      ${donutSvg(m.completion, 'complete')}
      <div class="health-text">
        <div class="health-top">${healthPill(m)}<span class="muted">as of today</span></div>
        <p class="health-summary">${escapeHtml(summarySentence(project.name, m))}</p>
        ${notesHtml(m.notes)}
      </div>
    </section>

    ${kpiTilesHtml(m, project, live.totalSeconds)}

    <section class="panel">
      <div class="panel-head"><h2>Progress</h2><span class="panel-hint">Work done should keep pace with time and budget</span></div>
      ${progressBarsHtml(m)}
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Hours by phase</h2><span class="panel-total">${fmtHours(m.spentH)}</span></div>
      ${phaseTableHtml(m)}
    </section>

    <div class="two-col">
      <section class="panel">
        <div class="panel-head"><h2>Hours per week</h2></div>
        ${weeklyBarsSvg(weeklySeries(live.daily, m))}
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Cumulative hours</h2></div>
        ${burnupLegendHtml}
        ${burnupSvg(burnupSeries(live.daily, m, live.phases))}
      </section>
    </div>`;
}
