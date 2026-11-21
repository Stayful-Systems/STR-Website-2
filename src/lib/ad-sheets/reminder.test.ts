import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countStaleNew, staleNewByOwner, type ReminderLead } from './reminder.ts';
import { DEFAULT_SHEET_SETTINGS } from './settings.ts';

const NOW = new Date('2026-11-21T09:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const lead = (over: Partial<ReminderLead> = {}): ReminderLead => ({ ownerId: 'owner-a', stage: 'new', createdAt: daysAgo(10), archived: false, ...over });

test('counts the owner\'s own leads at New older than the setting\'s days', () => {
  const age = DEFAULT_SHEET_SETTINGS.reminderAgeDays;
  const leads = [
    lead(),
    lead({ stage: null }),
    lead({ createdAt: daysAgo(age + 1) }),
    lead({ createdAt: daysAgo(age - 1) }),
    lead({ createdAt: daysAgo(age) }),
    lead({ stage: 'contacted' }),
    lead({ stage: 'signed' }),
    lead({ archived: true }),
    lead({ createdAt: 'not a date' }),
  ];
  assert.equal(countStaleNew(leads, 'owner-a', NOW, age), 3);
  assert.equal(countStaleNew(leads, 'owner-a', NOW, 30), 0, 'a longer setting counts fewer');
  assert.equal(countStaleNew(leads, 'owner-a', NOW, 0), 0, 'a nonsense setting counts nothing');
});

test('never counts another operator\'s leads', () => {
  const leads = [lead({ ownerId: 'owner-a' }), lead({ ownerId: 'owner-b' }), lead({ ownerId: 'owner-b' })];
  assert.equal(countStaleNew(leads, 'owner-a', NOW, 7), 1);
  assert.equal(countStaleNew(leads, 'owner-c', NOW, 7), 0);
  const by = staleNewByOwner(leads, ['owner-a', 'owner-b', 'owner-c'], NOW, 7);
  assert.deepEqual([...by], [['owner-a', 1], ['owner-b', 2], ['owner-c', 0]]);
});
