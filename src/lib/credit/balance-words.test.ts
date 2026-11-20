import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chipAria, chipTitle, daysWords, lowBalanceText, planCreditLine, rolledOverWords } from './balance-words.ts';

const gbp = (p: number) => `£${(p / 100).toFixed(2)}`;

test('rolledOverWords only speaks when something rolled over', () => {
  assert.equal(rolledOverWords(0, gbp), null);
  assert.equal(rolledOverWords(undefined, gbp), null);
  assert.equal(rolledOverWords(1300, gbp), '£13.00 of your balance rolled over');
});

test('daysWords pluralises and stays quiet with no daily price', () => {
  assert.equal(daysWords(null), null);
  assert.equal(daysWords(1), 'about 1 day of daily deals');
  assert.equal(daysWords(0), 'about 0 days of daily deals');
  assert.equal(daysWords(12), 'about 12 days of daily deals');
});

test('chipTitle adds the days and the rolled-over amount', () => {
  assert.equal(chipTitle({ days: 4, rolledOverPence: 1300 }, gbp), 'Your credit and where it goes · about 4 days of daily deals · £13.00 of your balance rolled over');
  assert.equal(chipTitle({ days: null, rolledOverPence: 0 }, gbp), 'Your credit and where it goes');
  assert.match(chipTitle({ teamName: 'Acme', days: 2 }, gbp), /^Acme's balance — the account owner tops it up · about 2 days/);
});

test('chipAria has the balance, days and rolled-over amount, and no percentage', () => {
  const a = chipAria({ team: false, totalPence: 3200, days: 6, rolledOverPence: 1300 }, gbp);
  assert.equal(a, 'Balance £32.00, about 6 days of daily deals, £13.00 of your balance rolled over. See usage.');
  assert.equal(chipAria({ team: true, totalPence: 500, days: null }, gbp), 'Team balance £5.00. See usage.');
  assert.ok(!/%/.test(a));
});

test('lowBalanceText names the balance, not a percentage', () => {
  assert.equal(lowBalanceText(450, true, gbp), 'Running low: £4.50 of credit left.');
  assert.equal(lowBalanceText(450, false, gbp), 'Running low: £4.50 of credit left · upgrade for monthly credit.');
});

test('planCreditLine leaves out a zero part', () => {
  assert.equal(planCreditLine(1900, 1300, gbp), '£19.00 plan credit this month · £13.00 of your balance rolled over');
  assert.equal(planCreditLine(1900, 0, gbp), '£19.00 plan credit this month');
  assert.equal(planCreditLine(0, 1300, gbp), '£13.00 of your balance rolled over');
  assert.equal(planCreditLine(0, 0, gbp), null);
});
