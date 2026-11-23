// The "End project" dialog: files a project (it moves to the Archive with its
// whole history) and, when there is no hourly rate to bill from, takes the
// total it paid. The Archive opens the same dialog to change that payment
// later. Earnings and the effective hourly rate come from `earned()` in
// core/model.js, so the Archive shows the same numbers.
import { api } from '../core/api.js';
import { escapeHtml, fmtHM } from '../core/format.js';
import { moneyOf } from '../core/money.js';
import { bill, effectiveRate, earned, liveSeconds } from '../core/model.js';
import { act } from './store.js';

const $ = (id) => document.getElementById(id);
const dialogEl = $('endDialog');
const paymentInput = $('endPayment');

let current = null; // { p, seconds, mode: 'end' | 'payment' }

/** Amount typed in the field, or null when empty / not positive. */
function typedPayment() {
  const v = parseFloat(paymentInput.value);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function renderNumbers() {
  const { p, seconds } = current;
  const preview = { ...p, final_payment: typedPayment() };
  const amount = earned(preview, seconds);
  const rate = effectiveRate(preview, seconds);
  $('endTime').textContent = fmtHM(seconds);
  $('endEarnedLabel').textContent = preview.final_payment ? 'Paid' : 'Billed';
  $('endEarned').textContent = moneyOf(p, amount);
  $('endRate').textContent = rate != null ? `${moneyOf(p, rate)}/h` : '—';
}

/**
 * mode 'end': end (file) the project. mode 'payment': only change the final
 * payment of a project that has already ended.
 */
export function openEndDialog(p, mode = 'end') {
  const seconds = liveSeconds(p);
  current = { p, seconds, mode };
  const hasRate = p.hourly_rate > 0;
  // Asked for when there is nothing to bill from; kept editable once set.
  const askPayment = mode === 'payment' || !hasRate || p.final_payment > 0;

  $('endTitle').textContent = mode === 'end' ? 'End project' : 'Final payment';
  $('endIntro').innerHTML = mode === 'end'
    ? `<b>${escapeHtml(p.name)}</b> moves to the Archive. ${p.is_running ? 'Its timer stops and ' : ''}its history is kept, and you can restore it at any time.`
    : `What <b>${escapeHtml(p.name)}</b> paid in total. Leave it empty to ${hasRate ? 'use the hourly bill' : 'clear it'}.`;
  $('endPaymentField').classList.toggle('hidden', !askPayment);
  $('endPaymentHint').classList.toggle('hidden', !askPayment);
  $('endPaymentHint').textContent = hasRate
    ? `Replaces the hourly bill (${moneyOf(p, bill(p, seconds))}) in the Archive.`
    : 'This project has no hourly rate. Enter what it paid to see its cost per hour in the Archive.';
  paymentInput.value = p.final_payment > 0 ? p.final_payment : '';
  $('endSubmit').textContent = mode === 'end' ? 'End project' : 'Save';

  renderNumbers();
  dialogEl.showModal();
  if (askPayment) paymentInput.focus();
}

paymentInput.addEventListener('input', renderNumbers);
$('endCancel').addEventListener('click', () => dialogEl.close());
$('endForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!current) return;
  const { p, mode } = current;
  // A hidden field means "keep what is there" (nothing, for an hourly project).
  const payment = $('endPaymentField').classList.contains('hidden') ? (p.final_payment ?? null) : typedPayment();
  await act(() => (mode === 'end' ? api.endProject(p.id, payment) : api.setFinalPayment(p.id, payment)));
  current = null;
  dialogEl.close();
});
