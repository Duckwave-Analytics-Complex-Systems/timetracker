// Formatting and local-date helpers. Pure functions, no DOM, so the report
// builder can use them too.

// The locale for dates, times and money. undefined = the system's (the
// desktop never sets it); the Android app sets it to the app's language.
let LOCALE;
// The currency for money(): undefined = "$" + number, as the desktop has
// always shown it; the Android app sets the profile's ISO code (e.g. "EUR").
let CURRENCY;
// The first day of the week for startOfWeek(): 1 = Monday, 0 = Sunday.
let WEEK_START = 1;
let moneyFmt = null; // cached Intl.NumberFormat for LOCALE + CURRENCY

export function setFormatLocale(locale) {
  LOCALE = locale || undefined;
  moneyFmt = null;
}

export function setFormatCurrency(code) {
  CURRENCY = /^[A-Z]{3}$/.test(code || '') ? code : undefined;
  moneyFmt = null;
}

/** Your currency code, as set by setFormatCurrency() (undefined = "$" + number). */
export function formatCurrency() {
  return CURRENCY;
}

export function setWeekStart(day) {
  WEEK_START = day === 0 ? 0 : 1;
}

export function weekStart() {
  return WEEK_START;
}

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
  if (CURRENCY) {
    if (!moneyFmt) moneyFmt = currencyFormat();
    if (moneyFmt) return moneyFmt.format(amount);
  }
  return `$${amount.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "$" rather than "US$" or "MX$" where the engine supports it; false if the code is unknown. */
function currencyFormat(currency = CURRENCY) {
  for (const currencyDisplay of ['narrowSymbol', 'symbol']) {
    try {
      return new Intl.NumberFormat(LOCALE, { style: 'currency', currency, currencyDisplay });
    } catch { /* try the next one */ }
  }
  return false;
}

/**
 * Like money(), in a given currency (an organization's) rather than yours.
 * A missing or unknown code falls back to money().
 */
export function moneyIn(amount, currency) {
  if (!/^[A-Z]{3}$/.test(currency || '') || currency === CURRENCY) return money(amount);
  if (amount == null || !Number.isFinite(amount)) return '—';
  const fmt = currencyFormat(currency);
  return fmt ? fmt.format(amount) : money(amount);
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

/** The first day of `d`'s week: Monday unless setWeekStart(0) chose Sunday. */
export function startOfWeek(d, first = WEEK_START) {
  return addDays(d, -((d.getDay() - first + 7) % 7));
}

/** Whole calendar days from a to b (DST-safe). */
export function daysBetween(a, b) {
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000);
}

export function fmtDate(d, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  return d ? d.toLocaleDateString(LOCALE, opts) : '—';
}

/** "2026-10-12" -> "Oct 12" (or with year when asked) */
export function fmtDay(key, withYear = false) {
  const d = parseDay(key);
  return d ? fmtDate(d, withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' }) : '—';
}

export function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
}
