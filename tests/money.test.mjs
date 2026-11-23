import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFormatCurrency, setFormatLocale } from '../src/js/core/format.js';
import { addMoney, currencyOf, fmtTotal, isEmptyTotal, moneyOf, newTotal, setOrgCurrencies, singleCurrency } from '../src/js/core/money.js';

setFormatLocale('en-US');
setFormatCurrency('USD');
setOrgCurrencies([{ id: 'eu', currency: 'EUR' }, { id: 'us', currency: 'USD' }, { id: 'none', currency: null }]);

const personal = { id: 'p', org_id: null };
const euro = { id: 'e', org_id: 'eu' };
const sameAsMine = { id: 'u', org_id: 'us' };
const noCurrency = { id: 'n', org_id: 'none' };

test('currencyOf: the org\'s, else yours (null)', () => {
  assert.equal(currencyOf(personal), null);
  assert.equal(currencyOf(euro), 'EUR');
  assert.equal(currencyOf(sameAsMine), null, 'the same code as yours is yours');
  assert.equal(currencyOf(noCurrency), null, 'an org without a currency bills in yours');
  assert.equal(currencyOf({ org_id: 'unknown' }), null);
});

test('moneyOf', () => {
  assert.equal(moneyOf(personal, 12.5), '$12.50');
  assert.equal(moneyOf(euro, 12.5), '€12.50');
  assert.equal(moneyOf(sameAsMine, 3), '$3.00');
});

test('totals stay per currency', () => {
  const t = newTotal();
  assert.equal(isEmptyTotal(t), true);
  assert.equal(fmtTotal(t), '—');
  addMoney(t, personal, 100);
  addMoney(t, sameAsMine, 20);
  assert.equal(fmtTotal(t), '$120.00');
  assert.equal(singleCurrency(t), null);
  addMoney(t, euro, 30);
  addMoney(t, euro, 0);
  addMoney(t, euro, NaN);
  assert.equal(fmtTotal(t), '$120.00 + €30.00', 'yours first');
  assert.equal(singleCurrency(t), undefined);
  const e = addMoney(newTotal(), euro, 5);
  assert.equal(singleCurrency(e), 'EUR');
});
