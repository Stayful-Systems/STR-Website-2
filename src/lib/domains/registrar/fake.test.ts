import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeRegistrar } from './fake.ts';

test('fake changeIpsTag records the tag and counts as a write', async () => {
  const r = new FakeRegistrar();
  await r.changeIpsTag('acme.co.uk', 'GODADDY');
  assert.equal(r.tags.get('acme.co.uk'), 'GODADDY');
  assert.equal(r.calls.changeIpsTag, 1);
  assert.equal(r.writeCalls(), 1);
});

test('fake transferCode returns the fixed test code and counts as a write', async () => {
  const r = new FakeRegistrar();
  assert.equal(await r.transferCode('acme.co.uk'), FakeRegistrar.TEST_TRANSFER_CODE);
  assert.equal(r.calls.transferCode, 1);
  assert.equal(r.writeCalls(), 1);
  assert.deepEqual(r.log, ['transferCode:acme.co.uk']);
});

test('fake transferCode can be made to fail once', async () => {
  const r = new FakeRegistrar();
  r.failNext.set('transferCode', 'refused');
  await assert.rejects(r.transferCode('acme.co.uk'));
  assert.equal(await r.transferCode('acme.co.uk'), FakeRegistrar.TEST_TRANSFER_CODE);
});
