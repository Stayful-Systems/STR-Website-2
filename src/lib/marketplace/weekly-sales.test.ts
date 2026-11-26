import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MONTHLY_REPORT_TARGET, WEEKS_SHOWN, reportsThisMonth, salesTotals, weeklySales, type SalesRow } from './weekly-sales.ts';
import { R2R_PERMISSION_NOTICE, r2rNoticeFor } from './r2r-notice.ts';

// Thursday 26 Nov 2026: its UK week starts Monday 23 Nov.
const NOW = new Date('2026-11-26T12:00:00Z');
const row = (at: string, kind: 'rent' | 'sale', what: 'open' | 'report'): SalesRow => ({ at, kind, what });

test('eight weeks, oldest first, every one shown even with nothing in it', () => {
  const weeks = weeklySales([], NOW);
  assert.equal(weeks.length, WEEKS_SHOWN);
  assert.equal(weeks[0].weekStart, '2026-10-05');
  assert.equal(weeks[7].weekStart, '2026-11-23');
  for (const w of weeks) assert.deepEqual([w.rent, w.sale], [{ opens: 0, reports: 0 }, { opens: 0, reports: 0 }]);
  assert.equal(weeks[7].label, '23 Nov');
});

test('both kinds, opens and reports, in the right week', () => {
  const weeks = weeklySales([
    row('2026-11-24T09:00:00Z', 'rent', 'open'),
    row('2026-11-24T10:00:00Z', 'rent', 'open'),
    row('2026-11-25T10:00:00Z', 'sale', 'open'),
    row('2026-11-25T11:00:00Z', 'sale', 'report'),
    row('2026-11-18T11:00:00Z', 'rent', 'report'),
  ], NOW);
  assert.deepEqual(weeks[7].rent, { opens: 2, reports: 0 });
  assert.deepEqual(weeks[7].sale, { opens: 1, reports: 1 });
  assert.deepEqual(weeks[6].rent, { opens: 0, reports: 1 });
  assert.deepEqual(salesTotals(weeks), { rent: { opens: 2, reports: 1 }, sale: { opens: 1, reports: 1 } });
});

test('week edges: Monday 00:00 UK starts a week, Sunday 23:59 ends the one before', () => {
  const weeks = weeklySales([
    row('2026-11-22T23:59:00Z', 'rent', 'open'), // Sunday night: the week before
    row('2026-11-23T00:00:00Z', 'rent', 'open'), // Monday 00:00 (UK is UTC in winter): this week
  ], NOW);
  assert.equal(weeks[6].rent.opens, 1);
  assert.equal(weeks[7].rent.opens, 1);
  // In summer UK is an hour ahead: 23:30 UTC on Sunday is already Monday in London.
  const summer = weeklySales([row('2026-06-14T23:30:00Z', 'sale', 'open')], new Date('2026-06-17T12:00:00Z'));
  assert.equal(summer[7].weekStart, '2026-06-15');
  assert.equal(summer[7].sale.opens, 1);
});

test('rows outside the eight weeks, in the future or without a date are left out', () => {
  const weeks = weeklySales([row('2026-10-04T12:00:00Z', 'rent', 'open'), row('2026-12-30T12:00:00Z', 'rent', 'open'), row('nonsense', 'rent', 'open')], NOW);
  assert.deepEqual(salesTotals(weeks), { rent: { opens: 0, reports: 0 }, sale: { opens: 0, reports: 0 } });
});

test('reports this month against the target', () => {
  const rows = [row('2026-11-02T10:00:00Z', 'rent', 'report'), row('2026-11-20T10:00:00Z', 'sale', 'report'), row('2026-10-31T23:30:00Z', 'sale', 'report'), row('2026-11-05T10:00:00Z', 'sale', 'open')];
  assert.deepEqual(reportsThisMonth(rows, NOW), { count: 2, target: MONTHLY_REPORT_TARGET, monthLabel: 'November 2026' });
  assert.equal(MONTHLY_REPORT_TARGET, 50);
  assert.equal(reportsThisMonth(rows, NOW, 10).target, 10);
});

test('the rent-to-rent permission notice shows for a rental only', () => {
  assert.equal(r2rNoticeFor('rent'), R2R_PERMISSION_NOTICE);
  assert.equal(r2rNoticeFor('sale'), null);
  assert.equal(r2rNoticeFor(null), null);
  assert.equal(R2R_PERMISSION_NOTICE, 'This is an ordinary let. You still need the landlord’s written permission for short lets, and the lender’s and freeholder’s where they apply.');
});
