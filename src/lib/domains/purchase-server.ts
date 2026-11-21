/**
 * Batch 33: the engine that buys, connects, renews and releases a customer
 * website's .co.uk domain. Every external thing is injected (DomainDeps: the
 * store, the registrar, Vercel, the page probe, the emails, the activity log,
 * the clock), so the tests run it with fakes and an in-memory store, and the
 * real wiring (store-server.ts: liveDomainEngine) is the only place a network
 * or a database is touched.
 *
 *   offerNames(site)      candidates -> bulk availability and price check -> stored offer
 *   chooseName(site,name) the name must be in the stored, fresh offer; row; auto-buy or awaiting admin
 *   buy(id)               ownership -> price re-check -> spend claim -> register -> connecting
 *   advance(id)           DNS -> Vercel (root, www 308) -> verified + HTTPS probe -> live
 *   release(id)           Vercel first (stop if it fails), clear websites.domain, auto-renew off
 *   renew(id)             claim -> registrar renew -> settle -> the yearly charge, only when ON
 *   blockRenewal(site)    Batch 36's hook: the site is switched off, do not auto-renew
 *
 * Rules every step keeps:
 *  - One spend claim per key (register:<id>, renew:<id>:<expiry>). Before ANY
 *    register call the registrar is asked whether the name is already ours; if
 *    it is, it is recorded as bought and register is not called. A timeout is
 *    `unclear`, never "taken": it leaves the claim and retries through that check.
 *  - The daily cap is the database's (website_domain_spend_claim): this file
 *    never decides it. A claim over the cap parks the domain as held_cap.
 *  - A name must have been OFFERED to this site (server-side, 24 hours), is
 *    re-checked just before buying, and a premium name or one over
 *    DOMAIN_MAX_PRICE_PENCE is refused.
 *  - The yearly charge is reachable from one function (chargeRenewal) that
 *    returns first when domain_charge_on is false, and never at registration:
 *    year 1 is free.
 *  - Every step is idempotent and resumes from the row's status and its three
 *    timestamps (dns_set_at, vercel_added_at, https_ok_at).
 *  - A dry run returns the steps and costs and writes and calls NOTHING: no
 *    store write, no registrar call, no Vercel call, no email.
 *  - What is stored about a failure is a code and an HTTP status, at most 200
 *    characters, with anything token-shaped removed. No header, body or
 *    credential is ever logged or stored.
 *
 * Pure of server-only and the network: injected, so the tests import it.
 */
import { siteAbsoluteUrl } from '../websites/urls.ts';
import { candidates, normaliseDomain, validCoUk } from './name.ts';
import { autoRenewRule, canChoose, chargeDecision, offerFresh, priceAllowed, renewalPeriod } from './policy.ts';
import { RegistrarError, type OwnedDomain, type Registrar } from './registrar/types.ts';
import type { DomainSettings } from './settings.ts';
import { DOMAIN_MAX_PRICE_PENCE, MAX_ATTEMPTS, type DomainChargeResult, type DomainRow, type DomainStatus, type RenewDecision, type SpendClaim } from './types.ts';
import { VercelError, type VercelDomains } from './vercel.ts';

// ── What the engine needs ──

/** The part of a website the engine works with. */
export interface SiteFacts {
  id: string;
  /** The account owner. */
  userId: string;
  slug: string;
  status: string;
  domain: string | null;
  company: string;
  /** The member's areas, for the town names. */
  towns: string[];
}

export interface StoredOffer {
  names: string[];
  /** name -> pence. */
  prices: Record<string, number>;
  offeredAt: string;
}

export interface DomainPatch {
  name?: string;
  status?: DomainStatus;
  registrar?: string | null;
  registrarRef?: string | null;
  costPence?: number | null;
  boughtAt?: string | null;
  expiresAt?: string | null;
  renewAllowed?: boolean;
  renewDecision?: RenewDecision | null;
  renewDecidedBy?: string | null;
  renewDecidedAt?: string | null;
  dnsSetAt?: string | null;
  vercelAddedAt?: string | null;
  httpsOkAt?: string | null;
  liveAt?: string | null;
  attempts?: number;
  lastError?: string | null;
  stuckAlertedAt?: string | null;
  renewalAlertedFor?: string | null;
  autoRenewAlertedFor?: string | null;
}

/** Thrown by the store when a unique index refuses a write (a name or a site already taken). */
export class StoreConflict extends Error {
  constructor() {
    super('store:conflict');
    this.name = 'StoreConflict';
  }
}

export interface DomainStore {
  site(websiteId: string): Promise<SiteFacts | null>;
  getOffer(websiteId: string): Promise<StoredOffer | null>;
  saveOffer(websiteId: string, offer: { names: string[]; prices: Record<string, number> }): Promise<void>;
  domain(id: string): Promise<DomainRow | null>;
  /** The site's domain row that is not released, or null. */
  domainForSite(websiteId: string): Promise<DomainRow | null>;
  /** Has this site ever had a domain released (so Stayful, not the member, decides whether it gets another)? */
  releasedBefore(websiteId: string): Promise<boolean>;
  /** A new row, awaiting_admin. Throws StoreConflict when the site or the name already has an active one. */
  insertDomain(row: { websiteId: string; ownerId: string; name: string; costPence: number }): Promise<DomainRow>;
  /**
   * Apply a patch only if the row still matches the guard (status in `from`, updated_at equal): the new row, or
   * null when it no longer matches. state_changed_at moves only when the status really changes. Throws StoreConflict on a unique clash.
   */
  updateDomain(id: string, patch: DomainPatch, guard?: { from?: readonly DomainStatus[]; updatedAt?: string }): Promise<DomainRow | null>;
  claimSpend(domainId: string, kind: 'register' | 'renew', pence: number, key: string): Promise<SpendClaim>;
  settleSpend(key: string, status: 'bought' | 'void', ref?: string | null): Promise<boolean>;
  /** websites.domain = name (or null). False when the site is gone or the name is another site's. */
  setSiteDomain(websiteId: string, name: string | null): Promise<boolean>;
  /** The one door to website_domain_charge. Only chargeRenewal calls it. */
  charge(args: { owner: string; domain: string; period: string; pence: number }): Promise<{ result: DomainChargeResult }>;
  settings(): Promise<DomainSettings>;
  memberEmail(ownerId: string): Promise<string | null>;
}

export interface LiveEmailInput {
  to: string;
  company: string;
  address: string;
  oldAddress: string;
  leadsUrl: string;
  /** Resend's idempotency key: domain-live:<domain id>. */
  key: string;
}

export interface DomainDeps {
  store: DomainStore;
  /** Throws RegistrarError('not_configured') when nothing is set up. */
  registrar: () => Registrar;
  /** Throws VercelError('not_configured') when nothing is set up. */
  vercel: () => VercelDomains;
  /** Stayful's owner handle at the registrar, or null. */
  ownerHandle: () => string | null;
  /** GET an address as the public would. Throws when it cannot be reached. */
  probe: (url: string) => Promise<{ status: number; html: string }>;
  /** True when the email went (or no email is configured); false when it failed and should be tried again. */
  sendLiveEmail: (i: LiveEmailInput) => Promise<boolean>;
  activity: (userId: string, kind: 'website_domain_chosen', opts: { dedupeKey: string; extras?: Record<string, string | number | boolean> }) => Promise<void>;
  now: () => Date;
  /** The app's absolute address for a path ("/leads"). */
  appUrl: (path: string) => string;
}

// ── Results ──

export interface StepPlan {
  step: string;
  detail: string;
}

export interface RunResult {
  ok: boolean;
  /** The domain's status after the run (before it, for a dry run). */
  status: DomainStatus | null;
  outcome: string;
  dryRun: boolean;
  steps?: StepPlan[];
  /** Pence the run would spend (a dry run) or did. */
  costPence?: number | null;
}

export interface RunOptions {
  dryRun?: boolean;
  /** An admin pressed it: Buy then ignores "auto-buy is off". */
  admin?: boolean;
  /** release only: false = the domain has left our registrar account (Batch 37), so setAutoRenew is skipped. */
  registrar?: boolean;
}

export type OfferResult =
  | { ok: true; names: string[]; prices: Record<string, number>; fresh: boolean; dryRun: boolean }
  | { ok: false; reason: 'no_site' | 'not_configured' | 'no_names' | 'unavailable' };

export type ChooseReason = 'no_site' | 'not_live' | 'bad_name' | 'not_offered' | 'offer_expired' | 'cannot_choose' | 'conflict';
export type ChooseResult =
  | { ok: true; domainId: string | null; status: DomainStatus; outcome: string; dryRun: boolean }
  | { ok: false; reason: ChooseReason };

// ── Small helpers ──

const iso = (d: Date) => d.toISOString();

/** A failure as stored: a code and an HTTP status, 200 characters at most, nothing token-shaped. */
export function errorText(e: unknown): string {
  const raw = e instanceof RegistrarError || e instanceof VercelError ? e.message : e instanceof StoreConflict ? 'conflict' : 'error';
  return raw.replace(/[A-Za-z0-9_-]{24,}/g, '…').slice(0, 200);
}

function pounds(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

const spendKey = (id: string) => `register:${id}`;
const renewKey = (id: string, expiresAt: string) => `renew:${id}:${renewalPeriod(expiresAt)}`;

function result(row: Pick<DomainRow, 'status'> | null, outcome: string, ok: boolean, extra: Partial<RunResult> = {}): RunResult {
  return { ok, status: row?.status ?? null, outcome, dryRun: false, ...extra };
}

/** The year a renewal pays for: registration is year 1, the first renewal year 2. */
export function renewalYear(boughtAt: string | null, expiresAt: string): number {
  if (!boughtAt) return 2;
  const next = new Date(expiresAt).getTime() + 365.25 * 86_400_000;
  const years = Math.round((next - new Date(boughtAt).getTime()) / (365.25 * 86_400_000));
  return Math.max(2, years);
}

// ── The engine ──

export function createDomainEngine(deps: DomainDeps) {
  const { store } = deps;

  /** A step failed in a way that may pass: store the code, count the attempt, and after the third give up (admin Retry). */
  async function recordFailure(row: DomainRow, e: unknown, keepStatus: DomainStatus): Promise<RunResult> {
    const attempts = row.attempts + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    const next = await store.updateDomain(row.id, { attempts, lastError: errorText(e), status: failed ? 'failed' : keepStatus });
    return result(next ?? row, failed ? 'failed' : 'retry_later', false);
  }

  /** The name went before it was bought: nothing spent, the member picks again from fresh names. */
  async function needsChoice(row: DomainRow, reason: string): Promise<RunResult> {
    const next = await store.updateDomain(row.id, { status: 'needs_choice', lastError: reason, attempts: 0 });
    try {
      await offerNames({ websiteId: row.websiteId }, { refresh: true });
    } catch {
      // The member sees "choose again" and gets fresh names the next time the picker loads.
    }
    return result(next ?? row, 'needs_choice', true);
  }

  // ── Offers ──

  async function offerNames(input: { websiteId: string }, opts: { refresh?: boolean; dryRun?: boolean } = {}): Promise<OfferResult> {
    const site = await store.site(input.websiteId);
    if (!site) return { ok: false, reason: 'no_site' };
    const wanted = candidates(site.company, site.towns);
    if (wanted.length === 0) return { ok: false, reason: 'no_names' };
    if (opts.dryRun) return { ok: true, names: wanted, prices: {}, fresh: false, dryRun: true };

    const existing = await store.getOffer(input.websiteId);
    if (!opts.refresh && existing && existing.names.length > 0 && offerFresh(existing.offeredAt, deps.now())) {
      return { ok: true, names: existing.names, prices: existing.prices, fresh: false, dryRun: false };
    }
    let reg: Registrar;
    try {
      reg = deps.registrar();
    } catch {
      return { ok: false, reason: 'not_configured' };
    }
    let checked;
    try {
      checked = await reg.check(wanted);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    // Only what we asked about, available, not premium, a price we would pay; in our order.
    const byName = new Map(checked.map((a) => [a.name, a]));
    const prices: Record<string, number> = {};
    const names: string[] = [];
    for (const name of wanted) {
      const a = byName.get(name);
      if (!a || !a.available || a.premium || !validCoUk(name) || !priceAllowed(a.pricePence, DOMAIN_MAX_PRICE_PENCE)) continue;
      names.push(name);
      prices[name] = a.pricePence;
    }
    if (names.length === 0) return { ok: false, reason: 'no_names' };
    await store.saveOffer(input.websiteId, { names, prices });
    return { ok: true, names, prices, fresh: true, dryRun: false };
  }

  // ── Choosing ──

  async function chooseName(input: { websiteId: string; name: string }, opts: { dryRun?: boolean } = {}): Promise<ChooseResult> {
    const site = await store.site(input.websiteId);
    if (!site) return { ok: false, reason: 'no_site' };
    if (site.status !== 'live') return { ok: false, reason: 'not_live' };
    const name = normaliseDomain(input.name);
    if (!validCoUk(name)) return { ok: false, reason: 'bad_name' };
    const offer = await store.getOffer(input.websiteId);
    if (!offer || !offer.names.includes(name)) return { ok: false, reason: 'not_offered' };
    if (!offerFresh(offer.offeredAt, deps.now())) return { ok: false, reason: 'offer_expired' };
    const price = offer.prices[name];
    if (!priceAllowed(price, DOMAIN_MAX_PRICE_PENCE)) return { ok: false, reason: 'not_offered' };
    const existing = await store.domainForSite(input.websiteId);
    if (!canChoose(existing)) return { ok: false, reason: 'cannot_choose' };
    // A domain the admin released is not replaced by the member's own click: that is the admin's call.
    if (!existing && (await store.releasedBefore(input.websiteId))) return { ok: false, reason: 'cannot_choose' };

    const settings = await store.settings();
    if (opts.dryRun) return { ok: true, domainId: existing?.id ?? null, status: 'awaiting_admin', outcome: settings.autoBuy ? 'would_buy' : 'would_wait_for_admin', dryRun: true };

    let row: DomainRow | null;
    try {
      row = existing
        ? await store.updateDomain(existing.id, { name, status: 'awaiting_admin', costPence: price, attempts: 0, lastError: null, stuckAlertedAt: null }, { from: ['needs_choice'], updatedAt: existing.updatedAt })
        : await store.insertDomain({ websiteId: site.id, ownerId: site.userId, name, costPence: price });
    } catch (e) {
      if (e instanceof StoreConflict) return { ok: false, reason: 'conflict' };
      throw e;
    }
    if (!row) return { ok: false, reason: 'conflict' };

    await deps.activity(site.userId, 'website_domain_chosen', { dedupeKey: `website_domain_chosen:${site.id}`, extras: { website: true } });

    if (!settings.autoBuy) return { ok: true, domainId: row.id, status: row.status, outcome: 'awaiting_admin', dryRun: false };
    const bought = await buy(row.id, {});
    return { ok: true, domainId: row.id, status: bought.status ?? row.status, outcome: bought.outcome, dryRun: false };
  }

  // ── Buying ──

  const BUYABLE: readonly DomainStatus[] = ['awaiting_admin', 'held_cap', 'registering', 'failed'];

  /** The registrar already holds it for us: record it as bought and move on. register is NOT called. */
  async function adopt(row: DomainRow, owned: OwnedDomain, reg: Registrar): Promise<RunResult> {
    await store.settleSpend(spendKey(row.id), 'bought', owned.ref);
    if (owned.autoRenew === true) {
      try {
        await reg.setAutoRenew(row.name, false);
      } catch {
        // Not fatal: the renewal list and the 7-day rule still decide what happens at expiry.
      }
    }
    const next = await store.updateDomain(row.id, {
      status: 'connecting',
      registrar: reg.id,
      registrarRef: owned.ref,
      boughtAt: row.boughtAt ?? iso(deps.now()),
      expiresAt: owned.expiresAt,
      attempts: 0,
      lastError: null,
    });
    return result(next ?? row, 'already_owned', true);
  }

  async function buy(id: string, opts: RunOptions = {}): Promise<RunResult> {
    const row = await store.domain(id);
    if (!row) return result(null, 'not_found', false);
    if (!BUYABLE.includes(row.status)) return result(row, 'bad_status', false);
    const settings = await store.settings();
    if (row.status === 'awaiting_admin' && !settings.autoBuy && !opts.admin) return result(row, 'waiting_admin', true);

    if (opts.dryRun) {
      return {
        ok: true,
        status: row.status,
        outcome: 'dry_run',
        dryRun: true,
        costPence: row.costPence,
        steps: [
          { step: 'Check', detail: `Ask the registrar whether Stayful already owns ${row.name}; if it does, record it as bought and do not buy it again.` },
          { step: 'Price', detail: `Re-check ${row.name} is still free, not a premium name, and costs no more than ${pounds(DOMAIN_MAX_PRICE_PENCE)}${row.costPence ? ` (offered at ${pounds(row.costPence)})` : ''}.` },
          { step: 'Spend', detail: `Claim the price against today's cap of ${pounds(settings.dailySpendCapPence)}; over the cap, hold it until the next UK day.` },
          { step: 'Register', detail: 'Register for one year, auto-renew off, owned by Stayful. The first year is free to the member.' },
          { step: 'Connect', detail: 'Then set DNS, add it to Vercel, check HTTPS and go live (every 15 minutes).' },
        ],
      };
    }

    let reg: Registrar;
    let handle: string | null;
    try {
      reg = deps.registrar();
      handle = deps.ownerHandle();
      if (!handle) throw new RegistrarError('not_configured');
    } catch {
      return result(row, 'not_configured', false);
    }

    // 1. Is it already ours? (A registration whose answer we never saw.) Then it is bought; never register again.
    try {
      const owned = await reg.findOwned(row.name);
      if (owned) return await adopt(row, owned, reg);
    } catch (e) {
      return recordFailure(row, e, row.status === 'failed' ? 'registering' : row.status);
    }

    // 2. Price and availability, right now. Gone, premium or too dear: no money spent, the member picks again.
    let price: number;
    try {
      const [a] = await reg.check([row.name]);
      if (!a || !a.available) return await needsChoice(row, 'taken');
      if (a.premium || !priceAllowed(a.pricePence, DOMAIN_MAX_PRICE_PENCE)) return await needsChoice(row, 'price');
      price = a.pricePence;
    } catch (e) {
      return recordFailure(row, e, row.status === 'failed' ? 'registering' : row.status);
    }

    // 3. The money. The cap is the database's.
    const key = spendKey(row.id);
    const claim = await store.claimSpend(row.id, 'register', price, key);
    if (claim === 'over_cap') {
      const held = await store.updateDomain(row.id, { status: 'held_cap', lastError: 'over_cap' });
      return result(held ?? row, 'held_cap', true, { costPence: price });
    }

    // 4. Take the row, so two runners cannot both register. The loser stops here (the claim is the same key: counted once).
    const taken = await store.updateDomain(row.id, { status: 'registering', costPence: price, lastError: null }, { from: BUYABLE, updatedAt: row.updatedAt });
    if (!taken) return result(await store.domain(id), 'busy', true);

    // 5. Register. A timeout is unclear: the claim stays and the retry goes back through step 1.
    try {
      const done = await reg.register(row.name, { ownerHandle: handle });
      await store.settleSpend(key, 'bought', done.ref);
      const next = await store.updateDomain(row.id, {
        status: 'connecting',
        registrar: reg.id,
        registrarRef: done.ref,
        costPence: price,
        boughtAt: iso(deps.now()),
        expiresAt: done.expiresAt,
        attempts: 0,
        lastError: null,
      });
      return result(next ?? taken, 'registered', true, { costPence: price });
    } catch (e) {
      if (e instanceof RegistrarError && e.code === 'taken') {
        await store.settleSpend(key, 'void');
        return needsChoice(taken, 'taken');
      }
      if (e instanceof RegistrarError && e.code === 'refused') {
        await store.settleSpend(key, 'void');
        return recordFailure(taken, e, 'registering');
      }
      return recordFailure(taken, e, 'registering');
    }
  }

  // ── Connecting ──

  /** Does the page at the new address belong to this site (200, with the company's name)? */
  function pageIsOurs(html: string, company: string): boolean {
    const name = company.trim();
    if (!name) return html.length > 0;
    const esc = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    return html.includes(name) || html.includes(esc);
  }

  async function emailLive(row: DomainRow, site: SiteFacts): Promise<boolean> {
    const to = await store.memberEmail(row.ownerId);
    if (!to) return true; // No address to write to: nothing to retry.
    return deps.sendLiveEmail({
      to,
      company: site.company,
      address: `https://${row.name}/`,
      // The old address, whatever the site has now: the temporary one.
      oldAddress: siteAbsoluteUrl({ slug: site.slug }),
      leadsUrl: deps.appUrl('/leads'),
      key: `domain-live:${row.id}`,
    });
  }

  async function advance(id: string, opts: RunOptions = {}): Promise<RunResult> {
    const row = await store.domain(id);
    if (!row) return result(null, 'not_found', false);
    if (row.status !== 'connecting') return result(row, 'bad_status', false);

    if (opts.dryRun) {
      const steps: StepPlan[] = [];
      if (!row.dnsSetAt) steps.push({ step: 'DNS', detail: `Read Vercel's recommended values and set the A record at the root and a CNAME for www on ${row.name}.` });
      if (!row.vercelAddedAt) steps.push({ step: 'Vercel', detail: `Add ${row.name} to the project, then www.${row.name} as a 308 redirect to it.` });
      if (!row.httpsOkAt) steps.push({ step: 'HTTPS', detail: `Wait for Vercel to show ${row.name} set up and verified, then fetch https://${row.name}/ and expect 200 with the company name.` });
      steps.push({ step: 'Live', detail: `Set the website's address to ${row.name}, mark it live and email the member once.` });
      return { ok: true, status: row.status, outcome: 'dry_run', dryRun: true, steps };
    }

    let reg: Registrar;
    let vercel: VercelDomains;
    try {
      reg = deps.registrar();
      vercel = deps.vercel();
    } catch {
      return result(row, 'not_configured', false);
    }
    const site = await store.site(row.websiteId);
    if (!site) return result(row, 'no_site', false);

    let cur = row;
    const waiting = async (why: string): Promise<RunResult> => {
      const next = await store.updateDomain(cur.id, { lastError: `waiting: ${why}` });
      return result(next ?? cur, 'waiting', true);
    };

    try {
      if (!cur.dnsSetAt) {
        const cfg = await vercel.domainConfig(cur.name);
        const ip = cfg.recommendedIPv4[0];
        const cname = cfg.recommendedCNAME;
        if (!ip || !cname) throw new VercelError('unclear');
        await reg.setDns(cur.name, [
          { type: 'A', host: '@', value: ip },
          { type: 'CNAME', host: 'www', value: cname },
        ]);
        cur = (await store.updateDomain(cur.id, { dnsSetAt: iso(deps.now()), lastError: null })) ?? cur;
      }
      if (!cur.vercelAddedAt) {
        await vercel.addDomain(cur.name);
        await vercel.addWwwRedirect(cur.name);
        cur = (await store.updateDomain(cur.id, { vercelAddedAt: iso(deps.now()), lastError: null })) ?? cur;
      }
      if (!cur.httpsOkAt) {
        const cfg = await vercel.domainConfig(cur.name);
        if (cfg.misconfigured) return await waiting('DNS is not pointing here yet');
        if (!(await vercel.domainVerified(cur.name))) return await waiting('Vercel has not verified the domain yet');
        let page: { status: number; html: string };
        try {
          page = await deps.probe(`https://${cur.name}/`);
        } catch {
          return await waiting('HTTPS is not answering yet');
        }
        if (page.status !== 200 || !pageIsOurs(page.html, site.company)) return await waiting('the address is not showing the website yet');
        cur = (await store.updateDomain(cur.id, { httpsOkAt: iso(deps.now()), lastError: null, attempts: 0 })) ?? cur;
      }
    } catch (e) {
      return recordFailure(cur, e, 'connecting');
    }

    // Live: the site's address first, then the status, then the email (once).
    const moved = await store.setSiteDomain(cur.websiteId, cur.name);
    if (!moved) return recordFailure(cur, new StoreConflict(), 'connecting');
    const live = await store.updateDomain(cur.id, { status: 'live', liveAt: iso(deps.now()), attempts: 0, lastError: null }, { from: ['connecting'] });
    if (!live) return result(await store.domain(id), 'busy', true);
    const sent = await emailLive(live, site).catch(() => false);
    if (!sent) {
      const flagged = await store.updateDomain(live.id, { lastError: 'email_not_sent' });
      return result(flagged ?? live, 'live', true);
    }
    return result(live, 'live', true);
  }

  /** The member's live email did not go: try again (the Resend key makes a second try safe). Clears the flag when it is sent. */
  async function resendLiveEmail(id: string): Promise<RunResult> {
    const row = await store.domain(id);
    if (!row || row.status !== 'live' || row.lastError !== 'email_not_sent') return result(row, 'nothing_to_send', true);
    const site = await store.site(row.websiteId);
    if (!site) return result(row, 'no_site', false);
    const sent = await emailLive(row, site).catch(() => false);
    if (!sent) return result(row, 'email_not_sent', false);
    const next = await store.updateDomain(row.id, { lastError: null });
    return result(next ?? row, 'email_sent', true);
  }

  // ── Retrying (the admin's Retry on a failed domain) ──

  /**
   * A failed domain tried again by hand: if it was already bought, back to connecting and on; if the purchase itself
   * failed, the purchase again (ownership first, as always).
   */
  async function retry(id: string, opts: RunOptions = {}): Promise<RunResult> {
    const row = await store.domain(id);
    if (!row) return result(null, 'not_found', false);
    if (row.status !== 'failed') return result(row, 'bad_status', false);
    const bought = Boolean(row.boughtAt || row.registrarRef);
    if (opts.dryRun) {
      const inner = bought ? await advance(id, { dryRun: true }).catch(() => null) : null;
      return {
        ok: true,
        status: row.status,
        outcome: 'dry_run',
        dryRun: true,
        costPence: bought ? null : row.costPence,
        steps: bought
          ? [{ step: 'Reset', detail: `${row.name} was already bought: put it back to connecting and clear the error.` }, ...((await inner)?.steps ?? [])]
          : [{ step: 'Buy again', detail: `The purchase of ${row.name} failed. Ask the registrar whether Stayful already owns it, then buy it (the spend claim is reused, never doubled).` }],
      };
    }
    if (!bought) return buy(id, { admin: true });
    const back = await store.updateDomain(id, { status: 'connecting', attempts: 0, lastError: null }, { from: ['failed'], updatedAt: row.updatedAt });
    if (!back) return result(await store.domain(id), 'busy', true);
    return advance(id);
  }

  // ── Releasing ──

  const RELEASABLE: readonly DomainStatus[] = ['awaiting_admin', 'held_cap', 'needs_choice', 'connecting', 'live', 'failed', 'releasing'];

  async function release(id: string, opts: RunOptions = {}): Promise<RunResult> {
    const row = await store.domain(id);
    if (!row) return result(null, 'not_found', false);
    if (!RELEASABLE.includes(row.status)) return result(row, 'bad_status', false);
    const bought = row.status !== 'awaiting_admin' && row.status !== 'held_cap' && row.status !== 'needs_choice' && Boolean(row.registrarRef || row.boughtAt || row.vercelAddedAt || row.dnsSetAt);

    if (opts.dryRun) {
      const steps: StepPlan[] = bought
        ? [
            { step: 'Vercel', detail: `Remove www.${row.name}, then ${row.name}, from the project (already gone counts as done). If Vercel refuses, stop: the registrar is not touched.` },
            { step: 'Website', detail: "Clear the website's own address; its /s/<slug> address works again." },
            { step: 'Registrar', detail: opts.registrar === false ? 'The domain has left our account: no registrar call.' : `Turn auto-renew off. ${row.name} stays Stayful's until it expires: a .co.uk cannot be refunded.` },
            { step: 'Done', detail: 'Mark the domain released.' },
          ]
        : [{ step: 'Cancel', detail: `Nothing was bought for ${row.name}: mark it released.` }];
      return { ok: true, status: row.status, outcome: 'dry_run', dryRun: true, steps };
    }

    if (!bought) {
      const done = await store.updateDomain(row.id, { status: 'released', lastError: null }, { from: RELEASABLE });
      return result(done ?? row, 'released', true);
    }

    let reg: Registrar | null = null;
    let vercel: VercelDomains;
    try {
      if (opts.registrar !== false) reg = deps.registrar();
      vercel = deps.vercel();
    } catch {
      return result(row, 'not_configured', false);
    }

    const releasing = row.status === 'releasing' ? row : ((await store.updateDomain(row.id, { status: 'releasing', lastError: null }, { from: RELEASABLE })) ?? row);
    try {
      await vercel.removeDomain(`www.${row.name}`);
      await vercel.removeDomain(row.name);
    } catch (e) {
      // Vercel failed: stop. The registrar is not touched.
      const stopped = await store.updateDomain(row.id, { lastError: errorText(e) });
      return result(stopped ?? releasing, 'vercel_failed', false);
    }
    await store.setSiteDomain(row.websiteId, null);
    try {
      if (reg) await reg.setAutoRenew(row.name, false);
    } catch (e) {
      const stopped = await store.updateDomain(row.id, { lastError: errorText(e) });
      return result(stopped ?? releasing, 'registrar_failed', false);
    }
    const done = await store.updateDomain(row.id, { status: 'released', lastError: null });
    return result(done ?? releasing, 'released', true);
  }

  // ── Renewing ──

  /**
   * The yearly charge, and the ONLY place store.charge is called. It returns
   * before anything else when domain_charge_on is false, and never for year 1.
   */
  async function chargeRenewal(row: DomainRow, year: number, pence: number): Promise<'off' | 'year_one' | DomainChargeResult> {
    const settings = await store.settings();
    if (!settings.chargeOn) return 'off';
    const verdict = chargeDecision({ chargeOn: settings.chargeOn, year });
    if (verdict !== 'charge' || !row.expiresAt) return 'year_one';
    const r = await store.charge({ owner: row.ownerId, domain: row.id, period: renewalPeriod(row.expiresAt), pence });
    return r.result;
  }

  async function renew(id: string, opts: RunOptions = {}): Promise<RunResult> {
    const row = await store.domain(id);
    if (!row) return result(null, 'not_found', false);
    if (row.status !== 'live' || !row.expiresAt) return result(row, 'bad_status', false);
    const pence = row.costPence;
    if (!priceAllowed(pence, DOMAIN_MAX_PRICE_PENCE)) return result(row, 'no_price', false);

    if (opts.dryRun) {
      const settings = await store.settings();
      const year = renewalYear(row.boughtAt, row.expiresAt);
      const charging = chargeDecision({ chargeOn: settings.chargeOn, year }) === 'charge';
      return {
        ok: true,
        status: row.status,
        outcome: 'dry_run',
        dryRun: true,
        costPence: pence,
        steps: [
          { step: 'Spend', detail: `Claim ${pounds(pence)} against today's cap of ${pounds(settings.dailySpendCapPence)}.` },
          { step: 'Renew', detail: `Ask the registrar to renew ${row.name} for one year.` },
          { step: 'Charge', detail: charging ? `Charge the member ${pounds(pence)} from their credit, once, for year ${year}.` : 'No charge: the yearly charge is off.' },
        ],
      };
    }

    let reg: Registrar;
    try {
      reg = deps.registrar();
    } catch {
      return result(row, 'not_configured', false);
    }
    const key = renewKey(row.id, row.expiresAt);
    const claim = await store.claimSpend(row.id, 'renew', pence, key);
    if (claim === 'over_cap') return result(row, 'held_cap', true, { costPence: pence });

    let newExpiry: string;
    try {
      // 'already' means an earlier try may have gone through unseen: look before renewing again.
      const seen = claim === 'already' ? await reg.info(row.name) : null;
      if (seen?.expiresAt && new Date(seen.expiresAt).getTime() > new Date(row.expiresAt).getTime()) {
        newExpiry = seen.expiresAt;
      } else {
        newExpiry = (await reg.renew(row.name)).expiresAt;
      }
    } catch (e) {
      if (e instanceof RegistrarError && e.code === 'refused') await store.settleSpend(key, 'void');
      const next = await store.updateDomain(row.id, { attempts: row.attempts + 1, lastError: errorText(e) });
      return result(next ?? row, 'retry_later', false);
    }
    await store.settleSpend(key, 'bought');
    const year = renewalYear(row.boughtAt, row.expiresAt);
    const charged = await chargeRenewal(row, year, pence).catch(() => 'unpaid' as const);
    const next = await store.updateDomain(row.id, { expiresAt: newExpiry, renewDecision: null, renewDecidedBy: null, renewDecidedAt: null, attempts: 0, lastError: null });
    return result(next ?? row, charged === 'charged' ? 'renewed_charged' : charged === 'unpaid' ? 'renewed_unpaid' : 'renewed', true, { costPence: pence });
  }

  /** The admin's call on a renewal. */
  async function decideRenewal(id: string, decision: RenewDecision, adminId: string | null, opts: RunOptions = {}): Promise<RunResult> {
    const row = await store.domain(id);
    if (!row) return result(null, 'not_found', false);
    if (row.status !== 'live') return result(row, 'bad_status', false);
    if (opts.dryRun) return { ok: true, status: row.status, outcome: 'dry_run', dryRun: true, steps: [{ step: 'Decision', detail: decision === 'renew' ? `Renew ${row.name} at the next cron run.` : `Do not renew ${row.name}: it lapses at expiry.` }] };
    const next = await store.updateDomain(row.id, { renewDecision: decision, renewDecidedBy: adminId, renewDecidedAt: iso(deps.now()) });
    return result(next ?? row, decision, true);
  }

  /** Whether the 7-day rule would renew this domain now, with the site's current standing. */
  async function autoRenewVerdict(row: DomainRow) {
    const site = await store.site(row.websiteId);
    return autoRenewRule({ status: row.status, expiresAt: row.expiresAt, renewDecision: row.renewDecision, siteLive: site?.status === 'live', renewAllowed: row.renewAllowed }, deps.now());
  }

  /** Batch 36's hook: the website is switched off or its plan lapsed, so its domain must not auto-renew. */
  async function blockRenewal(websiteId: string, opts: RunOptions = {}): Promise<{ ok: boolean; changed: boolean; dryRun: boolean }> {
    const row = await store.domainForSite(websiteId);
    if (!row) return { ok: true, changed: false, dryRun: Boolean(opts.dryRun) };
    if (opts.dryRun) return { ok: true, changed: row.renewAllowed, dryRun: true };
    if (!row.renewAllowed) return { ok: true, changed: false, dryRun: false };
    const next = await store.updateDomain(row.id, { renewAllowed: false });
    return { ok: Boolean(next), changed: Boolean(next), dryRun: false };
  }

  /** Batch 36: the website was switched back on, so its domain may auto-renew again (the one column blockRenewal wrote). */
  async function allowRenewal(websiteId: string, opts: RunOptions = {}): Promise<{ ok: boolean; changed: boolean; dryRun: boolean }> {
    const row = await store.domainForSite(websiteId);
    if (!row) return { ok: true, changed: false, dryRun: Boolean(opts.dryRun) };
    if (opts.dryRun) return { ok: true, changed: !row.renewAllowed, dryRun: true };
    if (row.renewAllowed) return { ok: true, changed: false, dryRun: false };
    const next = await store.updateDomain(row.id, { renewAllowed: true });
    return { ok: Boolean(next), changed: Boolean(next), dryRun: false };
  }

  return { offerNames, chooseName, buy, advance, retry, resendLiveEmail, release, renew, decideRenewal, autoRenewVerdict, blockRenewal, allowRenewal };
}

export type DomainEngine = ReturnType<typeof createDomainEngine>;
