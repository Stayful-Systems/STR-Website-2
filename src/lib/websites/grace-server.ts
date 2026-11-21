import 'server-only';

/**
 * Batch 36 (Phase 6): the live wiring for the website grace period
 * (grace-run.ts holds the logic and the tests). Service role only.
 *
 *   liveGraceDeps()        the cron's deps (/api/internal/website-grace)
 *   graceForSite(id)       the derived state a screen shows (a login cancels a
 *                          pending switch-off here at once, before the cron
 *                          records it)
 *   switchOffSite(id, o)   callable by the console and Batch 37: {by, dryRun}
 *   switchOnSite(ownerId)  the operator's own "Switch back on"
 *   deleteSiteData(id, o)  delete a switched-off site's data: {dryRun}
 *   exportSiteData(id)     the site's data as JSON, offered before Delete
 *
 * What the cron reads (read only): profiles.last_seen_at for the owner and
 * every team member; the newest lead on the site's funnel; the owner's plan
 * (accountStatus over ACCESS_COLUMNS, never edited here); an unpaid domain
 * charge when domain_charge_on is true.
 *
 * Switching off only flips the status. Nothing in the deletion section below
 * reads or writes enquiries, where they came from, report records, charges,
 * domain records or the funnel row. Logs carry a short website id and a code:
 * never an address, an email body or a request's text.
 */
import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { ACCESS_COLUMNS, isPaid, type AccessProfile } from '../access';
import { isManagement } from '../management/stamp';
import { recordActivity } from '../activity/log';
import { abandonSend, claimSlot, finishSend, markSending, releaseClaim, slotsInUse } from '../notify/sends';
import { websiteGraceWarningEmail, websiteSwitchedOffEmail } from '../email/website-grace';
import { deleteLogoIfOurs } from '../funnels/storage';
import { liveDomainEngine, readDomainSettings } from '../domains/store-server';
import { alignCopy } from '../../app/leads/setup/website/steps';
import { readWebsiteSettings, parseSiteSettings, ownSite, setStatus } from './store-server';
import { sitePagesOf } from './render';
import { websiteAccess } from './policy';
import { GRACE_KEYS, parseGrace, type GraceSettings } from './grace-settings';
import { ukDayOf, type GraceReason, type GraceNotice } from './grace-rules';
import {
  deleteWith,
  exportWith,
  finishSwitchOffWith,
  graceFactsOf,
  newestOf,
  siteFiles,
  siteGraceView,
  switchOffWith,
  switchOnWith,
  type CapSendDeps,
  type DeleteDeps,
  type DeleteResult,
  type ExportDeps,
  type FinishOffDeps,
  type FinishOffResult,
  type GraceEpisodeRow,
  type GraceRunDeps,
  type GraceSite,
  type SiteExport,
  type SiteGraceView,
  type SiteLite,
  type SwitchOffDeps,
  type SwitchOffResult,
  type SwitchOnDeps,
  type SwitchOnResult,
} from './grace-run';

type Admin = ReturnType<typeof createAdminClient>;

const ID_CHUNK = 150;
const REQUESTS_BUCKET = 'website-requests';
const UUID = /^[0-9a-f-]{36}$/i;

const iso = (v: unknown): Date | null => {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
};
const dayOrNull = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

function chunks<T>(xs: readonly T[], n = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

// ── Settings ──

export async function readGraceSettings(): Promise<GraceSettings> {
  if (!hasServiceRole()) return parseGrace(() => undefined);
  const { data, error } = await createAdminClient().from('billing_settings').select('key, value').in('key', Object.values(GRACE_KEYS));
  if (error) console.error('[website-grace] settings read failed, using defaults:', error.message);
  const kv = new Map<string, unknown>((data ?? []).map((r) => [String((r as { key: unknown }).key), (r as { value: unknown }).value]));
  return parseGrace((k) => kv.get(k));
}

// ── Reading sites and their facts ──

const GRACE_COLUMNS = 'website_id, reason, episode_started_at, switch_off_on, cancelled_at, switched_off_at, switch_off_by, off_emailed_at, delete_on, deleted_at';

function episodeFrom(r: Record<string, unknown> | undefined): GraceEpisodeRow | null {
  if (!r) return null;
  const startedAt = iso(r.episode_started_at);
  if (!startedAt) return null;
  const reason = String(r.reason) as GraceReason;
  return {
    reason: reason === 'cancelled' || reason === 'unpaid' ? reason : 'abandoned',
    startedAt,
    cancelledAt: iso(r.cancelled_at),
    switchedOffAt: iso(r.switched_off_at),
    deletedAt: iso(r.deleted_at),
    switchOffOn: dayOrNull(r.switch_off_on),
    switchOffBy: r.switch_off_by === 'admin' ? 'admin' : r.switch_off_by === 'cron' ? 'cron' : null,
    offEmailedAt: iso(r.off_emailed_at),
    deleteOn: dayOrNull(r.delete_on),
  };
}

/**
 * The sites the cron looks at (or just `websiteIds`): every live site, plus
 * every site with an open or switched-off episode that is not deleted. Each
 * comes with its facts: nothing here writes.
 */
async function loadSites(now: Date, websiteIds?: readonly string[]): Promise<GraceSite[]> {
  const admin = createAdminClient();
  const [web, domain] = await Promise.all([readWebsiteSettings(), readDomainSettings()]);

  // Which sites
  let ids: string[];
  if (websiteIds) ids = [...new Set(websiteIds)].filter((id) => UUID.test(id));
  else {
    const [live, open, moved] = await Promise.all([
      admin.from('websites').select('id').eq('status', 'live').limit(5000),
      admin.from('website_grace').select('website_id').is('cancelled_at', null).is('deleted_at', null).limit(5000),
      // Batch 37: a site with a transfer row that is not cancelled is the operator's: no warning, no switch-off, no deletion.
      admin.from('website_transfers').select('website_id').is('cancelled_at', null).limit(5000),
    ]);
    if (live.error) throw new Error(live.error.message);
    if (open.error) throw new Error(open.error.message);
    if (moved.error) throw new Error(moved.error.message); // fail closed: never act on a site that may have been handed over
    const transferred = new Set((moved.data ?? []).map((r) => String((r as { website_id: unknown }).website_id)));
    ids = [...new Set([...(live.data ?? []).map((r) => String((r as { id: unknown }).id)), ...(open.data ?? []).map((r) => String((r as { website_id: unknown }).website_id))])].filter((id) => !transferred.has(id));
  }
  if (ids.length === 0) return [];

  const rows: Record<string, unknown>[] = [];
  const grace = new Map<string, Record<string, unknown>>();
  const noticeRows: Record<string, unknown>[] = [];
  for (const c of chunks(ids)) {
    const [w, g, n] = await Promise.all([
      admin.from('websites').select('id, user_id, funnel_id, status, live_at').in('id', c),
      admin.from('website_grace').select(GRACE_COLUMNS).in('website_id', c),
      admin.from('website_grace_notices').select('website_id, episode_started_at, stage, status, sent_at').in('website_id', c),
    ]);
    if (w.error) throw new Error(w.error.message);
    if (g.error) throw new Error(g.error.message);
    if (n.error) throw new Error(n.error.message);
    rows.push(...((w.data ?? []) as Record<string, unknown>[]));
    for (const r of (g.data ?? []) as Record<string, unknown>[]) grace.set(String(r.website_id), r);
    noticeRows.push(...((n.data ?? []) as Record<string, unknown>[]));
  }

  // Owners, their team, and when anyone last logged in
  const ownerIds = [...new Set(rows.map((r) => String(r.user_id)))];
  const profiles = new Map<string, Record<string, unknown>>();
  const teamOf = new Map<string, string[]>();
  const seen = new Map<string, Date | null>();
  for (const c of chunks(ownerIds)) {
    const [p, t] = await Promise.all([admin.from('profiles').select(`id, email, last_seen_at, ${ACCESS_COLUMNS}`).in('id', c), admin.from('team_members').select('owner_id, member_id').in('owner_id', c)]);
    if (p.error) throw new Error(p.error.message);
    if (t.error) throw new Error(t.error.message);
    for (const r of (p.data ?? []) as unknown as Record<string, unknown>[]) {
      profiles.set(String(r.id), r);
      seen.set(String(r.id), iso(r.last_seen_at));
    }
    for (const r of (t.data ?? []) as { owner_id: string; member_id: string }[]) teamOf.set(r.owner_id, [...(teamOf.get(r.owner_id) ?? []), r.member_id]);
  }
  const memberIds = [...new Set([...teamOf.values()].flat())];
  for (const c of chunks(memberIds)) {
    const { data, error } = await admin.from('profiles').select('id, last_seen_at').in('id', c);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { id: string; last_seen_at: string | null }[]) seen.set(r.id, iso(r.last_seen_at));
  }

  // The newest enquiry on each site's funnel
  const newestLead = new Map<string, Date | null>();
  for (const c of chunks(rows, 10)) {
    await Promise.all(
      c.map(async (r) => {
        const { data, error } = await admin.from('leads').select('created_at').eq('funnel_id', String(r.funnel_id)).order('created_at', { ascending: false }).limit(1);
        if (error) throw new Error(error.message);
        newestLead.set(String(r.id), iso((data?.[0] as { created_at?: string } | undefined)?.created_at));
      }),
    );
  }

  // An unpaid domain charge, only when charging is on
  const unpaidSince = new Map<string, Date>();
  if (domain.chargeOn) {
    for (const c of chunks(ids)) {
      const { data: doms, error: de } = await admin.from('website_domains').select('id, website_id').in('website_id', c);
      if (de) throw new Error(de.message);
      const siteOf = new Map(((doms ?? []) as { id: string; website_id: string }[]).map((d) => [d.id, d.website_id]));
      if (siteOf.size === 0) continue;
      const { data: ch, error: ce } = await admin.from('website_domain_charges').select('domain_id, created_at').in('domain_id', [...siteOf.keys()]).eq('status', 'unpaid');
      if (ce) throw new Error(ce.message);
      for (const r of (ch ?? []) as { domain_id: string; created_at: string }[]) {
        const site = siteOf.get(r.domain_id);
        const at = iso(r.created_at);
        if (!site || !at) continue;
        const prev = unpaidSince.get(site);
        if (!prev || at.getTime() < prev.getTime()) unpaidSince.set(site, at);
      }
    }
  }

  return rows.map((r): GraceSite => {
    const websiteId = String(r.id);
    const ownerId = String(r.user_id);
    const profile = (profiles.get(ownerId) ?? {}) as Record<string, string | number | null>;
    const episode = episodeFrom(grace.get(websiteId));
    const notices: GraceNotice[] = episode
      ? noticeRows
          .filter((n) => String(n.website_id) === websiteId && iso(n.episode_started_at)?.getTime() === episode.startedAt.getTime())
          .map((n) => ({ stage: Number(n.stage), status: n.status === 'skipped' ? ('skipped' as const) : ('sent' as const), sentAt: iso(n.sent_at) ?? episode.startedAt }))
      : [];
    const lastSeen = newestOf([ownerId, ...(teamOf.get(ownerId) ?? [])].map((id) => seen.get(id) ?? null));
    return {
      websiteId,
      ownerId,
      status: String(r.status),
      email: typeof profile.email === 'string' ? profile.email : null,
      facts: graceFactsOf({
        status: String(r.status),
        liveAt: iso(r.live_at),
        lastSeen,
        lastLead: newestLead.get(websiteId) ?? null,
        profile: profile as unknown as AccessProfile,
        unpaidSince: unpaidSince.get(websiteId) ?? null,
        gateOn: web.planGateOn,
        chargeOn: domain.chargeOn,
        now,
      }),
      episode,
      notices,
    };
  });
}

/**
 * What a screen shows for one site: derived from the same facts and rules as
 * the cron, so a login after the episode started cancels a pending switch-off
 * here at once. Null when the site is not found.
 */
export async function graceForSite(websiteId: string): Promise<SiteGraceView | null> {
  if (!hasServiceRole() || !UUID.test(websiteId)) return null;
  const now = new Date();
  const [sites, settings] = await Promise.all([loadSites(now, [websiteId]), readGraceSettings()]);
  return sites[0] ? siteGraceView(sites[0], settings, ukDayOf(now)) : null;
}

// ── The cap (notify/sends.ts) ──

function capDeps(admin: Admin): CapSendDeps {
  return {
    claimSlot: async (userId, kind, now) => {
      const c = await claimSlot(admin, userId, kind, now);
      return c.ok ? { ok: true, id: c.id } : { ok: false, reason: c.reason };
    },
    releaseClaim: (id) => releaseClaim(admin, id),
    markSending: (id, summary) => markSending(admin, id, summary, null),
    abandonSend: (id) => abandonSend(admin, id),
    finishSend: async (id, summary) => {
      await finishSend(admin, id, true, summary, []);
    },
  };
}

// ── Switch off ──

async function loadLite(admin: Admin, websiteId: string): Promise<SiteLite | null> {
  if (!UUID.test(websiteId)) return null;
  const [w, g] = await Promise.all([admin.from('websites').select('id, user_id, status').eq('id', websiteId).maybeSingle(), admin.from('website_grace').select(GRACE_COLUMNS).eq('website_id', websiteId).maybeSingle()]);
  if (w.error) throw new Error(w.error.message);
  if (g.error) throw new Error(g.error.message);
  if (!w.data) return null;
  const r = w.data as { id: string; user_id: string; status: string };
  return { id: r.id, ownerId: r.user_id, status: r.status, episode: episodeFrom((g.data ?? undefined) as Record<string, unknown> | undefined) };
}

function finishOffDeps(admin: Admin): FinishOffDeps {
  return {
    ...capDeps(admin),
    episode: async (websiteId) => {
      const lite = await loadLite(admin, websiteId);
      if (!lite?.episode) return null;
      const { data } = await admin.from('profiles').select('email').eq('id', lite.ownerId).maybeSingle();
      return { ...lite.episode, ownerId: lite.ownerId, email: (data as { email?: string | null } | null)?.email ?? null };
    },
    blockRenewal: async (websiteId) => (await liveDomainEngine().blockRenewal(websiteId)).ok,
    sendOffEmail: (to, data, key) => websiteSwitchedOffEmail(to, data, { idempotencyKey: key }),
    stampEmailed: async (websiteId, at) => {
      const { error } = await admin.from('website_grace').update({ off_emailed_at: at.toISOString(), updated_at: at.toISOString() }).eq('website_id', websiteId).is('off_emailed_at', null);
      if (error) throw new Error(`website_grace write failed: ${error.message}`);
    },
    deleteAfterDays: async () => (await readGraceSettings()).deleteAfterDays,
  };
}

/** Stop the domain renewing and send the "switched off" email (retried by the cron until both have happened). */
export function finishSwitchOff(websiteId: string, now: Date = new Date()): Promise<FinishOffResult> {
  return finishSwitchOffWith(finishOffDeps(createAdminClient()), websiteId, now);
}

function switchOffDeps(admin: Admin): SwitchOffDeps {
  return {
    load: (websiteId) => loadLite(admin, websiteId),
    deleteAfterDays: async () => (await readGraceSettings()).deleteAfterDays,
    pause: async (site) => {
      // A live site moves by the usual rule (live -> paused). An admin may also switch off one that is not live.
      if (site.status === 'live') return (await setStatus(site.ownerId, 'paused')).ok;
      const now = new Date().toISOString();
      const { data, error } = await admin.from('websites').update({ status: 'paused', paused_at: now, updated_at: now }).eq('id', site.id).eq('status', site.status).select('id');
      if (error) {
        console.error('[website-grace] pause failed:', error.code ?? 'error');
        return false;
      }
      return (data?.length ?? 0) > 0;
    },
    stamp: async (websiteId, f) => {
      const at = f.at.toISOString();
      const { data: existing, error: re } = await admin.from('website_grace').select('episode_started_at, cancelled_at, deleted_at').eq('website_id', websiteId).maybeSingle();
      if (re) return false;
      const e = existing as { cancelled_at: string | null; deleted_at: string | null } | null;
      if (e && e.cancelled_at === null && e.deleted_at === null) {
        const { error } = await admin.from('website_grace').update({ switched_off_at: at, switch_off_by: f.by, delete_on: f.deleteOn, updated_at: at }).eq('website_id', websiteId);
        return !error;
      }
      // No open episode (an admin switched a site off by hand): a fresh row, replacing a cancelled one.
      const { error } = await admin.from('website_grace').upsert(
        { website_id: websiteId, reason: f.reason, episode_started_at: at, switch_off_on: null, cancelled_at: null, switched_off_at: at, switch_off_by: f.by, off_emailed_at: null, delete_on: f.deleteOn, deleted_at: null, updated_at: at },
        { onConflict: 'website_id' },
      );
      return !error;
    },
    finish: (websiteId, now) => finishSwitchOffWith(finishOffDeps(admin), websiteId, now),
  };
}

/**
 * Switch a site off: status live -> paused, switched_off_at, switch_off_by and
 * delete_on (today + the delete days) on its website_grace row, the domain's
 * renewal blocked and one "switched off" email through the daily cap. The cron
 * calls it with by 'cron' (a live site only); the console with by 'admin'
 * (which may also switch off a paused, preview or setup site). `dryRun` reads
 * and writes nothing. Leads, reports and deliveries carry on.
 */
export async function switchOffSite(websiteId: string, opts: { by: 'cron' | 'admin'; dryRun?: boolean }): Promise<SwitchOffResult> {
  if (!hasServiceRole()) return { ok: false, reason: 'unavailable' };
  try {
    return await switchOffWith(switchOffDeps(createAdminClient()), websiteId, opts);
  } catch (err) {
    console.error('[website-grace] switch off failed:', (err as Error)?.message ?? 'error');
    return { ok: false, reason: 'unavailable' };
  }
}

// ── Switch back on ──

function switchOnDeps(admin: Admin): SwitchOnDeps {
  return {
    load: async (ownerId) => {
      const site = await ownSite(ownerId);
      if (!site) return null;
      const lite = await loadLite(admin, site.id);
      return { id: site.id, ownerId, slug: site.slug, status: site.status, settings: site.settings, pages: site.pages, pausedAt: site.pausedAt, episode: lite?.episode ?? null };
    },
    planOk: async (ownerId) => {
      const settings = await readWebsiteSettings();
      if (!settings.planGateOn) return true;
      const { data } = await admin.from('profiles').select(`signup_path, ${ACCESS_COLUMNS}`).eq('id', ownerId).maybeSingle();
      if (!data) return false;
      const p = data as unknown as AccessProfile & { signup_path?: string | null };
      return websiteAccess({ isManagement: isManagement(p.signup_path), isOwner: true, invited: true, paid: isPaid(p) }, true, 'go_live').allowed;
    },
    unpaidDomain: async (websiteId) => {
      if (!(await readDomainSettings()).chargeOn) return false;
      const { data: doms } = await admin.from('website_domains').select('id').eq('website_id', websiteId);
      const domainIds = ((doms ?? []) as { id: string }[]).map((d) => d.id);
      if (domainIds.length === 0) return false;
      const { data } = await admin.from('website_domain_charges').select('domain_id').in('domain_id', domainIds).eq('status', 'unpaid').limit(1);
      return (data?.length ?? 0) > 0;
    },
    buildPages: (site) => sitePagesOf({ slug: site.slug }, site.settings, site.pages ? alignCopy(site.settings.areas, site.pages) : null),
    fetchPage: (url, init) => fetch(url, init),
    markLive: async (ownerId) => (await setStatus(ownerId, 'live')).ok,
    rollbackToPaused: async (ownerId, restore) => {
      const now = new Date().toISOString();
      const { data, error } = await admin.from('websites').update({ status: 'paused', paused_at: restore.pausedAt ?? now, updated_at: now }).eq('user_id', ownerId).eq('status', 'live').select('id');
      if (error) {
        console.error('[website-grace] rollback to paused failed:', error.code ?? 'error');
        return false;
      }
      return (data?.length ?? 0) > 0;
    },
    clearEpisode: async (websiteId, at) => {
      const { error } = await admin.from('website_grace').update({ cancelled_at: at.toISOString(), updated_at: at.toISOString() }).eq('website_id', websiteId).is('cancelled_at', null).is('deleted_at', null);
      if (error) throw new Error(`website_grace write failed: ${error.message}`);
    },
    reopenEpisode: async (websiteId) => {
      const { error } = await admin.from('website_grace').update({ cancelled_at: null, updated_at: new Date().toISOString() }).eq('website_id', websiteId).is('deleted_at', null);
      if (error) throw new Error(`website_grace write failed: ${error.message}`);
    },
    allowRenewal: async (websiteId) => (await liveDomainEngine().allowRenewal(websiteId)).ok,
    record: (userId, kind, o) => recordActivity(userId, kind, { dedupeKey: o.dedupeKey, extras: { website: true } }),
    now: () => new Date(),
  };
}

/**
 * The operator's own "Switch back on". `ownerId` is the signed-in account
 * owner (ownerIdOrNull): the site is found by it, never by an id from a
 * request. See switchOnWith for the rules.
 */
export async function switchOnSite(ownerId: string): Promise<SwitchOnResult> {
  if (!hasServiceRole() || !UUID.test(ownerId)) return { ok: false, reason: 'unavailable', messages: ['Your website could not be switched back on just now. Please try again.'] };
  try {
    return await switchOnWith(switchOnDeps(createAdminClient()), ownerId);
  } catch (err) {
    console.error('[website-grace] switch on failed:', (err as Error)?.message ?? 'error');
    return { ok: false, reason: 'unavailable', messages: ['Your website could not be switched back on just now. Please try again.'] };
  }
}

// ── Deletion ──
// Everything between this marker and the next section is held to a pin: it
// never reads or writes enquiries, where they came from, report records,
// charges, domain records or the funnel row (grace-server pin test).

function deleteDeps(admin: Admin): DeleteDeps {
  return {
    load: (websiteId) => loadLite(admin, websiteId),
    inventory: async (websiteId) => {
      const [site, draft, versions, requests] = await Promise.all([
        admin.from('websites').select('settings').eq('id', websiteId).maybeSingle(),
        admin.from('website_drafts').select('settings').eq('website_id', websiteId).maybeSingle(),
        admin.from('website_versions').select('settings').eq('website_id', websiteId),
        admin.from('website_change_requests').select('id, screenshot_path').eq('website_id', websiteId),
      ]);
      for (const r of [site, draft, versions, requests]) if (r.error) throw new Error(r.error.message);
      const settingsOf = (raw: unknown) => ({ settings: parseSiteSettings(raw) });
      const vs = ((versions.data ?? []) as { settings: unknown }[]).map((v) => settingsOf(v.settings));
      const reqs = (requests.data ?? []) as { id: string; screenshot_path: string | null }[];
      return {
        files: siteFiles(settingsOf((site.data as { settings?: unknown } | null)?.settings), draft.data ? settingsOf((draft.data as { settings: unknown }).settings) : null, vs),
        screenshots: reqs.map((r) => r.screenshot_path).filter((p): p is string => typeof p === 'string' && p.length > 0),
        versions: vs.length,
        requests: reqs.length,
        hasDraft: Boolean(draft.data),
      };
    },
    deleteFile: (url) => deleteLogoIfOurs(url),
    deleteScreenshots: async (paths) => {
      const { error } = await admin.storage.from(REQUESTS_BUCKET).remove(paths);
      // A missing bucket means there were no screenshots to keep: logged as a code, never fatal.
      if (error) console.error('[website-grace] screenshot delete failed:', (error as { name?: string }).name ?? 'error');
    },
    deleteRows: async (websiteId) => {
      for (const table of ['website_drafts', 'website_versions', 'website_change_requests'] as const) {
        const { error } = await admin.from(table).delete().eq('website_id', websiteId);
        if (error) throw new Error(`${table} delete failed: ${error.message}`);
      }
    },
    emptySite: async (websiteId) => {
      const { error } = await admin.from('websites').update({ settings: {}, pages: {}, checks: {}, updated_at: new Date().toISOString() }).eq('id', websiteId);
      if (error) throw new Error(`websites write failed: ${error.message}`);
    },
    stampDeleted: async (websiteId, at) => {
      const { data, error } = await admin.from('website_grace').update({ deleted_at: at.toISOString(), updated_at: at.toISOString() }).eq('website_id', websiteId).is('deleted_at', null).select('website_id');
      return !error && (data?.length ?? 0) > 0;
    },
  };
}

/**
 * Delete a switched-off site's data (see deleteWith): the draft, versions,
 * change requests and their screenshots, the logo and photo files, and the
 * settings, pages and checks (emptied; the stub row stays). Only when the site
 * is switched off, not live and not deleted. `dryRun` writes and deletes nothing.
 */
export async function deleteSiteData(websiteId: string, opts: { dryRun?: boolean } = {}): Promise<DeleteResult> {
  if (!hasServiceRole()) return { ok: false, reason: 'unavailable' };
  try {
    return await deleteWith(deleteDeps(createAdminClient()), websiteId, opts);
  } catch (err) {
    console.error('[website-grace] delete failed:', (err as Error)?.message ?? 'error');
    return { ok: false, reason: 'unavailable' };
  }
}

// ── Export ──

function exportDeps(admin: Admin): ExportDeps {
  return {
    site: async (websiteId) => {
      const { data } = await admin.from('websites').select('slug, status, settings, pages').eq('id', websiteId).maybeSingle();
      return (data as { slug: string; status: string; settings: unknown; pages: unknown } | null) ?? null;
    },
    draft: async (websiteId) => {
      const { data } = await admin.from('website_drafts').select('settings, pages, base_version').eq('website_id', websiteId).maybeSingle();
      const d = data as { settings: unknown; pages: unknown; base_version: number | null } | null;
      return d ? { settings: d.settings, pages: d.pages, baseVersion: d.base_version } : null;
    },
    versions: async (websiteId) => {
      const { data } = await admin.from('website_versions').select('version_no, kind, restored_from, published_at, settings, pages').eq('website_id', websiteId).order('version_no', { ascending: true });
      return ((data ?? []) as { version_no: number; kind: string; restored_from: number | null; published_at: string; settings: unknown; pages: unknown }[]).map((v) => ({
        versionNo: v.version_no,
        kind: v.kind,
        restoredFrom: v.restored_from,
        publishedAt: v.published_at,
        settings: v.settings,
        pages: v.pages,
      }));
    },
    requests: async (websiteId) => {
      const { data } = await admin.from('website_change_requests').select('id, status, body, admin_notes, created_at, screenshot_path').eq('website_id', websiteId).order('created_at', { ascending: true });
      return ((data ?? []) as { id: string; status: string; body: string; admin_notes: string | null; created_at: string; screenshot_path: string | null }[]).map((r) => ({
        id: r.id,
        status: r.status,
        body: r.body,
        adminNotes: r.admin_notes,
        createdAt: r.created_at,
        hasScreenshot: Boolean(r.screenshot_path),
      }));
    },
    now: () => new Date(),
  };
}

/** The site's data as JSON (settings, pages, the draft, the versions, change request texts, file URLs). Null when the site is not found. Offered before Delete; callable by Batch 37. */
export async function exportSiteData(websiteId: string): Promise<SiteExport | null> {
  if (!hasServiceRole() || !UUID.test(websiteId)) return null;
  return exportWith(exportDeps(createAdminClient()), websiteId);
}

// ── The cron's deps ──

export function liveGraceDeps(): GraceRunDeps {
  const admin = createAdminClient();
  return {
    ...capDeps(admin),
    settings: () => readGraceSettings(),
    sites: (now) => loadSites(now),
    slotsUsedToday: async (ownerIds, now) => {
      const used = await slotsInUse(admin, ownerIds, 'daily', now);
      return used ? new Set(used.keys()) : null;
    },
    startEpisode: async (websiteId, reason, startedAt, switchOffOn) => {
      const at = startedAt.toISOString();
      const { error } = await admin.from('website_grace').upsert(
        { website_id: websiteId, reason, episode_started_at: at, switch_off_on: switchOffOn, cancelled_at: null, switched_off_at: null, switch_off_by: null, off_emailed_at: null, delete_on: null, deleted_at: null, updated_at: at },
        { onConflict: 'website_id' },
      );
      if (error) throw new Error(`website_grace write failed: ${error.message}`);
    },
    cancelEpisode: async (websiteId, at) => {
      const { error } = await admin.from('website_grace').update({ cancelled_at: at.toISOString(), updated_at: at.toISOString() }).eq('website_id', websiteId).is('cancelled_at', null).is('switched_off_at', null).is('deleted_at', null);
      if (error) throw new Error(`website_grace write failed: ${error.message}`);
    },
    sendWarning: (to, data, key) => websiteGraceWarningEmail(to, data, { idempotencyKey: key }),
    recordNotice: async (websiteId, episodeStartedAt, stage, status, at) => {
      const { error } = await admin
        .from('website_grace_notices')
        .upsert({ website_id: websiteId, episode_started_at: episodeStartedAt.toISOString(), stage, status, sent_at: at.toISOString() }, { onConflict: 'website_id,episode_started_at,stage', ignoreDuplicates: true });
      if (error) throw new Error(`website_grace_notices write failed: ${error.message}`);
    },
    switchOff: async (websiteId) => {
      const r = await switchOffSite(websiteId, { by: 'cron' });
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    },
    finishSwitchOff: (websiteId, now) => finishSwitchOff(websiteId, now),
    deleteData: async (websiteId) => {
      const r = await deleteSiteData(websiteId);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    },
    log: (line) => console.log(line),
  };
}
