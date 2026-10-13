// Formatting and local-date helpers. Pure functions, no DOM, so the report
// builder can use them too.

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 3725 -> "01:02:05" */
export function fmtHMS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

/** 3725 -> "1h 02m", 45 -> "<1m" */
export function fmtHM(sec) {
  if (!(sec > 0)) return '0m';
  const mins = Math.round(sec / 60);
  if (mins === 0) return '<1m';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${pad2(m)}m` : `${m}m`;
}

/** 12.345 -> "12.3 h". Hours as a decimal, for plans and budgets. */
export function fmtHours(hours, { sign = false } = {}) {
  if (hours == null || !Number.isFinite(hours)) return '—';
  const abs = Math.abs(hours);
  const txt = `${abs >= 100 ? abs.toFixed(0) : abs.toFixed(1).replace(/\.0$/, '')} h`;
  if (hours < 0) return `−${txt}`;
  return sign && hours > 0 ? `+${txt}` : txt;
}

export function money(amount) {
  if (amount == null || !Number.isFinite(amount)) return '—';
  return `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 0.456 -> "46%" (null -> "—") */
export function pct(fraction) {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  return `${Math.round(fraction * 100)}%`;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Escapes text for use inside innerHTML strings. All user text goes through here. */
export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- local dates (the same local time zone the backend uses to bucket days)

/** Date -> "YYYY-MM-DD" (local) */
export function dayKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "YYYY-MM-DD" -> local midnight Date (null if empty/invalid) */
export function parseDay(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

export function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export function startOfToday() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

/** Monday on or before `d`. */
export function startOfWeek(d) {
  return addDays(d, -((d.getDay() + 6) % 7));
}

/** Whole calendar days from a to b (DST-safe). */
export function daysBetween(a, b) {
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000);
}

export function fmtDate(d, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  return d ? d.toLocaleDateString(undefined, opts) : '—';
}

/** "2026-10-12" -> "Oct 12" (or with year when asked) */
export function fmtDay(key, withYear = false) {
  const d = parseDay(key);
  return d ? fmtDate(d, withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' }) : '—';
}

export function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
