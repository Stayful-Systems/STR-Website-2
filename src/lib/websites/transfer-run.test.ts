import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeRegistrar } from '../domains/registrar/fake.ts';
import { RegistrarError } from '../domains/registrar/types.ts';
import type { EmailCopy } from '../email/new-lead.ts';
import { buildSitePages, type PageModel, type SiteSettings } from './page-model.ts';
import { SAMPLE_COPY, SAMPLE_SETTINGS } from './sample-site.ts';
import {
  ATTACH_LIMIT_BYTES,
  MAX_EXPORT_ATTEMPTS,
  alertStuck,
  buildExport,
  cancel,
  emailExport,
  endOverlap,
  endOverlapNow,
  markMoved,
  markTagChanged,
  pollDomain,
  requestDomain,
  retryExport,
  safeError,
  sendCode,
  startNewSetup,
  startTransfer,
  type ClaimColumn,
  type MailAttachment,
  type NewTransfer,
  type SendOutcome,
  type SiteState,
  type StartFacts,
  type TransferDeps,
  type TransferPatch,
  type TransferRow,
} from './transfer-run.ts';
import { DEFAULT_TRANSFER, type TransferSettings } from './transfer-settings.ts';
import { verifyTransferToken } from './transfer-token.ts';

// ── A fake world that counts every write, claim, send, fetch and registrar call ──

const KEY = 'test-signing-key-0123456789abcdef';
const BASE = 'https://app.example.test';
const ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const OTHER_OWNER = '33333333-3333-4333-8333-333333333333';
const WEBSITE = '44444444-4444-4444-8444-444444444444';
const DOMAIN_ID = '55555555-5555-4555-8555-555555555555';
const OWNER_EMAIL = 'owner.private@example.test';
const DOMAIN = 'harbour-private.co.uk';
const SIGNED = 'https://signed.example.test/zip?token=SECRET123';
const T0 = new Date('2026-11-21T10:00:00.000Z');
const days = (n: number, from = T0) => new Date(from.getTime() + n * 86400000);

const LOGO = 'https://abcd.supabase.co/storage/v1/object/public/logos/northern.png';
const SETTINGS: SiteSettings = { ...SAMPLE_SETTINGS, logoUrl: LOGO };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4]);
const CSS_URL = '/_next/static/chunks/app.css?dpl=dpl_abc';
const CSS_TEXT = '@font-face{font-family:Inter;src:url(../media/inter-s.p.woff2) format("woff2")}.hero{background:url("/_next/static/media/hero.png")}';

const pages = (): PageModel[] => buildSitePages({ site: { slug: 'northern-lets', domain: DOMAIN }, settings: SETTINGS, copy: SAMPLE_COPY });

/** What the export page sends for a page, in the parts the converter cares about. */
function fixtureHtml(page: PageModel, extraImage = ''): string {
  const link = (l: { href: string; label: string }) => `<a href="${l.href}">${l.label}</a>`;
  const sections = page.sections.map((s) => `<section id="${s.id}">${s.heading ? `<h2>${s.heading}</h2>` : ''}${s.paragraphs.map((p) => `<p>${p}</p>`).join('')}</section>`).join('');
  return [
    '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>',
    `<link rel="stylesheet" href="${CSS_URL}" data-precedence="next"/><script src="/_next/static/chunks/webpack.js" async=""></script>`,
    `<title>${page.title}</title><meta name="robots" content="noindex, nofollow"/></head><body>`,
    `<header><a href="${page.nav[0].href}"><img src="${LOGO}" alt=""/></a>${extraImage}<nav>${page.nav.map(link).join('')}${page.footer.map(link).join('')}</nav></header>`,
    `<main><h1>${page.heading}</h1>${sections}`,
    page.form ? `<section id="estimate"><div data-transfer-form="${page.key}"></div></section>` : '',
    '</main></body></html>',
  ].join('');
}

interface FetchSpy {
  urls: string[];
  failPages: boolean;
  extraImage: string;
}

class World {
  rows = new Map<string, TransferRow>();
  site: SiteState | null = { id: WEBSITE, ownerId: OWNER, status: 'live' };
  facts: StartFacts | null = null;
  unpaid = false;
  settings: TransferSettings = { ...DEFAULT_TRANSFER };
  now = T0;
  registrar = new FakeRegistrar();
  /** Writes: patches, claims, unclaims, inserts, renewal changes, pause, release, reset, uploads, removes. */
  writes = 0;
  sent: Array<{ to: string | 'admin'; copy: EmailCopy; key: string; attachments?: MailAttachment[] }> = [];
  logs: string[] = [];
  patches: TransferPatch[] = [];
  inserted: NewTransfer[] = [];
  startFactsCalls: string[] = [];
  unpaidCalls: string[] = [];
  blocked = 0;
  allowed = 0;
  paused = 0;
  released: Array<{ id: string; opts: unknown }> = [];
  resets = 0;
  uploads = new Map<string, Uint8Array>();
  removed: string[] = [];
  records: Array<{ userId: string; kind: string; dedupeKey: string }> = [];
  fetches: FetchSpy = { urls: [], failPages: false, extraImage: '' };
  ownerEmail: string | null = OWNER_EMAIL;
  ownerSendOutcome: SendOutcome = { sent: true };
  adminSendOk = true;
  pauseOk = true;
  releaseResult = { ok: true, outcome: 'released' };
  zipOverride: Uint8Array | null | undefined = undefined;
  linkOverride: string | null = SIGNED;
  claimDelay = false;

  constructor() {
    this.registrar.now = () => T0;
    this.registrar.owned.set(DOMAIN, { ref: 'fake-1', expiresAt: '2027-06-01T00:00:00.000Z', autoRenew: true });
  }

  add(over: Partial<TransferRow> = {}): TransferRow {
    const row: TransferRow = {
      id: ID,
      websiteId: WEBSITE,
      ownerId: OWNER,
      ref: '0123456789abcdef0123456789abcdef',
      providerKey: 'namecheap',
      providerName: 'Namecheap',
      ipsTag: 'NAMECHEAP-INC',
      method: 'tag',
      domainId: DOMAIN_ID,
      domainName: DOMAIN,
      snapshot: { companyName: 'Northern Lets', brandColour: '#0a96a0', email: 'hello@northernlets.test', phone: '0113 000 0000', logoUrl: LOGO },
      exportState: 'pending',
      exportPath: null,
      exportAttempts: 0,
      exportError: null,
      exportReadyAt: null,
      exportEmailedAt: null,
      domainState: 'pending',
      tagClaimedAt: null,
      domainRequestedAt: null,
      codeSentAt: null,
      domainMovedAt: null,
      stuckAlertedAt: null,
      movedEmailedAt: null,
      overlapEndsAt: days(30),
      overlapEndedAt: null,
      cancelledAt: null,
      cancelledBy: null,
      ...over,
    };
    this.rows.set(row.id, row);
    return row;
  }

  get row(): TransferRow {
    return this.rows.get(ID)!;
  }

  ownerMails(): Array<{ to: string; copy: EmailCopy; key: string; attachments?: MailAttachment[] }> {
    return this.sent.filter((s) => s.to !== 'admin') as Array<{ to: string; copy: EmailCopy; key: string; attachments?: MailAttachment[] }>;
  }
  adminMails(): Array<{ copy: EmailCopy; key: string }> {
    return this.sent.filter((s) => s.to === 'admin');
  }

  /** Every write, send, registrar write and fetch so far: a dry run must leave all of these where they were. */
  footprint(): string {
    return JSON.stringify([this.writes, this.sent.length, this.registrar.writeCalls(), this.fetches.urls.length, this.uploads.size, this.removed.length]);
  }

  deps(over: Partial<TransferDeps> = {}): TransferDeps {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const w = this;
    const claimable = (r: TransferRow, c: ClaimColumn) => r[c];
    const base: TransferDeps = {
      now: () => w.now,
      log: (line) => {
        w.logs.push(line);
      },
      settings: async () => w.settings,
      urls: () => ({ fetchBase: BASE, publicBase: BASE }),
      tokenKey: KEY,
      transfer: async (id) => {
        const r = w.rows.get(id);
        return r ? { ...r } : null;
      },
      startFacts: async (ownerId) => {
        w.startFactsCalls.push(ownerId);
        return w.facts;
      },
      unpaidDomain: async (ownerId) => {
        w.unpaidCalls.push(ownerId);
        return w.unpaid;
      },
      site: async () => (w.site ? { ...w.site } : null),
      ownerEmail: async () => w.ownerEmail,
      pages: async () => pages(),
      insertTransfer: async (row) => {
        w.writes += 1;
        if (w.facts?.hasOpenTransfer) return { ok: false, code: 'conflict' };
        w.inserted.push(row);
        const id = ID;
        w.add({ id, ownerId: row.ownerId, websiteId: row.websiteId, providerKey: row.providerKey, providerName: row.providerName, ipsTag: row.ipsTag, method: row.method, domainId: row.domainId, domainName: row.domainName, snapshot: row.snapshot, domainState: row.domainState, overlapEndsAt: row.overlapEndsAt });
        return { ok: true, id, ref: w.row.ref };
      },
      patch: async (id, fields) => {
        w.writes += 1;
        w.patches.push(fields);
        const r = w.rows.get(id);
        if (!r) return false;
        Object.assign(r, fields);
        return true;
      },
      claim: async (id, column, at) => {
        if (w.claimDelay) await new Promise((res) => setImmediate(res));
        const r = w.rows.get(id);
        if (!r || claimable(r, column)) return false;
        w.writes += 1;
        r[column] = at;
        return true;
      },
      unclaim: async (id, column) => {
        w.writes += 1;
        const r = w.rows.get(id);
        if (r) r[column] = null;
      },
      claimExportAttempt: async (id, expected, at) => {
        void at;
        const r = w.rows.get(id);
        if (!r || r.exportState !== 'pending' || r.exportAttempts !== expected) return false;
        w.writes += 1;
        r.exportAttempts = expected + 1;
        return true;
      },
      blockRenewal: async () => {
        w.writes += 1;
        w.blocked += 1;
        return true;
      },
      allowRenewal: async () => {
        w.writes += 1;
        w.allowed += 1;
        return true;
      },
      pauseSite: async (site) => {
        w.writes += 1;
        w.paused += 1;
        if (w.pauseOk) w.site = { ...site, status: 'paused' };
        return w.pauseOk;
      },
      releaseDomain: async (id, opts) => {
        w.writes += 1;
        w.released.push({ id, opts });
        return w.releaseResult;
      },
      resetSite: async () => {
        w.writes += 1;
        w.resets += 1;
        if (w.site) w.site = { ...w.site, status: 'setup' };
        return true;
      },
      registrar: () => w.registrar,
      storage: {
        upload: async (path, bytes) => {
          w.writes += 1;
          w.uploads.set(path, bytes);
        },
        download: async (path) => (w.zipOverride !== undefined ? w.zipOverride : (w.uploads.get(path) ?? null)),
        remove: async (path) => {
          w.writes += 1;
          w.removed.push(path);
        },
        signedUrl: async () => w.linkOverride,
      },
      fetch: async (url) => {
        w.fetches.urls.push(url);
        const u = new URL(url);
        const bytes = (b: Uint8Array) => new Response(Buffer.from(b), { status: 200 });
        if (u.pathname.startsWith('/t/export/')) {
          assert.ok(verifyTransferToken(u.pathname.split('/')[3], w.now, { key: KEY }), 'the export page is asked with a valid token');
          if (w.fetches.failPages) return new Response('no', { status: 500 });
          const rest = u.pathname.split('/').slice(4).join('/');
          const page = pages().find((p) => p.path === rest);
          return page ? new Response(fixtureHtml(page, w.fetches.extraImage), { status: 200 }) : new Response('no', { status: 404 });
        }
        if (u.pathname === '/_next/static/chunks/app.css') return new Response(CSS_TEXT, { status: 200 });
        if (u.pathname === '/_next/static/media/inter-s.p.woff2') return bytes(WOFF2);
        if (u.pathname === '/_next/static/media/hero.png' || url === LOGO) return bytes(PNG);
        return new Response('no', { status: 404 });
      },
      sendOwner: async (to, copy, opts) => {
        w.sent.push({ to, copy, key: opts.idempotencyKey, ...(opts.attachments ? { attachments: opts.attachments } : {}) });
        return w.ownerSendOutcome;
      },
      sendAdmin: async (copy, key) => {
        w.sent.push({ to: 'admin', copy, key });
        return w.adminSendOk;
      },
      record: async (userId, kind, opts) => {
        w.writes += 1;
        w.records.push({ userId, kind, dedupeKey: opts.dedupeKey });
      },
    };
    return { ...base, ...over };
  }
}

const START_FACTS = (over: Partial<StartFacts> = {}): StartFacts => ({
  websiteId: WEBSITE,
  ownerId: OWNER,
  status: 'live',
  deleted: false,
  pageCount: 7,
  hasOpenTransfer: false,
  settings: { companyName: 'Northern Lets', brandColour: '#0a96a0', contactEmail: 'hello@northernlets.test', contactPhone: '0113 000 0000', logoUrl: LOGO },
  domain: { id: DOMAIN_ID, name: DOMAIN, ready: true },
  ...over,
});

/** Any secret-looking thing that must never reach a log line. */
const CANARIES = [OWNER_EMAIL, DOMAIN, SIGNED, 'SECRET123', FakeRegistrar.TEST_TRANSFER_CODE, 'TYPED-CODE-4711', 'hello@northernlets.test', '0113 000 0000'];
function assertLogsClean(w: World): void {
  assert.ok(w.logs.length > 0, 'something was logged');
  for (const line of w.logs) {
    for (const c of CANARIES) assert.ok(!line.includes(c), `a log line holds ${c}: ${line}`);
    assert.ok(!/https?:\/\//i.test(line) && !line.includes('@'), `a log line holds an address: ${line}`);
  }
}

// ── startTransfer ──

test('start: the owner id is only the argument; the row, the unpaid check and the lookups all use it', async () => {
  const w = new World();
  w.facts = START_FACTS();
  const r = await startTransfer(w.deps(), OWNER, { providerKey: 'namecheap', tag: 'IGNORED', ownerId: OTHER_OWNER, owner_id: OTHER_OWNER } as never);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(w.startFactsCalls, [OWNER]);
  assert.deepEqual(w.unpaidCalls, [OWNER]);
  assert.equal(w.inserted.length, 1);
  assert.equal(w.inserted[0].ownerId, OWNER);
  assert.equal(w.records[0].userId, OWNER);
  assert.equal(r.method, 'tag');
});

test('start: a site that belongs to somebody else is refused as not_owner and nothing is written', async () => {
  const w = new World();
  w.facts = START_FACTS({ ownerId: OTHER_OWNER });
  const r = await startTransfer(w.deps(), OWNER, { providerKey: 'namecheap' });
  assert.deepEqual([r.ok, r.code], [false, 'not_owner']);
  assert.equal(w.writes, 0);
  assert.equal(w.sent.length, 0);
});

test('start: writes the snapshot keys, the overlap end, the renewal block, the admin email and the activity kind', async () => {
  const w = new World();
  w.facts = START_FACTS();
  const r = await startTransfer(w.deps(), OWNER, { providerKey: 'namecheap' });
  assert.equal(r.ok, true);
  const ins = w.inserted[0];
  assert.deepEqual(Object.keys(ins.snapshot).sort(), ['brandColour', 'companyName', 'email', 'logoUrl', 'phone']);
  assert.equal(ins.snapshot.companyName, 'Northern Lets');
  assert.equal(ins.snapshot.brandColour, '#0a96a0');
  assert.equal(ins.providerKey, 'namecheap');
  assert.equal(ins.ipsTag, 'NAMECHEAP-INC');
  assert.equal(ins.domainState, 'pending');
  assert.equal(ins.overlapEndsAt.getTime(), days(30).getTime());
  assert.equal(w.blocked, 1);
  assert.equal(w.adminMails().length, 1);
  assert.deepEqual(w.records, [{ userId: OWNER, kind: 'website_transfer_requested', dedupeKey: `website_transfer:${ID}` }]);
  assertLogsClean(w);
});

test('start: the method follows the date (tag before, code from), an own tag is checked, and no domain means files only', async () => {
  const w = new World();
  w.facts = START_FACTS();
  w.now = new Date('2027-02-09T00:00:00.000Z');
  const code = await startTransfer(w.deps(), OWNER, { providerKey: 'namecheap' });
  assert.equal(code.method, 'code');
  assert.equal(w.inserted[0].ipsTag, null);

  const w2 = new World();
  w2.facts = START_FACTS();
  assert.equal((await startTransfer(w2.deps(), OWNER, { providerKey: 'other', tag: 'not a tag!' })).code, 'bad_tag');
  assert.equal((await startTransfer(w2.deps(), OWNER, { providerKey: 'nope' })).code, 'unknown_provider');
  assert.equal(w2.writes, 0);
  const other = await startTransfer(w2.deps(), OWNER, { providerKey: 'other', tag: ' my-registrar ' });
  assert.equal(other.ok, true);
  assert.equal(w2.inserted[0].ipsTag, 'MY-REGISTRAR');

  const w3 = new World();
  w3.facts = START_FACTS({ domain: null });
  const files = await startTransfer(w3.deps(), OWNER, {});
  assert.equal(files.ok, true);
  assert.equal(files.method, 'none');
  assert.equal(w3.inserted[0].domainState, 'none');
  assert.equal(w3.inserted[0].domainId, null);
  assert.equal(w3.blocked, 0, 'no domain, nothing to stop renewing');
});

test('start: every refusal uses canStart\'s code and writes nothing; an unpaid owner is blocked', async () => {
  const cases: Array<[string, Partial<StartFacts>, boolean]> = [
    ['deleted', { deleted: true }, false],
    ['no_pages', { pageCount: 0 }, false],
    ['open_transfer', { hasOpenTransfer: true }, false],
    ['domain_not_ready', { domain: { id: DOMAIN_ID, name: DOMAIN, ready: false } }, false],
    ['unpaid_domain', {}, true],
  ];
  for (const [code, facts, unpaid] of cases) {
    const w = new World();
    w.facts = START_FACTS(facts);
    w.unpaid = unpaid;
    const r = await startTransfer(w.deps(), OWNER, { providerKey: 'namecheap' });
    assert.deepEqual([r.ok, r.code], [false, code]);
    assert.ok(r.message && r.message.length > 0);
    assert.equal(w.writes, 0, code);
    assert.equal(w.sent.length, 0, code);
  }
  const w = new World();
  assert.equal((await startTransfer(w.deps(), OWNER, {})).code, 'no_site');
});

test('start: a second open transfer racing in is refused by the database as open_transfer', async () => {
  const w = new World();
  w.facts = START_FACTS();
  const deps = w.deps({ insertTransfer: async () => ({ ok: false, code: 'conflict' }) });
  const r = await startTransfer(deps, OWNER, { providerKey: 'namecheap' });
  assert.deepEqual([r.ok, r.code], [false, 'open_transfer']);
  assert.equal(w.blocked, 0);
  assert.equal(w.sent.length, 0);
});

test('start: a dry run does every check and writes, sends and calls nothing', async () => {
  const w = new World();
  w.facts = START_FACTS();
  const before = w.footprint();
  const r = await startTransfer(w.deps(), OWNER, { providerKey: 'namecheap', dryRun: true });
  assert.deepEqual([r.ok, r.dryRun, r.code], [true, true, 'would_start']);
  assert.ok(r.plan && r.plan.length >= 4);
  assert.equal(w.footprint(), before);
  assert.equal(w.inserted.length, 0);
  assert.equal(w.blocked, 0);
  assert.equal(w.records.length, 0);
});

// ── requestDomain: the tag ──

test('tag: two concurrent runs call changeIpsTag exactly once and the move is requested', async () => {
  const w = new World();
  w.add();
  w.claimDelay = true;
  const [a, b] = await Promise.all([requestDomain(w.deps(), ID), requestDomain(w.deps(), ID)]);
  assert.equal(w.registrar.calls.changeIpsTag, 1);
  assert.equal(w.registrar.tags.get(DOMAIN), 'NAMECHEAP-INC');
  assert.deepEqual([a.code, b.code].sort(), ['claimed_elsewhere', 'requested']);
  assert.equal(w.row.domainState, 'requested');
  assert.ok(w.row.domainRequestedAt);
  assert.ok(w.row.tagClaimedAt);
  assert.equal((await requestDomain(w.deps(), ID)).code, 'not_pending');
  assert.equal(w.registrar.calls.changeIpsTag, 1);
  assertLogsClean(w);
});

test('tag: a refusal makes it a manual step with one admin email, and the call is never made again', async () => {
  const w = new World();
  w.add();
  w.registrar.failNext.set('changeIpsTag', 'refused');
  const r = await requestDomain(w.deps(), ID);
  assert.deepEqual([r.ok, r.code], [true, 'manual']);
  assert.equal(w.row.domainState, 'manual');
  assert.equal(w.adminMails().length, 1);
  assert.match(w.adminMails()[0].copy.subject, /Manual step/);
  await requestDomain(w.deps(), ID);
  await requestDomain(w.deps(), ID);
  assert.equal(w.registrar.calls.changeIpsTag, 1);
  assert.equal(w.adminMails().length, 1);
  assertLogsClean(w);
});

test('tag: an unclear answer is also manual (never retried blind); a registrar not set up gives the claim back', async () => {
  const w = new World();
  w.add();
  w.registrar.failNext.set('changeIpsTag', 'unclear');
  assert.equal((await requestDomain(w.deps(), ID)).code, 'manual');
  assert.equal(w.registrar.calls.changeIpsTag, 1);

  const w2 = new World();
  w2.add();
  const r = await requestDomain(w2.deps({ registrar: () => { throw new RegistrarError('not_configured'); } }), ID);
  assert.deepEqual([r.ok, r.code], [false, 'not_configured']);
  assert.equal(w2.row.tagClaimedAt, null);
  assert.equal(w2.row.domainState, 'pending');
  assert.equal((await requestDomain(w2.deps(), ID)).code, 'requested');
});

test('tag: nothing to request for no domain, a transfer that is not pending, or a closed one', async () => {
  const w = new World();
  w.add({ method: 'none', domainId: null, domainName: null, domainState: 'none' });
  assert.equal((await requestDomain(w.deps(), ID)).code, 'no_domain');
  const w2 = new World();
  w2.add({ cancelledAt: T0 });
  assert.equal((await requestDomain(w2.deps(), ID)).code, 'cancelled');
  assert.equal(w2.registrar.calls.changeIpsTag, 0);
});

// ── requestDomain: the code ──

test('code: the transfer code goes straight to the owner, never into a patch, a log line or an admin email', async () => {
  const w = new World();
  w.add({ method: 'code', ipsTag: null });
  const r = await requestDomain(w.deps(), ID);
  assert.deepEqual([r.ok, r.code], [true, 'requested']);
  assert.equal(w.registrar.calls.transferCode, 1);
  assert.equal(w.registrar.calls.changeIpsTag, 0);
  const mails = w.ownerMails();
  assert.equal(mails.length, 1);
  assert.ok(mails[0].copy.text.includes(FakeRegistrar.TEST_TRANSFER_CODE) && mails[0].copy.html.includes(FakeRegistrar.TEST_TRANSFER_CODE));
  assert.equal(mails[0].key, `website-transfer-code:${ID}`);
  assert.equal(w.row.domainState, 'requested');
  assert.ok(w.row.codeSentAt);
  assert.ok(!JSON.stringify(w.patches).includes(FakeRegistrar.TEST_TRANSFER_CODE));
  assert.ok(!JSON.stringify(w.row).includes(FakeRegistrar.TEST_TRANSFER_CODE));
  assert.ok(!JSON.stringify(r).includes(FakeRegistrar.TEST_TRANSFER_CODE));
  assertLogsClean(w);
});

test('code: two concurrent runs read and send the code once; a refusal is manual with an admin email', async () => {
  const w = new World();
  w.add({ method: 'code', ipsTag: null });
  w.claimDelay = true;
  await Promise.all([requestDomain(w.deps(), ID), requestDomain(w.deps(), ID)]);
  assert.equal(w.registrar.calls.transferCode, 1);
  assert.equal(w.ownerMails().length, 1);

  const w2 = new World();
  w2.add({ method: 'code', ipsTag: null });
  w2.registrar.failNext.set('transferCode', 'refused');
  const r = await requestDomain(w2.deps(), ID);
  assert.equal(r.code, 'manual');
  assert.equal(w2.row.domainState, 'manual');
  assert.equal(w2.ownerMails().length, 0);
  assert.equal(w2.adminMails().length, 1);
  assert.match(w2.adminMails()[0].copy.subject, /transfer code/);
  assertLogsClean(w2);
});

test('code: an email that did not go gives the claim back so the next run tries again', async () => {
  const w = new World();
  w.add({ method: 'code', ipsTag: null });
  w.ownerSendOutcome = { sent: false, reason: 'http_500' };
  const r = await requestDomain(w.deps(), ID);
  assert.deepEqual([r.ok, r.code], [false, 'http_500']);
  assert.equal(w.row.codeSentAt, null);
  assert.equal(w.row.domainState, 'pending');
  w.ownerSendOutcome = { sent: true };
  assert.equal((await requestDomain(w.deps(), ID)).code, 'requested');
});

// ── pollDomain ──

test('poll: a domain still ours stays requested; once info is null it is moved and the owner is emailed ONCE', async () => {
  const w = new World();
  w.add({ domainState: 'requested', domainRequestedAt: T0 });
  assert.equal((await pollDomain(w.deps(), ID)).code, 'still_ours');
  assert.equal(w.row.domainState, 'requested');
  w.registrar.owned.delete(DOMAIN);
  w.claimDelay = true;
  const rs = await Promise.all([pollDomain(w.deps(), ID), pollDomain(w.deps(), ID), pollDomain(w.deps(), ID)]);
  assert.ok(rs.every((r) => r.ok));
  assert.equal(w.row.domainState, 'moved');
  assert.ok(w.row.domainMovedAt);
  assert.equal(w.ownerMails().length, 1);
  assert.match(w.ownerMails()[0].copy.subject, /moved/);
  await pollDomain(w.deps(), ID);
  assert.equal(w.ownerMails().length, 1);
  assertLogsClean(w);
});

test('poll: a failed moved email gives its claim back and the next poll sends it', async () => {
  const w = new World();
  w.add({ domainState: 'requested', domainRequestedAt: T0 });
  w.registrar.owned.delete(DOMAIN);
  w.ownerSendOutcome = { sent: false, reason: 'http_500' };
  await pollDomain(w.deps(), ID);
  assert.equal(w.row.domainState, 'moved');
  assert.equal(w.row.movedEmailedAt, null);
  w.ownerSendOutcome = { sent: true };
  await pollDomain(w.deps(), ID);
  assert.ok(w.row.movedEmailedAt);
  assert.equal(w.ownerMails().length, 2);
  await pollDomain(w.deps(), ID);
  assert.equal(w.ownerMails().length, 2);
});

test('poll: a registrar error changes nothing and logs only a code', async () => {
  const w = new World();
  w.add({ domainState: 'requested', domainRequestedAt: T0 });
  const before = w.footprint();
  const r = await pollDomain(w.deps({ registrar: () => ({ info: async () => { throw new RegistrarError('unclear', 504); } }) as never }), ID);
  assert.deepEqual([r.ok, r.code], [false, 'registrar_error']);
  assert.equal(w.footprint(), before);
  assert.equal((await pollDomain(new World().deps(), ID)).code, 'not_found');
});

// ── alertStuck ──

test('stuck: not before the stuck days, then exactly one admin email', async () => {
  const w = new World();
  w.add({ domainState: 'requested', domainRequestedAt: T0 });
  w.now = days(5);
  assert.equal((await alertStuck(w.deps(), ID)).code, 'not_stuck');
  w.now = new Date(days(5).getTime() + 1);
  w.claimDelay = true;
  await Promise.all([alertStuck(w.deps(), ID), alertStuck(w.deps(), ID)]);
  assert.equal(w.adminMails().length, 1);
  assert.match(w.adminMails()[0].copy.subject, /stuck/i);
  assert.equal((await alertStuck(w.deps(), ID)).code, 'not_stuck');
  assert.equal(w.adminMails().length, 1);
});

test('stuck: an admin email that did not go gives the claim back; a moved transfer never alerts', async () => {
  const w = new World();
  w.add({ domainState: 'requested', domainRequestedAt: T0 });
  w.now = days(6);
  w.adminSendOk = false;
  assert.equal((await alertStuck(w.deps(), ID)).code, 'email_failed');
  assert.equal(w.row.stuckAlertedAt, null);
  w.adminSendOk = true;
  assert.equal((await alertStuck(w.deps(), ID)).code, 'alerted');
  const w2 = new World();
  w2.add({ domainState: 'moved', domainRequestedAt: T0 });
  w2.now = days(20);
  assert.equal((await alertStuck(w2.deps(), ID)).code, 'not_stuck');
});

// ── endOverlap ──

test('overlap: not before 30 days, not while the domain has not moved, then once, and it pauses the site', async () => {
  const w = new World();
  w.add({ domainState: 'moved', domainMovedAt: days(2), exportState: 'ready', exportPath: `${OWNER}/${ID}.zip` });
  w.now = new Date(days(30).getTime() - 1);
  assert.equal((await endOverlap(w.deps(), ID)).code, 'not_due');
  assert.equal(w.paused, 0);
  w.now = days(30);
  w.claimDelay = true;
  const rs = await Promise.all([endOverlap(w.deps(), ID), endOverlap(w.deps(), ID), endOverlap(w.deps(), ID)]);
  assert.equal(rs.filter((r) => r.code === 'ended').length, 1);
  assert.equal(w.paused, 1);
  assert.equal(w.site?.status, 'paused');
  assert.deepEqual(w.released, [{ id: DOMAIN_ID, opts: { registrar: false } }]);
  assert.deepEqual(w.removed, [`${OWNER}/${ID}.zip`]);
  assert.equal(w.row.exportPath, null);
  assert.ok(w.row.overlapEndedAt);
  assert.equal(w.registrar.writeCalls(), 0, 'the domain has left our account: no registrar call');
  assert.equal(w.sent.length, 0, 'no grace email, no warning, nothing');
  assert.equal((await endOverlap(w.deps(), ID)).code, 'ended');
  assert.equal(w.paused, 1);
  assert.equal(w.released.length, 1);
  assertLogsClean(w);
});

test('overlap: a domain still on its way holds the site; none, moved or forced lets it go', async () => {
  for (const state of ['pending', 'manual', 'requested'] as const) {
    const w = new World();
    w.add({ domainState: state });
    w.now = days(60);
    assert.equal((await endOverlap(w.deps(), ID)).code, 'not_due', state);
    assert.equal(w.paused + w.released.length, 0, state);
  }
  const none = new World();
  none.add({ method: 'none', domainId: null, domainName: null, domainState: 'none' });
  none.now = days(30);
  assert.equal((await endOverlap(none.deps(), ID)).code, 'ended');
  assert.equal(none.released.length, 0, 'no domain, nothing to release');
  assert.equal(none.paused, 1);

  const forced = new World();
  forced.add({ domainState: 'requested' });
  forced.now = days(3);
  const r = await endOverlapNow(forced.deps(), ID);
  assert.deepEqual([r.ok, r.code], [true, 'ended']);
  assert.equal(forced.paused, 1);
  assert.deepEqual(forced.released, [{ id: DOMAIN_ID, opts: { registrar: false } }]);
  assert.equal((await endOverlapNow(forced.deps(), ID)).code, 'ended');
  assert.equal(forced.paused, 1);
});

test('overlap: a site that is not live is not paused again; a pause that fails gives the claim back', async () => {
  const w = new World();
  w.add({ domainState: 'moved' });
  w.site = { id: WEBSITE, ownerId: OWNER, status: 'paused' };
  w.now = days(31);
  assert.equal((await endOverlap(w.deps(), ID)).code, 'ended');
  assert.equal(w.paused, 0);

  const w2 = new World();
  w2.add({ domainState: 'moved' });
  w2.now = days(31);
  w2.pauseOk = false;
  const r = await endOverlap(w2.deps(), ID);
  assert.deepEqual([r.ok, r.code], [false, 'pause_failed']);
  assert.equal(w2.row.overlapEndedAt, null);
  assert.equal(w2.released.length, 0);
  w2.pauseOk = true;
  assert.equal((await endOverlap(w2.deps(), ID)).code, 'ended');
});

test('overlap: a release that fails gives the claim back; an already released domain counts as done', async () => {
  const w = new World();
  w.add({ domainState: 'moved' });
  w.now = days(31);
  w.releaseResult = { ok: false, outcome: 'vercel_failed' };
  assert.equal((await endOverlap(w.deps(), ID)).code, 'release_failed');
  assert.equal(w.row.overlapEndedAt, null);
  w.releaseResult = { ok: false, outcome: 'bad_status' };
  assert.equal((await endOverlap(w.deps(), ID)).code, 'ended');
});

// ── buildExport ──

test('export: fetches every page with a valid token, converts, adds the guide, uploads the zip and stamps ready', async () => {
  const w = new World();
  w.add();
  const r = await buildExport(w.deps(), ID);
  assert.deepEqual([r.ok, r.code], [true, 'built']);
  assert.equal(w.row.exportState, 'ready');
  assert.equal(w.row.exportPath, `${OWNER}/${ID}.zip`);
  assert.ok(w.row.exportReadyAt);
  assert.equal(w.row.exportError, null);
  const zip = w.uploads.get(`${OWNER}/${ID}.zip`);
  assert.ok(zip && zip.length > 500);
  const text = Buffer.from(zip).toString('latin1');
  for (const name of ['index.html', 'fees.html', 'areas/leeds.html', 'GUIDE.html', 'assets/site.css', 'assets/form.css']) assert.ok(text.includes(name), name);
  const pageFetches = w.fetches.urls.filter((u) => u.includes('/t/export/'));
  assert.equal(pageFetches.length, pages().length);
  assert.ok(w.fetches.urls.includes(LOGO), 'the logo (another host, https) is fetched');
  assert.ok(w.fetches.urls.some((u) => u.endsWith('/_next/static/media/inter-s.p.woff2')), 'the font is fetched');
  assertLogsClean(w);
});

test('export: an address on a private host is never fetched; a missing image is left out, not fatal', async () => {
  const w = new World();
  w.add();
  w.fetches.extraImage = '<img src="http://169.254.169.254/latest/meta-data" alt=""/><img src="https://localhost/x.png" alt=""/><img src="https://abcd.supabase.co/missing.png" alt=""/>';
  const r = await buildExport(w.deps(), ID);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!w.fetches.urls.some((u) => u.includes('169.254') || u.includes('localhost')));
  assert.ok(w.fetches.urls.some((u) => u.endsWith('/missing.png')), 'a public https image is tried');
});

test('export: three failures mark it failed with ONE admin email and a code that holds no address', async () => {
  const w = new World();
  w.add();
  w.fetches.failPages = true;
  const first = await buildExport(w.deps(), ID);
  assert.deepEqual([first.ok, first.code], [false, 'retry']);
  assert.equal(w.row.exportState, 'pending');
  assert.equal(w.row.exportAttempts, 1);
  assert.equal(w.adminMails().length, 0);
  await buildExport(w.deps(), ID);
  const last = await buildExport(w.deps(), ID);
  assert.deepEqual([last.ok, last.code], [false, 'failed']);
  assert.equal(MAX_EXPORT_ATTEMPTS, 3);
  assert.equal(w.row.exportState, 'failed');
  assert.equal(w.row.exportAttempts, 3);
  assert.equal(w.adminMails().length, 1);
  assert.match(w.adminMails()[0].copy.subject, /export failed/i);
  assert.ok(w.row.exportError && w.row.exportError.length <= 200);
  assert.ok(!/https?:|@|\//.test(w.row.exportError ?? ''));
  assert.equal((await buildExport(w.deps(), ID)).code, 'failed');
  assert.equal(w.adminMails().length, 1);
  assertLogsClean(w);
});

test('export: two concurrent builds make one zip', async () => {
  const w = new World();
  w.add();
  const rs = await Promise.all([buildExport(w.deps(), ID), buildExport(w.deps(), ID)]);
  assert.deepEqual(rs.map((r) => r.code).sort(), ['built', 'claimed_elsewhere']);
  assert.equal(w.uploads.size, 1);
  assert.equal(w.row.exportAttempts, 1);
});

test('export: a bad token key means no export; safeError keeps a code to 200 characters with no address', async () => {
  const w = new World();
  w.add();
  const deps = w.deps();
  delete deps.tokenKey;
  const saved = [process.env.DEALS_PHOTO_SECRET, process.env.INTERNAL_API_SECRET];
  delete process.env.DEALS_PHOTO_SECRET;
  delete process.env.INTERNAL_API_SECRET;
  try {
    const r = await buildExport(deps, ID);
    assert.equal(r.ok, false);
    assert.equal(w.row.exportError, 'no_token');
    assert.equal(w.fetches.urls.length, 0);
  } finally {
    if (saved[0] !== undefined) process.env.DEALS_PHOTO_SECRET = saved[0];
    if (saved[1] !== undefined) process.env.INTERNAL_API_SECRET = saved[1];
  }
  assert.equal(safeError('https://x.test/a b@c'), 'https_x.test_a_b_c');
  assert.equal(safeError('x'.repeat(500)).length, 200);
});

// ── emailExport ──

const readyRow = (w: World, over: Partial<TransferRow> = {}) => w.add({ exportState: 'ready', exportPath: `${OWNER}/${ID}.zip`, exportReadyAt: T0, ...over });

test('email: a small zip is attached, direct, under the keyed idempotency, once', async () => {
  const w = new World();
  readyRow(w);
  w.uploads.set(`${OWNER}/${ID}.zip`, new Uint8Array(1000));
  w.claimDelay = true;
  const rs = await Promise.all([emailExport(w.deps(), ID), emailExport(w.deps(), ID)]);
  assert.deepEqual(rs.map((r) => r.code).sort(), ['claimed_elsewhere', 'emailed']);
  const mails = w.ownerMails();
  assert.equal(mails.length, 1);
  assert.equal(mails[0].key, `website-transfer-files:${ID}`);
  assert.equal(mails[0].to, OWNER_EMAIL);
  assert.equal(mails[0].attachments?.length, 1);
  assert.equal(mails[0].attachments?.[0].contentType, 'application/zip');
  assert.equal(mails[0].attachments?.[0].content.length, 1000);
  assert.ok(!mails[0].copy.text.includes(SIGNED), 'no link when it is attached');
  assert.match(mails[0].copy.text, /attached/);
  assert.equal(rs.find((r) => r.ok)?.detail, 'attached');
  assert.equal((await emailExport(w.deps(), ID)).code, 'already_emailed');
  assert.equal(w.ownerMails().length, 1);
  assertLogsClean(w);
});

test('email: a zip of 15 MB or more goes as a link only', async () => {
  const w = new World();
  readyRow(w);
  w.uploads.set(`${OWNER}/${ID}.zip`, new Uint8Array(ATTACH_LIMIT_BYTES));
  const r = await emailExport(w.deps(), ID);
  assert.equal(r.detail, 'link');
  const m = w.ownerMails()[0];
  assert.equal(m.attachments, undefined);
  assert.ok(m.copy.text.includes(SIGNED) && m.copy.html.includes('SECRET123'));
  assertLogsClean(w);

  const w2 = new World();
  readyRow(w2);
  w2.uploads.set(`${OWNER}/${ID}.zip`, new Uint8Array(ATTACH_LIMIT_BYTES - 1));
  assert.equal((await emailExport(w2.deps(), ID)).detail, 'attached');
});

test('email: nothing goes before the zip is ready; a send that fails gives the claim back; no link means no send', async () => {
  const w = new World();
  w.add();
  assert.equal((await emailExport(w.deps(), ID)).code, 'not_ready');
  const w2 = new World();
  readyRow(w2);
  w2.uploads.set(`${OWNER}/${ID}.zip`, new Uint8Array(10));
  w2.ownerSendOutcome = { sent: false, reason: 'http_500' };
  assert.equal((await emailExport(w2.deps(), ID)).code, 'http_500');
  assert.equal(w2.row.exportEmailedAt, null);
  w2.ownerSendOutcome = { sent: true };
  assert.equal((await emailExport(w2.deps(), ID)).code, 'emailed');

  const w3 = new World();
  readyRow(w3);
  w3.zipOverride = new Uint8Array(ATTACH_LIMIT_BYTES + 1);
  w3.linkOverride = null;
  assert.equal((await emailExport(w3.deps(), ID)).code, 'link_failed');
  assert.equal(w3.ownerMails().length, 0);
  assert.equal(w3.row.exportEmailedAt, null);
  const w4 = new World();
  readyRow(w4);
  w4.ownerEmail = null;
  assert.equal((await emailExport(w4.deps(), ID)).code, 'no_recipient');
  const w5 = new World();
  readyRow(w5);
  assert.equal((await emailExport(w5.deps(), ID)).code, 'zip_missing');
  assert.equal(w5.row.exportEmailedAt, null);
});

// ── Admin actions ──

test('retryExport: only a failed export, back to pending with its attempts given back', async () => {
  const w = new World();
  w.add({ exportState: 'failed', exportAttempts: 3, exportError: 'fetch_500' });
  const r = await retryExport(w.deps(), ID);
  assert.equal(r.code, 'retried');
  assert.deepEqual([w.row.exportState, w.row.exportAttempts, w.row.exportError], ['pending', 0, null]);
  assert.equal((await retryExport(w.deps(), ID)).code, 'not_failed');
});

test('markTagChanged: tracked as requested, and the automatic call is never made afterwards', async () => {
  const w = new World();
  w.add({ domainState: 'manual', tagClaimedAt: T0 });
  const r = await markTagChanged(w.deps(), ID);
  assert.equal(r.code, 'requested');
  assert.equal(w.row.domainState, 'requested');
  assert.ok(w.row.domainRequestedAt);
  assert.equal((await requestDomain(w.deps(), ID)).code, 'not_pending');
  assert.equal(w.registrar.calls.changeIpsTag, 0);
  const pending = new World();
  pending.add({ domainState: 'pending' });
  assert.equal((await markTagChanged(pending.deps(), ID)).code, 'requested');
  assert.ok(pending.row.tagClaimedAt, 'claimed, so the engine never calls changeIpsTag after the admin did');
  assert.equal((await requestDomain(pending.deps(), ID)).code, 'not_pending');
  assert.equal(pending.registrar.calls.changeIpsTag, 0);
  const code = new World();
  code.add({ method: 'code' });
  assert.equal((await markTagChanged(code.deps(), ID)).code, 'not_tag_method');
});

test('sendCode: the typed code is emailed to the owner and is not stored, logged, planned or returned', async () => {
  const w = new World();
  w.add({ method: 'code', ipsTag: null, domainState: 'manual' });
  const r = await sendCode(w.deps(), ID, '  TYPED-CODE-4711  ');
  assert.deepEqual([r.ok, r.code], [true, 'sent']);
  const mails = w.ownerMails();
  assert.equal(mails.length, 1);
  assert.ok(mails[0].copy.text.includes('TYPED-CODE-4711'));
  assert.equal(w.row.domainState, 'requested');
  assert.ok(w.row.codeSentAt && w.row.domainRequestedAt);
  assert.ok(!JSON.stringify(w.patches).includes('TYPED-CODE-4711'));
  assert.ok(!JSON.stringify(w.row).includes('TYPED-CODE-4711'));
  assert.ok(!JSON.stringify(r).includes('TYPED-CODE-4711'));
  assert.ok(!JSON.stringify(w.adminMails()).includes('TYPED-CODE-4711'));
  assertLogsClean(w);
  for (const bad of ['', '  ', 'ab', 'has space', 'x'.repeat(81), 42, null]) {
    assert.equal((await sendCode(w.deps(), ID, bad)).code, 'bad_code', String(bad));
  }
  w.ownerSendOutcome = { sent: false, reason: 'http_500' };
  assert.equal((await sendCode(w.deps(), ID, 'TYPED-CODE-4711')).code, 'http_500');
});

test('markMoved: moved, one email, and it works from a manual step; no domain refused', async () => {
  const w = new World();
  w.add({ domainState: 'manual' });
  assert.equal((await markMoved(w.deps(), ID)).code, 'moved');
  assert.equal(w.row.domainState, 'moved');
  assert.equal(w.ownerMails().length, 1);
  assert.equal((await markMoved(w.deps(), ID)).code, 'already_moved');
  assert.equal((await pollDomain(w.deps(), ID)).ok, true);
  assert.equal(w.ownerMails().length, 1);
  const none = new World();
  none.add({ method: 'none', domainId: null, domainName: null, domainState: 'none' });
  assert.equal((await markMoved(none.deps(), ID)).code, 'no_domain');
});

test('cancel: allows renewal again and deletes the zip; refused once the domain has moved or the overlap has ended', async () => {
  const w = new World();
  w.add({ domainState: 'requested', exportState: 'ready', exportPath: `${OWNER}/${ID}.zip` });
  const r = await cancel(w.deps(), ID, { by: OTHER_OWNER });
  assert.deepEqual([r.ok, r.code], [true, 'cancelled']);
  assert.equal(w.allowed, 1);
  assert.ok(w.row.cancelledAt);
  assert.equal(w.row.cancelledBy, OTHER_OWNER);
  assert.deepEqual(w.removed, [`${OWNER}/${ID}.zip`]);
  assert.equal((await cancel(w.deps(), ID)).code, 'cancelled');
  assert.equal(w.allowed, 1);

  const moved = new World();
  moved.add({ domainState: 'moved' });
  const refused = await cancel(moved.deps(), ID);
  assert.deepEqual([refused.ok, refused.code], [false, 'moved']);
  assert.equal(moved.row.cancelledAt, null);
  assert.equal(moved.allowed, 0);
  assert.equal(moved.writes, 0);

  const ended = new World();
  ended.add({ domainState: 'none', method: 'none', domainId: null, domainName: null, overlapEndedAt: T0 });
  assert.equal((await cancel(ended.deps(), ID)).code, 'ended');
});

test('cancel: if renewal cannot be allowed again the cancel is given back', async () => {
  const w = new World();
  w.add({ domainState: 'requested' });
  const r = await cancel(w.deps({ allowRenewal: async () => false }), ID);
  assert.deepEqual([r.ok, r.code], [false, 'renewal_failed']);
  assert.equal(w.row.cancelledAt, null);
});

test('startNewSetup: only after the overlap has ended; the site returns to setup', async () => {
  const w = new World();
  w.add();
  assert.equal((await startNewSetup(w.deps(), ID)).code, 'not_ended');
  const ended = new World();
  ended.add({ overlapEndedAt: T0 });
  ended.site = { id: WEBSITE, ownerId: OWNER, status: 'paused' };
  assert.equal((await startNewSetup(ended.deps(), ID)).code, 'reset');
  assert.equal(ended.resets, 1);
  assert.equal(ended.site?.status, 'setup');
  assert.equal((await startNewSetup(ended.deps(), ID)).code, 'already_setup');
  assert.equal(ended.resets, 1);
  const cancelled = new World();
  cancelled.add({ cancelledAt: T0 });
  assert.equal((await startNewSetup(cancelled.deps(), ID)).code, 'cancelled');
});

// ── Dry runs ──

test('every dry run writes nothing, sends nothing, fetches nothing and calls no registrar write', async () => {
  const cases: Array<[string, (w: World, o: { dryRun: true }) => Promise<unknown>, Partial<TransferRow>]> = [
    ['buildExport', (w, o) => buildExport(w.deps(), ID, o), {}],
    ['emailExport', (w, o) => emailExport(w.deps(), ID, o), { exportState: 'ready', exportPath: `${OWNER}/${ID}.zip` }],
    ['requestDomain tag', (w, o) => requestDomain(w.deps(), ID, o), {}],
    ['requestDomain code', (w, o) => requestDomain(w.deps(), ID, o), { method: 'code', ipsTag: null }],
    ['pollDomain', (w, o) => { w.registrar.owned.delete(DOMAIN); return pollDomain(w.deps(), ID, o); }, { domainState: 'requested', domainRequestedAt: T0 }],
    ['alertStuck', (w, o) => alertStuck(w.deps(), ID, o), { domainState: 'requested', domainRequestedAt: new Date(T0.getTime() - 30 * 86400000) }],
    ['endOverlap', (w, o) => endOverlap(w.deps(), ID, o), { domainState: 'moved', overlapEndsAt: new Date(T0.getTime() - 1000) }],
    ['retryExport', (w, o) => retryExport(w.deps(), ID, o), { exportState: 'failed', exportAttempts: 3 }],
    ['markTagChanged', (w, o) => markTagChanged(w.deps(), ID, o), { domainState: 'manual' }],
    ['sendCode', (w, o) => sendCode(w.deps(), ID, 'TYPED-CODE-4711', o), { method: 'code', ipsTag: null, domainState: 'manual' }],
    ['markMoved', (w, o) => markMoved(w.deps(), ID, o), { domainState: 'requested' }],
    ['cancel', (w, o) => cancel(w.deps(), ID, o), { domainState: 'requested', exportState: 'ready', exportPath: `${OWNER}/${ID}.zip` }],
    ['endOverlapNow', (w, o) => endOverlapNow(w.deps(), ID, o), { domainState: 'requested' }],
    ['startNewSetup', (w, o) => startNewSetup(w.deps(), ID, o), { overlapEndedAt: T0 }],
  ];
  for (const [name, run, over] of cases) {
    const w = new World();
    w.add(over);
    w.uploads.set(`${OWNER}/${ID}.zip`, new Uint8Array(10));
    const before = w.footprint();
    const snapshot = JSON.stringify(w.row);
    const r = (await run(w, { dryRun: true })) as { ok: boolean; dryRun: boolean; code: string; plan?: string[] };
    assert.equal(r.dryRun, true, name);
    assert.equal(r.ok, true, `${name}: ${JSON.stringify(r)}`);
    assert.ok(r.plan && r.plan.length > 0, name);
    assert.equal(w.footprint(), before, name);
    assert.equal(JSON.stringify(w.row), snapshot, `${name}: the row did not change`);
    assert.equal(w.registrar.writeCalls(), 0, name);
    assert.ok(!JSON.stringify(r).includes('TYPED-CODE-4711'), name);
    assert.equal(w.paused + w.released.length + w.resets + w.allowed + w.blocked, 0, name);
  }
});

// ── Logs ──

test('a full run through every step leaves no address, email, code or link in a single log line', async () => {
  const w = new World();
  w.facts = START_FACTS();
  assert.equal((await startTransfer(w.deps(), OWNER, { providerKey: 'namecheap' })).ok, true);
  assert.equal((await buildExport(w.deps(), ID)).ok, true);
  w.zipOverride = new Uint8Array(ATTACH_LIMIT_BYTES);
  assert.equal((await emailExport(w.deps(), ID)).ok, true);
  w.registrar.failNext.set('changeIpsTag', 'refused');
  assert.equal((await requestDomain(w.deps(), ID)).code, 'manual');
  assert.equal((await sendCode(w.deps(), ID, 'TYPED-CODE-4711')).ok, true);
  w.registrar.owned.delete(DOMAIN);
  assert.equal((await pollDomain(w.deps(), ID)).code, 'moved');
  w.now = days(31);
  assert.equal((await endOverlap(w.deps(), ID)).code, 'ended');
  assert.equal((await startNewSetup(w.deps(), ID)).code, 'reset');
  assertLogsClean(w);
  assert.ok(w.logs.every((l) => l.startsWith('[website-transfer] 11111111 ')), 'ids and codes only');
});
