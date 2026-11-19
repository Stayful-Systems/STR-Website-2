import 'server-only';

import type { User } from '@supabase/supabase-js';
import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { isPaid, type AccessProfile } from '../access';
import { mintFunnelToken } from '../funnels';
import { isManagement } from '../management/stamp';
import { ownerIdOrNull } from '../leads/scope';
import { MAX_AREAS, type SiteCopy, type SiteSettings } from './page-model';
import { slugProblem, makeSlug, type SlugProblem } from './slug';
import { websiteAccess, type AccessDenial } from './policy';
import { parseWebsite, WEBSITE_KEYS, type WebsiteSettings } from './settings';
import { WEBSITE_STATUSES, type WebsiteStatus } from './types';

/**
 * Batch 31: the customer websites' rows (public.websites), service role only.
 *
 *   readWebsiteSettings   the five billing_settings switches and limits
 *   liveSiteBySlug        the public lookup: a LIVE site by its slug, or null
 *   ownSite               a member's own site (account owners only)
 *   inviteWebsite         an admin gives an account owner a site: a funnel row
 *                         (kind='website', active=false for ever) and a
 *                         websites row, status 'invited'. One site per member.
 *   saveSettings / savePages / saveChecks / bumpRegen / setStatus
 *                         the setup flow's writes, each scoped by the owner's id
 *
 * Website funnels are never active. A website's funnel row exists only so its
 * leads, the lead cap and the activity log have a funnel to hang on; live or
 * paused lives on websites.status. Nothing here ever writes funnels.active
 * (store-server.test.ts pins it), and the funnel code paths never see these
 * rows (every funnel lookup filters kind='form', funnels/kind-isolation.test.ts).
 *
 * Nothing here touches the access gate's column list (src/lib/access.ts):
 * the plan check reads the account's own plan columns through isPaid().
 *
 * Reads and writes scoped by an owner id never take it from a request body:
 * the caller passes the signed-in account owner (ownerIdOrNull) or an admin's
 * choice, and an id from elsewhere finds nothing.
 */

const UUID = /^[0-9a-f-]{36}$/i;

// ── Settings ──

/** The five website switches and limits, as the app and the report run read them. */
export async function readWebsiteSettings(): Promise<WebsiteSettings> {
  const keys = Object.values(WEBSITE_KEYS);
  if (!hasServiceRole()) return parseWebsite(() => undefined);
  const { data, error } = await createAdminClient().from('billing_settings').select('key, value').in('key', keys);
  if (error) console.error('[websites] settings read failed, using defaults:', error.message);
  const kv = new Map<string, unknown>((data ?? []).map((r) => [String((r as { key: unknown }).key), (r as { value: unknown }).value]));
  return parseWebsite((key) => kv.get(key));
}

// ── The row ──

export interface WebsiteRow {
  id: string;
  /** The account owner. Never put this in a public payload. */
  userId: string;
  funnelId: string;
  slug: string;
  status: WebsiteStatus;
  settings: SiteSettings;
  /** The page copy, or null before any has been written. */
  pages: SiteCopy | null;
  regenCount: number;
  checks: Record<string, unknown>;
  invitedAt: string | null;
  approvedAt: string | null;
  liveAt: string | null;
  pausedAt: string | null;
  /** Batch 33's seam: ignored today. */
  domain: string | null;
}

const COLUMNS = 'id, user_id, funnel_id, slug, status, settings, pages, regen_count, checks, invited_at, approved_at, live_at, paused_at, domain';

export const EMPTY_SETTINGS: SiteSettings = {
  companyName: '',
  logoUrl: null,
  brandColour: null,
  areas: [],
  managementFeePct: null,
  contactEmail: '',
  contactPhone: '',
  photoUrl: null,
  aboutText: null,
};

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const textOrNull = (v: unknown, max: number): string | null => text(v, max) || null;

/** A stored settings value, tolerantly: a missing or malformed field reads as its empty value. */
export function parseSiteSettings(raw: unknown): SiteSettings {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const fee = typeof o.managementFeePct === 'number' && Number.isFinite(o.managementFeePct) && o.managementFeePct >= 0 && o.managementFeePct <= 100 ? o.managementFeePct : null;
  return {
    companyName: text(o.companyName, 80),
    logoUrl: textOrNull(o.logoUrl, 500),
    brandColour: textOrNull(o.brandColour, 7),
    areas: (Array.isArray(o.areas) ? o.areas : [])
      .map((a) => text(a, 60))
      .filter(Boolean)
      .slice(0, MAX_AREAS),
    managementFeePct: fee,
    contactEmail: text(o.contactEmail, 254),
    contactPhone: text(o.contactPhone, 40),
    photoUrl: textOrNull(o.photoUrl, 500),
    aboutText: textOrNull(o.aboutText, 2000),
  };
}

function parsePages(raw: unknown): SiteCopy | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const obj = (v: unknown) => Boolean(v) && typeof v === 'object';
  return obj(o.home) && Array.isArray(o.areas) && obj(o.fees) && obj(o.about) && obj(o.faq) ? (raw as SiteCopy) : null;
}

function iso(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function toRow(r: Record<string, unknown>): WebsiteRow {
  const status = (WEBSITE_STATUSES as readonly string[]).includes(String(r.status)) ? (r.status as WebsiteStatus) : 'invited';
  return {
    id: String(r.id),
    userId: String(r.user_id),
    funnelId: String(r.funnel_id),
    slug: String(r.slug),
    status,
    settings: parseSiteSettings(r.settings),
    pages: parsePages(r.pages),
    regenCount: Number(r.regen_count) || 0,
    checks: r.checks && typeof r.checks === 'object' && !Array.isArray(r.checks) ? (r.checks as Record<string, unknown>) : {},
    invitedAt: iso(r.invited_at),
    approvedAt: iso(r.approved_at),
    liveAt: iso(r.live_at),
    pausedAt: iso(r.paused_at),
    domain: iso(r.domain),
  };
}

// ── Reads ──

/** The public lookup: a LIVE site by slug (paused, preview and invited read as missing). */
export async function liveSiteBySlug(slug: string): Promise<WebsiteRow | null> {
  if (!hasServiceRole() || slugProblem(slug) !== null) return null;
  const { data, error } = await createAdminClient().from('websites').select(COLUMNS).eq('slug', slug).eq('status', 'live').maybeSingle();
  if (error) {
    console.error('[websites] live lookup failed:', error.message);
    return null;
  }
  return data ? toRow(data as Record<string, unknown>) : null;
}

/** A member's own site. `ownerId` is the signed-in ACCOUNT OWNER (ownerIdOrNull), never a team member's id. */
export async function ownSite(ownerId: string): Promise<WebsiteRow | null> {
  if (!hasServiceRole() || !UUID.test(ownerId)) return null;
  const { data, error } = await createAdminClient().from('websites').select(COLUMNS).eq('user_id', ownerId).maybeSingle();
  if (error) {
    console.error('[websites] own site lookup failed:', error.message);
    return null;
  }
  return data ? toRow(data as Record<string, unknown>) : null;
}

/** The signed-in person's site: only account owners have one (a team member's own id finds nothing). */
export async function ownSiteOfUser(user: Pick<User, 'id'> | null): Promise<WebsiteRow | null> {
  const ownerId = await ownerIdOrNull(user);
  return ownerId ? ownSite(ownerId) : null;
}

/** A site by id, for the report run and the cron (service role; no owner check: never expose it). */
export async function siteById(id: string): Promise<WebsiteRow | null> {
  if (!hasServiceRole() || !UUID.test(id)) return null;
  const { data, error } = await createAdminClient().from('websites').select(COLUMNS).eq('id', id).maybeSingle();
  if (error) {
    console.error('[websites] site lookup failed:', error.message);
    return null;
  }
  return data ? toRow(data as Record<string, unknown>) : null;
}

// ── Invite ──

export type InviteDenial = AccessDenial | 'already_has_site' | 'slug_invalid' | 'slug_taken' | 'unavailable';
export type InviteResult = { ok: true; site: WebsiteRow } | { ok: false; reason: InviteDenial; slugProblem?: SlugProblem };

/**
 * An admin gives a member a website. Only an account owner on a management
 * account may be invited (ownerIdOrNull, the management stamp), and the plan
 * gate, when it is on, needs a paid plan. One site per member: a second invite
 * finds the first. Creates the funnel row first (kind='website', active=false,
 * never switched on) and then the website, status 'invited'; a failure after
 * the funnel row removes it again, so no orphan funnel is left behind.
 */
export async function inviteWebsite(o: { memberId: string; invitedBy: string | null; slug?: string; companyName?: string }): Promise<InviteResult> {
  if (!hasServiceRole() || !UUID.test(o.memberId)) return { ok: false, reason: 'unavailable' };
  const admin = createAdminClient();

  // Account owners only: a team member's id never gets a site.
  const ownerId = await ownerIdOrNull({ id: o.memberId });
  if (!ownerId) return { ok: false, reason: 'not_owner' };

  const [{ data: profile }, settings] = await Promise.all([
    admin
      .from('profiles')
      .select('signup_path, plan, plan_code, plan_source, stripe_subscription_id, stripe_subscription_status, subscription_paused_from, subscription_paused_until, subscription_cancel_at')
      .eq('id', ownerId)
      .maybeSingle(),
    readWebsiteSettings(),
  ]);
  if (!profile) return { ok: false, reason: 'unavailable' };
  const p = profile as { signup_path?: string | null };
  const access = websiteAccess({ isManagement: isManagement(p.signup_path), isOwner: true, invited: false, paid: isPaid(profile as AccessProfile) }, settings.planGateOn, 'invite');
  if (!access.allowed) return { ok: false, reason: access.reason };

  if (await ownSite(ownerId)) return { ok: false, reason: 'already_has_site' };

  const slug = (o.slug ?? makeSlug(o.companyName ?? '')).trim().toLowerCase();
  const problem = slugProblem(slug);
  if (problem) return { ok: false, reason: 'slug_invalid', slugProblem: problem };
  const { data: taken } = await admin.from('websites').select('id').eq('slug', slug).maybeSingle();
  if (taken) return { ok: false, reason: 'slug_taken' };

  // The funnel row. active=false is set here and nowhere else touches it again.
  const { data: funnel, error: funnelError } = await admin
    .from('funnels')
    .insert({ user_id: ownerId, public_token: mintFunnelToken(), name: `Website: ${slug}`.slice(0, 80), kind: 'website', active: false })
    .select('id')
    .single();
  if (funnelError || !funnel) {
    console.error('[websites] invite: funnel row failed:', funnelError?.message);
    return { ok: false, reason: 'unavailable' };
  }
  const funnelId = (funnel as { id: string }).id;

  const settingsJson: SiteSettings = { ...EMPTY_SETTINGS, companyName: text(o.companyName, 80) };
  const { data: site, error: siteError } = await admin
    .from('websites')
    .insert({ user_id: ownerId, funnel_id: funnelId, slug, status: 'invited', settings: settingsJson, invited_by: o.invitedBy && UUID.test(o.invitedBy) ? o.invitedBy : null })
    .select(COLUMNS)
    .single();
  if (siteError || !site) {
    // Nothing hangs on the funnel yet: take it back out so no orphan is left.
    await admin.from('funnels').delete().eq('id', funnelId).eq('kind', 'website');
    const lost = (siteError as { code?: string } | null)?.code === '23505';
    if (lost) {
      // A second invite or the same slug won the race.
      if (await ownSite(ownerId)) return { ok: false, reason: 'already_has_site' };
      return { ok: false, reason: 'slug_taken' };
    }
    console.error('[websites] invite: website row failed:', siteError?.message);
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, site: toRow(site as Record<string, unknown>) };
}

// ── Setup flow writes (each scoped by the owner's id) ──

export type SaveResult<T = WebsiteRow> = { ok: true; site: T } | { ok: false; reason: 'not_found' | 'unavailable' };

/** Merges the changes into the stored settings (trimmed and bounded) and saves them. */
export async function saveSettings(ownerId: string, patch: Partial<SiteSettings>): Promise<SaveResult> {
  const current = await ownSite(ownerId);
  if (!current) return { ok: false, reason: 'not_found' };
  const merged = parseSiteSettings({ ...current.settings, ...patch });
  return updateOwn(ownerId, { settings: merged });
}

/** Saves the page copy (hand-written or drafted). Checks run before a site goes live, not here. */
export async function savePages(ownerId: string, pages: SiteCopy): Promise<SaveResult> {
  return updateOwn(ownerId, { pages });
}

/** Saves the last check result (checkSite) so the setup page can show it. */
export async function saveChecks(ownerId: string, checks: Record<string, unknown>): Promise<SaveResult> {
  return updateOwn(ownerId, { checks });
}

/** One more regeneration used. The cap (10) is the copy code's; this only counts. */
export async function bumpRegen(ownerId: string): Promise<SaveResult> {
  const current = await ownSite(ownerId);
  if (!current) return { ok: false, reason: 'not_found' };
  return updateOwn(ownerId, { regen_count: current.regenCount + 1 });
}

async function updateOwn(ownerId: string, patch: Record<string, unknown>): Promise<SaveResult> {
  if (!hasServiceRole() || !UUID.test(ownerId)) return { ok: false, reason: 'unavailable' };
  // Whitelisted by construction: callers above pass only these columns, never status, funnel_id, slug or user_id.
  const { data, error } = await createAdminClient()
    .from('websites')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('user_id', ownerId)
    .select(COLUMNS)
    .maybeSingle();
  if (error) {
    console.error('[websites] update failed:', error.message);
    return { ok: false, reason: 'unavailable' };
  }
  return data ? { ok: true, site: toRow(data as Record<string, unknown>) } : { ok: false, reason: 'not_found' };
}

// ── Status ──

/**
 * The status transitions. invited -> setup when the member starts; setup <->
 * preview as they edit and generate; preview -> live when approved (the go-live
 * checks run first, in golive-server); live <-> paused; a paused site may also
 * go back to preview to be edited. Everything else (invited straight to live,
 * live back to setup, ...) is refused.
 */
export const STATUS_TRANSITIONS: Record<WebsiteStatus, readonly WebsiteStatus[]> = {
  invited: ['setup'],
  setup: ['preview'],
  preview: ['setup', 'live'],
  live: ['paused'],
  paused: ['live', 'preview'],
};

export function canMoveStatus(from: WebsiteStatus, to: WebsiteStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

export type StatusResult = { ok: true; site: WebsiteRow } | { ok: false; reason: 'not_found' | 'not_allowed' | 'conflict' | 'unavailable' };

/**
 * Moves a site to a new status. Conditional on the status read a moment ago, so
 * two clicks cannot both win. Stamps approved_at / live_at (first time only) and
 * paused_at. The caller has already decided the person may (websiteAccess,
 * golive checks); this never touches the funnel row.
 */
export async function setStatus(ownerId: string, to: WebsiteStatus): Promise<StatusResult> {
  if (!hasServiceRole()) return { ok: false, reason: 'unavailable' };
  const current = await ownSite(ownerId);
  if (!current) return { ok: false, reason: 'not_found' };
  if (!canMoveStatus(current.status, to)) return { ok: false, reason: 'not_allowed' };

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { status: to, updated_at: now };
  if (to === 'live') {
    patch.approved_at = current.approvedAt ?? now;
    patch.live_at = current.liveAt ?? now;
    patch.paused_at = null;
  }
  if (to === 'paused') patch.paused_at = now;

  const { data, error } = await createAdminClient()
    .from('websites')
    .update(patch)
    .eq('id', current.id)
    .eq('user_id', ownerId)
    .eq('status', current.status)
    .select(COLUMNS)
    .maybeSingle();
  if (error) {
    console.error('[websites] status change failed:', error.message);
    return { ok: false, reason: 'unavailable' };
  }
  return data ? { ok: true, site: toRow(data as Record<string, unknown>) } : { ok: false, reason: 'conflict' };
}

/**
 * Batch 31, Phase 10: Approve's rollback. A site that went live and failed the
 * public-page checks goes straight back to preview (the one move STATUS_TRANSITIONS
 * does not allow, so it is its own function), and approved_at / live_at go back to
 * what they were before the attempt (null for a first go-live). Conditional on the
 * site still being live, scoped by the owner's id; never touches the funnel row.
 */
export async function rollbackToPreview(ownerId: string, restore: { approvedAt: string | null; liveAt: string | null }): Promise<boolean> {
  if (!hasServiceRole() || !UUID.test(ownerId)) return false;
  const { data, error } = await createAdminClient()
    .from('websites')
    .update({ status: 'preview', approved_at: restore.approvedAt, live_at: restore.liveAt, updated_at: new Date().toISOString() })
    .eq('user_id', ownerId)
    .eq('status', 'live')
    .select('id');
  if (error) {
    console.error('[websites] rollback to preview failed:', error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}
