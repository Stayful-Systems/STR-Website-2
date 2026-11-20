import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { recordActivity } from '../activity/log';
import { sendEmail } from '../email/send';
import { brandedFrom } from '../email/from.ts';
import { domainLiveEmail } from '../email/domain.ts';
import { siteUrl } from '../url';
import { parseSiteSettings } from '../websites/store-server';
import { CO_UK_NAME } from './name.ts';
import { createDomainEngine, StoreConflict, type DomainDeps, type DomainEngine, type DomainPatch, type DomainStore, type SiteFacts, type StoredOffer } from './purchase-server.ts';
import { getRegistrar, ownerHandle } from './registrar/index.ts';
import { DOMAIN_KEYS, parseDomains, type DomainSettings } from './settings.ts';
import { DOMAIN_STATUSES, type DomainChargeResult, type DomainRow, type DomainStatus, type RenewDecision, type SpendClaim } from './types.ts';
import { getVercel } from './vercel.ts';

/**
 * Batch 33: the website domains' rows (website_domains and friends), service
 * role only, and the real wiring of the engine (purchase-server.ts).
 *
 *   createLiveStore()      the DomainStore the engine runs on, over Supabase
 *   liveDomainEngine()     the engine with the real registrar, Vercel, probe,
 *                          member email and activity log
 *   readDomainSettings()   the three billing_settings switches and limits
 *   writeDomainSetting()   one of them, from the admin panel (checked first)
 *   listDomainRows()       the admin's list
 *
 * website_domain_charge is called from exactly one place: store.charge below,
 * which only the engine's chargeRenewal reaches (and it returns first when
 * the yearly charge is OFF). A pin test holds both.
 *
 * Nothing here logs a body, a header or a credential: a failed read logs the
 * table and the database's error code.
 */

const UUID = /^[0-9a-f-]{36}$/i;
const COLUMNS =
  'id, website_id, owner_id, name, status, registrar, registrar_ref, cost_pence, bought_at, expires_at, renew_allowed, renew_decision, renew_decided_by, renew_decided_at, dns_set_at, vercel_added_at, https_ok_at, live_at, attempts, last_error, stuck_alerted_at, renewal_alerted_for, autorenew_alerted_for, state_changed_at, created_at, updated_at';

type Admin = ReturnType<typeof createAdminClient>;
const admin = (): Admin => createAdminClient();

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

export function toDomainRow(r: Record<string, unknown>): DomainRow {
  const status = DOMAIN_STATUSES.includes(r.status as DomainStatus) ? (r.status as DomainStatus) : 'failed';
  const decision = r.renew_decision === 'renew' || r.renew_decision === 'dont_renew' ? (r.renew_decision as RenewDecision) : null;
  return {
    id: String(r.id),
    websiteId: String(r.website_id),
    ownerId: String(r.owner_id),
    name: String(r.name),
    status,
    registrar: str(r.registrar),
    registrarRef: str(r.registrar_ref),
    costPence: typeof r.cost_pence === 'number' ? r.cost_pence : null,
    boughtAt: str(r.bought_at),
    expiresAt: str(r.expires_at),
    renewAllowed: r.renew_allowed !== false,
    renewDecision: decision,
    renewDecidedBy: str(r.renew_decided_by),
    renewDecidedAt: str(r.renew_decided_at),
    dnsSetAt: str(r.dns_set_at),
    vercelAddedAt: str(r.vercel_added_at),
    httpsOkAt: str(r.https_ok_at),
    liveAt: str(r.live_at),
    attempts: typeof r.attempts === 'number' ? r.attempts : 0,
    lastError: str(r.last_error),
    stuckAlertedAt: str(r.stuck_alerted_at),
    renewalAlertedFor: str(r.renewal_alerted_for),
    autoRenewAlertedFor: str(r.autorenew_alerted_for),
    stateChangedAt: String(r.state_changed_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

const COLUMN_OF: Record<keyof DomainPatch, string> = {
  name: 'name',
  status: 'status',
  registrar: 'registrar',
  registrarRef: 'registrar_ref',
  costPence: 'cost_pence',
  boughtAt: 'bought_at',
  expiresAt: 'expires_at',
  renewAllowed: 'renew_allowed',
  renewDecision: 'renew_decision',
  renewDecidedBy: 'renew_decided_by',
  renewDecidedAt: 'renew_decided_at',
  dnsSetAt: 'dns_set_at',
  vercelAddedAt: 'vercel_added_at',
  httpsOkAt: 'https_ok_at',
  liveAt: 'live_at',
  attempts: 'attempts',
  lastError: 'last_error',
  stuckAlertedAt: 'stuck_alerted_at',
  renewalAlertedFor: 'renewal_alerted_for',
  autoRenewAlertedFor: 'autorenew_alerted_for',
};

function isUnique(error: { code?: string } | null): boolean {
  return error?.code === '23505';
}

// ── Settings ──

export async function readDomainSettings(): Promise<DomainSettings> {
  if (!hasServiceRole()) return parseDomains(() => undefined);
  const { data, error } = await admin().from('billing_settings').select('key, value').in('key', Object.values(DOMAIN_KEYS));
  if (error) console.error('[domains] settings read failed, using defaults:', error.code ?? 'error');
  const kv = new Map<string, unknown>((data ?? []).map((r) => [String((r as { key: unknown }).key), (r as { value: unknown }).value]));
  return parseDomains((key) => kv.get(key));
}

/** Store one admin-checked setting (checkDomainSetting has already vetted the key and value). */
export async function writeDomainSetting(key: string, value: boolean | number): Promise<boolean> {
  if (!hasServiceRole() || !(Object.values(DOMAIN_KEYS) as string[]).includes(key)) return false;
  const { error } = await admin().from('billing_settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) console.error('[domains] setting write failed:', error.code ?? 'error');
  return !error;
}

// ── The store ──

export function createLiveStore(): DomainStore {
  return {
    async site(websiteId): Promise<SiteFacts | null> {
      if (!UUID.test(websiteId)) return null;
      const { data, error } = await admin().from('websites').select('id, user_id, slug, status, settings, domain').eq('id', websiteId).maybeSingle();
      if (error || !data) return null;
      const r = data as Record<string, unknown>;
      const settings = parseSiteSettings(r.settings);
      return { id: String(r.id), userId: String(r.user_id), slug: String(r.slug), status: String(r.status), domain: str(r.domain), company: settings.companyName, towns: settings.areas };
    },

    async getOffer(websiteId): Promise<StoredOffer | null> {
      const { data, error } = await admin().from('website_domain_offers').select('names, prices, offered_at').eq('website_id', websiteId).maybeSingle();
      if (error || !data) return null;
      const r = data as { names?: unknown; prices?: unknown; offered_at?: unknown };
      const prices: Record<string, number> = {};
      if (r.prices && typeof r.prices === 'object') for (const [k, v] of Object.entries(r.prices as Record<string, unknown>)) if (typeof v === 'number') prices[k] = v;
      return { names: Array.isArray(r.names) ? r.names.filter((n): n is string => typeof n === 'string') : [], prices, offeredAt: String(r.offered_at) };
    },

    async saveOffer(websiteId, offer) {
      const { error } = await admin().from('website_domain_offers').upsert({ website_id: websiteId, names: offer.names, prices: offer.prices, offered_at: new Date().toISOString() }, { onConflict: 'website_id' });
      if (error) throw new Error(`offer:${error.code ?? 'error'}`);
    },

    async domain(id) {
      if (!UUID.test(id)) return null;
      const { data, error } = await admin().from('website_domains').select(COLUMNS).eq('id', id).maybeSingle();
      if (error) console.error('[domains] read failed:', error.code ?? 'error');
      return data ? toDomainRow(data as Record<string, unknown>) : null;
    },

    async domainForSite(websiteId) {
      const { data, error } = await admin().from('website_domains').select(COLUMNS).eq('website_id', websiteId).neq('status', 'released').maybeSingle();
      if (error) console.error('[domains] site read failed:', error.code ?? 'error');
      return data ? toDomainRow(data as Record<string, unknown>) : null;
    },

    async releasedBefore(websiteId) {
      const { count, error } = await admin().from('website_domains').select('id', { count: 'exact', head: true }).eq('website_id', websiteId).eq('status', 'released');
      if (error) {
        console.error('[domains] released check failed:', error.code ?? 'error');
        return true; // When unsure, do not let the member buy another.
      }
      return (count ?? 0) > 0;
    },

    async insertDomain(r) {
      const { data, error } = await admin().from('website_domains').insert({ website_id: r.websiteId, owner_id: r.ownerId, name: r.name, cost_pence: r.costPence, status: 'awaiting_admin' }).select(COLUMNS).single();
      if (isUnique(error)) throw new StoreConflict();
      if (error || !data) throw new Error(`insert:${error?.code ?? 'error'}`);
      return toDomainRow(data as Record<string, unknown>);
    },

    async updateDomain(id, patch, guard) {
      const now = new Date().toISOString();
      const set: Record<string, unknown> = { updated_at: now };
      for (const [k, v] of Object.entries(patch) as Array<[keyof DomainPatch, unknown]>) if (v !== undefined) set[COLUMN_OF[k]] = v;
      // state_changed_at moves only when the status really changes (the stuck timer must survive a resume).
      if (patch.status !== undefined) {
        const { data: cur } = await admin().from('website_domains').select('status').eq('id', id).maybeSingle();
        if (cur && (cur as { status?: string }).status !== patch.status) set.state_changed_at = now;
      }
      let q = admin().from('website_domains').update(set).eq('id', id);
      if (guard?.from) q = q.in('status', [...guard.from]);
      if (guard?.updatedAt) q = q.eq('updated_at', guard.updatedAt);
      const { data, error } = await q.select(COLUMNS);
      if (isUnique(error)) throw new StoreConflict();
      if (error) {
        console.error('[domains] update failed:', error.code ?? 'error');
        return null;
      }
      const row = (data ?? [])[0];
      return row ? toDomainRow(row as Record<string, unknown>) : null;
    },

    async claimSpend(domainId, kind, pence, key): Promise<SpendClaim> {
      const { data, error } = await admin().rpc('website_domain_spend_claim', { p_domain: domainId, p_kind: kind, p_pence: pence, p_key: key });
      if (error) throw new Error(`claim:${error.code ?? 'error'}`);
      if (data === 'claimed' || data === 'already' || data === 'over_cap') return data;
      throw new Error('claim:unexpected');
    },

    async settleSpend(key, status, ref) {
      const { data, error } = await admin().rpc('website_domain_spend_settle', { p_key: key, p_status: status, p_ref: ref ?? null });
      if (error) throw new Error(`settle:${error.code ?? 'error'}`);
      return data === true;
    },

    async setSiteDomain(websiteId, name) {
      const { data, error } = await admin().from('websites').update({ domain: name, updated_at: new Date().toISOString() }).eq('id', websiteId).select('id');
      if (isUnique(error)) return false;
      if (error) {
        console.error('[domains] site domain write failed:', error.code ?? 'error');
        return false;
      }
      return (data ?? []).length === 1;
    },

    // The one door to the yearly charge. Only the engine's chargeRenewal calls it, after the OFF check.
    async charge(a) {
      const { data, error } = await admin().rpc('website_domain_charge', { p: { owner: a.owner, domain: a.domain, period: a.period, pence: a.pence, meta: {} } });
      if (error) throw new Error(`charge:${error.code ?? 'error'}`);
      const result = (data as { result?: unknown } | null)?.result;
      if (result === 'charged' || result === 'unpaid' || result === 'already_charged') return { result: result as DomainChargeResult };
      throw new Error('charge:unexpected');
    },

    settings: readDomainSettings,

    async memberEmail(ownerId) {
      const { data } = await admin().from('profiles').select('email').eq('id', ownerId).maybeSingle();
      return str((data as { email?: unknown } | null)?.email);
    },
  };
}

// ── The real engine ──

/** Fetch an address as the public would. Only a plain <label>.co.uk is ever fetched (the engine builds it from the stored name). */
async function realProbe(url: string): Promise<{ status: number; html: string }> {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  })();
  if (!CO_UK_NAME.test(host)) throw new Error('probe:bad_host');
  const res = await fetch(url, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  return { status: res.status, html: res.status === 200 ? await res.text() : '' };
}

const memberFrom = () => brandedFrom(process.env.EMAIL_FROM, 'Stayful Intelligence') ?? undefined;

export function liveDomainDeps(): DomainDeps {
  return {
    store: createLiveStore(),
    registrar: () => getRegistrar(),
    vercel: () => getVercel(),
    ownerHandle: () => ownerHandle(),
    probe: realProbe,
    async sendLiveEmail(i) {
      const copy = domainLiveEmail({ company: i.company, address: i.address, oldAddress: i.oldAddress, leadsUrl: i.leadsUrl });
      const from = memberFrom();
      const res = await sendEmail({ to: i.to, ...copy, ...(from ? { from } : {}), idempotencyKey: i.key });
      // Nothing configured is nothing to retry; a real failure is retried (the key makes a second try safe).
      return res.sent || res.reason === 'not_configured';
    },
    activity: (userId, kind, o) => recordActivity(userId, kind, { dedupeKey: o.dedupeKey, extras: o.extras }),
    now: () => new Date(),
    appUrl: (path) => siteUrl(path),
  };
}

export function liveDomainEngine(): DomainEngine {
  return createDomainEngine(liveDomainDeps());
}

// ── Reads for the admin list, the member picker and the cron ──

export async function listDomainRows(statuses?: readonly DomainStatus[]): Promise<DomainRow[]> {
  if (!hasServiceRole()) return [];
  let q = admin().from('website_domains').select(COLUMNS).order('created_at', { ascending: false }).limit(500);
  if (statuses) q = q.in('status', [...statuses]);
  const { data, error } = await q;
  if (error) {
    console.error('[domains] list failed:', error.code ?? 'error');
    return [];
  }
  return (data ?? []).map((r) => toDomainRow(r as Record<string, unknown>));
}

/** The member's own domain (not released) for the setup page, by the signed-in owner's website id. */
export async function domainOfSite(websiteId: string): Promise<DomainRow | null> {
  if (!hasServiceRole()) return null;
  return createLiveStore().domainForSite(websiteId);
}

/**
 * Is this exact domain LIVE for this website, according to the database? The
 * lead route skips the Turnstile check only on a yes: decided here on the
 * server from website_domains, never from anything the browser sends.
 */
export async function domainIsLiveFor(websiteId: string, name: string | null | undefined): Promise<boolean> {
  if (!hasServiceRole() || !name || !UUID.test(websiteId)) return false;
  const { data, error } = await admin().from('website_domains').select('id').eq('website_id', websiteId).eq('name', name).eq('status', 'live').maybeSingle();
  if (error) {
    console.error('[domains] live check failed:', error.code ?? 'error');
    return false;
  }
  return Boolean(data);
}
