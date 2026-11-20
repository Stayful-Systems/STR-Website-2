import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeLike, expirePlanSource, idlePlanReport, planSourcePattern } from './ledger.ts';

/** Batch 34: credit_expire_plan_source takes a LIKE pattern; the wrapper builds it so ids match only themselves. */

test('escapeLike escapes the LIKE wildcards and the escape character', () => {
  assert.equal(escapeLike('inv:in_1'), 'inv:in\\_1');
  assert.equal(escapeLike('50%_off\\x'), '50\\%\\_off\\\\x');
  assert.equal(escapeLike('plain:ref'), 'plain:ref');
});

test('planSourcePattern: an exact ref has no wildcard; a prefix gets one trailing %', () => {
  assert.equal(planSourcePattern({ exact: 'inv:in_1AbC' }), 'inv:in\\_1AbC');
  assert.equal(planSourcePattern({ prefix: 'trial:sub_1:' }), 'trial:sub\\_1:%');
  // A caller-supplied % in the prefix is literal, never a second wildcard.
  assert.equal(planSourcePattern({ prefix: 'trial:%' }), 'trial:\\%%');
  assert.throws(() => planSourcePattern({ exact: '' }));
  assert.throws(() => planSourcePattern({ prefix: '' }));
});

test('without a service role the plan wrappers are no-ops (local dev, tests)', async () => {
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    assert.deepEqual(await expirePlanSource('u1', { exact: 'inv:in_1' }, null, 'plan_refunded'), { expiredPence: 0, grants: 0 });
    assert.deepEqual(await idlePlanReport(), []);
  } finally {
    if (saved !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
  }
});
