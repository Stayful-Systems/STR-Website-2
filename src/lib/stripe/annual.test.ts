import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMonthsClamped, annualSlotAt, annualSlots, monthSlotAt, monthSlots } from './annual.ts';

const DAY = 86_400_000;

test('adding a month clamps to the last day of the target month', () => {
  assert.equal(addMonthsClamped(new Date('2026-01-31T10:00:00Z'), 1).toISOString(), '2026-02-28T10:00:00.000Z');
  assert.equal(addMonthsClamped(new Date('2026-01-31T10:00:00Z'), 2).toISOString(), '2026-03-31T10:00:00.000Z');
  assert.equal(addMonthsClamped(new Date('2026-01-31T10:00:00Z'), 3).toISOString(), '2026-04-30T10:00:00.000Z');
  assert.equal(addMonthsClamped(new Date('2028-01-31T10:00:00Z'), 1).toISOString(), '2028-02-29T10:00:00.000Z');
  assert.equal(addMonthsClamped(new Date('2026-01-15T10:00:00Z'), 12).toISOString(), '2027-01-15T10:00:00.000Z');
  assert.equal(addMonthsClamped(new Date('2026-11-30T10:00:00Z'), 3).toISOString(), '2027-02-28T10:00:00.000Z');
});

test('every start day gives twelve slots with twelve distinct month keys that cover the whole year (B8)', () => {
  for (const startDay of [1, 15, 28, 29, 30, 31]) {
    const start = new Date(Date.UTC(2026, 0, startDay, 9, 30));
    const end = new Date(Date.UTC(2027, 0, startDay, 9, 30));
    const slots = annualSlots(start, end);
    assert.equal(slots.length, 12);
    assert.equal(new Set(slots.map((s) => s.key)).size, 12, `start day ${startDay}: keys ${slots.map((s) => s.key).join(',')}`);
    assert.equal(slots[0].from.getTime(), start.getTime());
    assert.equal(slots[11].to.getTime(), end.getTime());
    for (let i = 1; i < 12; i++) assert.equal(slots[i].from.getTime(), slots[i - 1].to.getTime(), 'contiguous');
    // A sweep every day of the year lands in exactly one slot, and the keys it meets are all twelve.
    const seen = new Set<string>();
    for (let t = start.getTime(); t < end.getTime(); t += DAY) {
      const s = annualSlotAt(start, end, new Date(t));
      assert.ok(s, `day ${new Date(t).toISOString()} has a slot`);
      seen.add(s!.key);
    }
    assert.equal(seen.size, 12, `start day ${startDay} grants every month`);
  }
});

test('outside the period there is no slot; the first slot is keyed on the start month, as the webhook keys it', () => {
  const start = new Date('2026-01-31T09:30:00Z');
  const end = new Date('2027-01-31T09:30:00Z');
  assert.equal(annualSlotAt(start, end, new Date('2026-01-31T09:29:59Z')), null);
  assert.equal(annualSlotAt(start, end, end), null);
  assert.equal(annualSlotAt(start, end, start)?.key, '2026-01');
  assert.equal(annualSlotAt(start, end, new Date('2026-03-01T00:00:00Z'))?.key, '2026-02');
  assert.equal(annualSlotAt(start, end, new Date('2026-03-31T12:00:00Z'))?.key, '2026-03');
});

test('annualSlots and annualSlotAt are monthSlots / monthSlotAt with count 12, slot for slot (Batch 31a)', () => {
  for (const startDay of [1, 15, 28, 29, 30, 31]) {
    for (const month of [0, 1, 7, 10, 11]) {
      const start = new Date(Date.UTC(2027, month, startDay, 9, 30));
      const end = addMonthsClamped(start, 12);
      assert.deepEqual(annualSlots(start, end), monthSlots(start, end, 12));
      for (let t = start.getTime() - DAY; t <= end.getTime() + DAY; t += 7 * DAY) {
        assert.deepEqual(annualSlotAt(start, end, new Date(t)), monthSlotAt(start, end, new Date(t), 12));
      }
    }
  }
});

test('monthSlots: any count gives that many contiguous slots, the last ending at the period end (Batch 31a)', () => {
  const start = new Date('2026-01-31T09:30:00Z');
  const end = new Date(start.getTime() + 90 * DAY); // 1 May 2026
  const slots = monthSlots(start, end, 3);
  assert.deepEqual(slots.map((s) => [s.key, s.from.toISOString(), s.to.toISOString()]), [
    ['2026-01', '2026-01-31T09:30:00.000Z', '2026-02-28T09:30:00.000Z'],
    ['2026-02', '2026-02-28T09:30:00.000Z', '2026-03-31T09:30:00.000Z'],
    ['2026-03', '2026-03-31T09:30:00.000Z', '2026-05-01T09:30:00.000Z'],
  ]);
  assert.equal(monthSlots(start, end, 1).length, 1);
  assert.equal(monthSlots(start, end, 1)[0].to.getTime(), end.getTime());
  assert.equal(monthSlotAt(start, end, new Date('2026-04-30T12:00:00Z'), 3)?.slot, 2);
  assert.equal(monthSlotAt(start, end, end, 3), null);
  assert.equal(monthSlotAt(start, end, new Date(start.getTime() - 1), 3), null);
});
