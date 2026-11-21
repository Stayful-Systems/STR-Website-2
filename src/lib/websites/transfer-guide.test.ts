import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGuide, type GuideInput } from './transfer-guide.ts';
import { TRANSFER_PROVIDERS } from './transfer-providers.ts';

const FORM = 'https://app.example.test/api/t/0123456789abcdef0123456789abcdef/lead';
const base: GuideInput = {
  siteName: 'Northern Lets',
  domain: 'northernlets.co.uk',
  method: 'tag',
  provider: { name: '123 Reg', tag: '123-REG', helpUrl: 'https://www.123-reg.co.uk/support/' },
  formAction: FORM,
  ourCopyEnds: '2026-12-21T09:00:00.000Z',
};

const SECTION_HEADINGS = [
  'What you have',
  'Put the folder on a host',
  'Point your domain at the host',
  'How the enquiry form keeps working',
  'How to swap the form for your own',
  'If something goes wrong',
];

test('guide: every part is there, in both shapes', () => {
  const g = buildGuide(base);
  for (const h of SECTION_HEADINGS) {
    assert.ok(g.html.includes(`<h2>${h}</h2>`), h);
    assert.ok(g.text.includes(h), h);
  }
  assert.match(g.html, /^<!doctype html><html lang="en">/);
  assert.match(g.subject, /Northern Lets/);
  assert.match(g.html, /<title>How to use your exported website: Northern Lets<\/title>/);
  assert.ok(g.text.startsWith('How to use your exported website: Northern Lets\n'));
});

test('guide: the tag method names the provider, its tag and the domain, and has no transfer code step', () => {
  const g = buildGuide(base);
  assert.match(g.text, /Moving northernlets\.co\.uk/);
  assert.match(g.text, /change the tag on northernlets\.co\.uk to 123-REG/);
  assert.match(g.text, /account with 123 Reg/);
  assert.doesNotMatch(g.text, /transfer code/i);
  assert.match(g.html, /<a href="https:\/\/www\.123-reg\.co\.uk\/support\/">https:\/\/www\.123-reg\.co\.uk\/support\/<\/a>/);
});

test('guide: the code method says the code is sent separately and never prints one', () => {
  const g = buildGuide({ ...base, method: 'code' });
  assert.match(g.text, /transfer code/);
  assert.match(g.text, /sent? you the code separately|send you the code separately/);
  assert.match(g.text, /not in this guide/);
  assert.doesNotMatch(g.text, /change the tag/i);
  assert.doesNotMatch(g.text, /123-REG/);
});

test('guide: no domain, or a method of none, is files only', () => {
  for (const g of [buildGuide({ ...base, domain: null, method: 'none', provider: null }), buildGuide({ ...base, method: 'none' })]) {
    assert.match(g.text, /nothing to move/);
    assert.doesNotMatch(g.text, /transfer code|change the tag/i);
    assert.ok(g.html.includes('<h2>Your domain</h2>'));
  }
  assert.doesNotMatch(buildGuide({ ...base, domain: null, method: 'none', provider: null }).text, /northernlets\.co\.uk/);
});

test('guide: every known provider reads well, and a typed tag appears as typed', () => {
  for (const p of TRANSFER_PROVIDERS) {
    const g = buildGuide({ ...base, provider: { name: p.name, tag: p.tag, helpUrl: p.helpUrl } });
    assert.ok(g.text.includes(`to ${p.tag} for you`), p.key);
    assert.ok(g.text.includes(p.helpUrl), p.key);
  }
  const other = buildGuide({ ...base, provider: { name: 'Other', tag: 'MY-REG', helpUrl: null } });
  assert.match(other.text, /to MY-REG for you/);
  assert.doesNotMatch(other.text, /help centre/);
});

test('guide: how the form keeps working and how to swap it', () => {
  const g = buildGuide(base);
  assert.match(g.text, /keeps working/);
  assert.match(g.text, /hidden field/);
  assert.match(g.text, /If you have no plan, the enquiry is still saved for you, but no report is made and you are not charged/);
  assert.match(g.text, /<form class="tf-form"/);
  assert.match(g.text, /Keep the same field names/);
  assert.ok(g.text.includes(FORM));
  assert.ok(g.html.includes(`<pre>${FORM}</pre>`));
});

test('guide: the day our copy stops is the one supplied; with none it says "a while" and no date', () => {
  assert.match(buildGuide(base).text, /until 21 December 2026/);
  const none = buildGuide({ ...base, ourCopyEnds: null });
  assert.doesNotMatch(none.text, /until \d/);
  assert.match(none.text, /for a while/);
  assert.match(buildGuide({ ...base, ourCopyEnds: 'not a date' }).text, /for a while/);
});

test('guide: values are escaped in the html, and an unsafe help link is not printed', () => {
  const g = buildGuide({ ...base, siteName: 'A <b>&</b> "Co"', provider: { name: 'X<i>', tag: 'T&G', helpUrl: 'javascript:alert(1)' } });
  assert.doesNotMatch(g.html, /<b>|<i>/);
  assert.match(g.html, /A &lt;b&gt;&amp;&lt;\/b&gt; &quot;Co&quot;/);
  assert.doesNotMatch(g.html, /javascript:/);
  assert.doesNotMatch(g.text, /javascript:/);
});

test('guide: no script, no external file, no secret name, no typed figure, no Stayful asset', () => {
  for (const method of ['tag', 'code', 'none'] as const) {
    const g = buildGuide({ ...base, method, ...(method === 'none' ? { provider: null, domain: null } : {}) });
    for (const out of [g.html, g.text]) {
      assert.doesNotMatch(out, /<script|<link|<img|src=|supabase|SUPABASE|NEXT_PUBLIC|SECRET|process\.env|api[_-]?key/i, method);
      assert.doesNotMatch(out, /Stayful|£|\d+\s*%|\bpence\b/i, method);
      assert.doesNotMatch(out, /\b\d+ (days|months|weeks)\b/i, method);
    }
    // The only web addresses are the form's, the provider's help page and the SVG namespace-free page itself.
    const urls = (g.text.match(/https?:\/\/\S+/g) ?? []).map((u) => u.replace(/[.,]$/, ''));
    for (const u of urls) assert.ok(u === FORM || u === base.provider!.helpUrl, u);
  }
});
