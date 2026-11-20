/**
 * Batch 33: an in-memory DomainStore and DomainDeps for the tests (the
 * engine, the cron, the admin panel). It mirrors what the SQL does: the cap
 * counts claimed plus bought pence, a key claims once, a void claim frees its
 * money, one active domain per site and per name. Nothing in the app imports it.
 */
import { DEFAULT_DOMAINS, type DomainSettings } from './settings.ts';
import { createDomainEngine, StoreConflict, type DomainDeps, type DomainPatch, type DomainStore, type LiveEmailInput, type SiteFacts, type StoredOffer } from './purchase-server.ts';
import { FakeRegistrar } from './registrar/fake.ts';
import { FakeVercel } from './vercel-fake.ts';
import type { DomainRow, DomainStatus, SpendClaim } from './types.ts';

export interface SpendRow {
  domainId: string;
  kind: 'register' | 'renew';
  pence: number;
  status: 'claimed' | 'bought' | 'void';
  key: string;
  ref: string | null;
}

export class MemoryStore implements DomainStore {
  readonly sites = new Map<string, SiteFacts>();
  readonly offers = new Map<string, StoredOffer>();
  readonly domains = new Map<string, DomainRow>();
  readonly spend = new Map<string, SpendRow>();
  readonly charges: Array<{ owner: string; domain: string; period: string; pence: number }> = [];
  settingsNow: DomainSettings = { ...DEFAULT_DOMAINS };
  emails = new Map<string, string>();
  /** Every write, by name, so a dry run can be shown to have made none. */
  readonly writes: string[] = [];
  private seq = 0;
  clock: () => Date = () => new Date();

  addSite(s: Partial<SiteFacts> & { id: string }): SiteFacts {
    const site: SiteFacts = { userId: `user-${s.id}`, slug: `slug-${s.id}`, status: 'live', domain: null, company: 'Harbour Management Ltd', towns: ['Leeds'], ...s };
    this.sites.set(site.id, site);
    this.emails.set(site.userId, `${site.userId}@example.test`);
    return site;
  }

  async site(id: string) { return this.sites.get(id) ?? null; }
  async getOffer(id: string) { return this.offers.get(id) ?? null; }
  async saveOffer(id: string, o: { names: string[]; prices: Record<string, number> }) {
    this.writes.push('saveOffer');
    this.offers.set(id, { ...o, offeredAt: this.clock().toISOString() });
  }
  async domain(id: string) { return this.domains.get(id) ?? null; }
  async domainForSite(websiteId: string) {
    return [...this.domains.values()].find((d) => d.websiteId === websiteId && d.status !== 'released') ?? null;
  }

  private clash(name: string, websiteId: string, except?: string): boolean {
    return [...this.domains.values()].some((d) => d.id !== except && d.status !== 'released' && (d.name === name || d.websiteId === websiteId));
  }

  async insertDomain(r: { websiteId: string; ownerId: string; name: string; costPence: number }) {
    this.writes.push('insertDomain');
    if (this.clash(r.name, r.websiteId)) throw new StoreConflict();
    const now = this.clock().toISOString();
    const row: DomainRow = {
      id: `dom-${++this.seq}`, websiteId: r.websiteId, ownerId: r.ownerId, name: r.name, status: 'awaiting_admin', registrar: null, registrarRef: null,
      costPence: r.costPence, boughtAt: null, expiresAt: null, renewAllowed: true, renewDecision: null, renewDecidedBy: null, renewDecidedAt: null,
      dnsSetAt: null, vercelAddedAt: null, httpsOkAt: null, liveAt: null, attempts: 0, lastError: null, stuckAlertedAt: null, renewalAlertedFor: null,
      stateChangedAt: now, createdAt: now, updatedAt: now,
    };
    this.domains.set(row.id, row);
    return { ...row };
  }

  private tick = 0;

  async updateDomain(id: string, patch: DomainPatch, guard?: { from?: readonly DomainStatus[]; updatedAt?: string }) {
    const cur = this.domains.get(id);
    if (!cur) return null;
    if (guard?.from && !guard.from.includes(cur.status)) return null;
    if (guard?.updatedAt && guard.updatedAt !== cur.updatedAt) return null;
    this.writes.push(`updateDomain:${Object.keys(patch).join(',')}`);
    if (patch.name && patch.name !== cur.name && this.clash(patch.name, cur.websiteId, id)) throw new StoreConflict();
    const next: DomainRow = { ...cur, ...patch } as DomainRow;
    const now = this.clock();
    if (patch.status && patch.status !== cur.status) next.stateChangedAt = now.toISOString();
    // Always a new value, even inside the same millisecond: the optimistic lock needs it.
    next.updatedAt = new Date(now.getTime() + ++this.tick).toISOString();
    this.domains.set(id, next);
    return { ...next };
  }

  /** The SQL's cap: claimed plus bought pence for the day, plus this one, may not pass the cap. */
  async claimSpend(domainId: string, kind: 'register' | 'renew', pence: number, key: string): Promise<SpendClaim> {
    this.writes.push('claimSpend');
    const have = this.spend.get(key);
    if (have && have.status !== 'void') return 'already';
    const used = [...this.spend.values()].filter((s) => s.status !== 'void').reduce((n, s) => n + s.pence, 0);
    if (used + pence > this.settingsNow.dailySpendCapPence) return 'over_cap';
    this.spend.set(key, { domainId, kind, pence, status: 'claimed', key, ref: null });
    return 'claimed';
  }

  async settleSpend(key: string, status: 'bought' | 'void', ref?: string | null) {
    this.writes.push('settleSpend');
    const s = this.spend.get(key);
    if (!s || s.status !== 'claimed') return false;
    s.status = status;
    if (ref) s.ref = ref;
    return true;
  }

  async setSiteDomain(websiteId: string, name: string | null) {
    this.writes.push('setSiteDomain');
    const s = this.sites.get(websiteId);
    if (!s) return false;
    if (name && [...this.sites.values()].some((o) => o.id !== websiteId && o.domain === name)) return false;
    s.domain = name;
    return true;
  }

  async charge(a: { owner: string; domain: string; period: string; pence: number }) {
    this.writes.push('charge');
    if (this.charges.some((c) => c.domain === a.domain && c.period === a.period)) return { result: 'already_charged' as const };
    this.charges.push(a);
    return { result: 'charged' as const };
  }

  async settings() { return { ...this.settingsNow }; }
  async memberEmail(ownerId: string) { return this.emails.get(ownerId) ?? null; }
}

export interface Harness {
  store: MemoryStore;
  registrar: FakeRegistrar;
  vercel: FakeVercel;
  deps: DomainDeps;
  engine: ReturnType<typeof createDomainEngine>;
  sent: LiveEmailInput[];
  activity: Array<{ userId: string; kind: string; dedupeKey: string }>;
  probes: string[];
  /** What the probe answers: the page body, or 'down'. */
  page: { html: string | 'down'; status: number };
  setNow(d: Date): void;
  /** Make a site with a domain row chosen and ready to buy. */
  chosen(opts?: { auto?: boolean; company?: string }): Promise<{ siteId: string; domainId: string; name: string }>;
}

/** An engine wired to fakes. `NOW` starts at a fixed time and moves with setNow. */
export function harness(start = new Date('2026-11-20T12:00:00Z')): Harness {
  let now = start;
  const store = new MemoryStore();
  store.clock = () => now;
  const registrar = new FakeRegistrar();
  registrar.now = () => now;
  const vercel = new FakeVercel();
  const sent: LiveEmailInput[] = [];
  const activity: Harness['activity'] = [];
  const probes: string[] = [];
  const page: Harness['page'] = { html: '<h1>Harbour Management Ltd</h1>', status: 200 };
  const deps: DomainDeps = {
    store,
    registrar: () => registrar,
    vercel: () => vercel,
    ownerHandle: () => 'XX000001-XX',
    probe: async (url) => {
      probes.push(url);
      if (page.html === 'down') throw new Error('unreachable');
      return { status: page.status, html: page.html };
    },
    sendLiveEmail: async (i) => { sent.push(i); return true; },
    activity: async (userId, kind, o) => { activity.push({ userId, kind, dedupeKey: o.dedupeKey }); },
    now: () => now,
    appUrl: (p) => `https://app.example.test${p}`,
  };
  const engine = createDomainEngine(deps);
  let n = 0;
  return {
    store, registrar, vercel, deps, engine, sent, activity, probes, page,
    setNow: (d) => { now = d; },
    async chosen(opts = {}) {
      const siteId = `site-${++n}`;
      store.addSite({ id: siteId, company: opts.company ?? 'Harbour Management Ltd' });
      store.settingsNow.autoBuy = opts.auto ?? false;
      const offer = await engine.offerNames({ websiteId: siteId });
      if (!offer.ok) throw new Error(`offer failed: ${offer.reason}`);
      const name = offer.names[0];
      const r = await engine.chooseName({ websiteId: siteId, name });
      if (!r.ok || !r.domainId) throw new Error('choose failed');
      return { siteId, domainId: r.domainId, name };
    },
  };
}
