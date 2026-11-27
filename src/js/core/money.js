// Money in each project's currency. A project in an organization that set a
// currency is billed in it; any other project in yours (setFormatCurrency).
// Totals over several projects are kept per currency, never added across
// them: "$1,200.00 + €300.00". Pure, shared with the Android app through its
// src/lib/shared.js; each app calls setOrgCurrencies() whenever it reloads
// the organizations.
import { formatCurrency, money, moneyIn } from './format.js';

const CODE = /^[A-Z]{3}$/;
let orgCurrency = new Map(); // org id -> its currency code

/** `orgs`: [{ id, currency }]. Ones without a currency bill in yours. */
export function setOrgCurrencies(orgs) {
  orgCurrency = new Map((orgs || []).filter((o) => CODE.test(o.currency || '')).map((o) => [o.id, o.currency]));
}

/** A project's currency code, or null when it's yours (the same code as yours counts as yours). */
export function currencyOf(project) {
  const code = project?.org_id ? orgCurrency.get(project.org_id) : null;
  return code && code !== formatCurrency() ? code : null;
}

/** `amount` in `project`'s currency. */
export function moneyOf(project, amount) {
  const code = currencyOf(project);
  return code ? moneyIn(amount, code) : money(amount);
}

/** Amounts per currency: null = yours. Add with addMoney, show with fmtTotal. */
export const newTotal = () => new Map();

/** Adds `amount`, in `project`'s currency, to `total`. Returns `total`. */
export function addMoney(total, project, amount) {
  if (!(amount > 0)) return total;
  const code = currencyOf(project);
  total.set(code, (total.get(code) || 0) + amount);
  return total;
}

/** True if nothing was added. */
export const isEmptyTotal = (total) => ![...total.values()].some((v) => v > 0);

/** The one currency of a total (null = yours), or undefined if it has several, or none. */
export function singleCurrency(total) {
  const codes = [...total.keys()];
  return codes.length === 1 ? codes[0] : undefined;
}

/** "$1,200.00", or "$1,200.00 + €300.00" (yours first), or `empty`. */
export function fmtTotal(total, empty = '—') {
  if (isEmptyTotal(total)) return empty;
  return [...total.entries()]
    .filter(([, v]) => v > 0)
    .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)))
    .map(([code, v]) => (code ? moneyIn(v, code) : money(v)))
    .join(' + ');
}
