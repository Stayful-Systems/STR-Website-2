import 'server-only';

/**
 * Batch 36: the real wiring of the edit run (edit-run.ts): the database, the
 * copy writer, the file store, the page fetch and activity.
 *
 * Owner scoping: editRunFor(ownerId) is the ONLY way in, and ownerId is the
 * signed-in account owner the caller already resolved (websiteActor ->
 * ownerIdOrNull). The site is found from that id (ownSite), and every write
 * below is keyed by that site's id, read here, never taken from a caller. A
 * version number a caller passes (restore) is looked up among THIS site's
 * versions only.
 *
 * Nothing here logs a setting, a page of copy or an address: failures log a
 * table name and a code.
 */
import { recordActivity } from '../activity/log';
import { deleteLogoIfOurs, uploadLogo } from '../funnels/storage';
import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { sanitiseCopy } from '../../app/leads/setup/website/steps';
import { generateSiteCopy } from './copy-server';
import { createEditRun, type Allowance, type EditDeps, type EditDraft, type EditRun, type EditSite, type PublishRpc, type VersionRow } from './edit-run';
import type { SiteCopy, SiteSettings } from './page-model';
import { ownSite, parseSiteSettings, type WebsiteRow } from './store-server';

const KINDS = ['approved', 'publish', 'restore'] as const;

const copyOrNull = (raw: unknown): SiteCopy | null => sanitiseCopy(raw);

/** The site as the run reads it: the owner's row plus whether the grace process switched it off. */
async function editSite(row: WebsiteRow): Promise<EditSite> {
  let switchedOff = false;
  if (row.status === 'paused') {
    const { data } = await createAdminClient().from('website_grace').select('switched_off_at, cancelled_at').eq('website_id', row.id).maybeSingle();
    const g = data as { switched_off_at: string | null; cancelled_at: string | null } | null;
    switchedOff = Boolean(g?.switched_off_at) && !g?.cancelled_at;
  }
  return { id: row.id, slug: row.slug, domain: row.domain, status: row.status, settings: row.settings, pages: row.pages, switchedOff };
}

function toDraft(r: Record<string, unknown>, fallback: SiteCopy | null): EditDraft {
  return {
    settings: parseSiteSettings(r.settings),
    pages: copyOrNull(r.pages) ?? fallback ?? ({ home: { headline: '', subheadline: '', intro: '', benefits: [] }, areas: [], fees: { headline: '', body: '', includes: [] }, about: { headline: '', body: '' }, faq: { headline: '', items: [] } } satisfies SiteCopy),
    baseVersion: typeof r.base_version === 'number' ? r.base_version : null,
    pendingPages: Array.isArray(r.pending_pages) ? (r.pending_pages as unknown[]).filter((p): p is string => typeof p === 'string') : [],
  };
}

function toVersion(r: Record<string, unknown>): VersionRow {
  const kind = (KINDS as readonly string[]).includes(String(r.kind)) ? (r.kind as VersionRow['kind']) : 'publish';
  return {
    id: String(r.id),
    versionNo: Number(r.version_no),
    settings: parseSiteSettings(r.settings),
    pages: copyOrNull(r.pages),
    kind,
    restoredFrom: typeof r.restored_from === 'number' ? r.restored_from : null,
    publishedAt: String(r.published_at ?? ''),
  };
}

/** The deps for one owner's site. `row` is the site found from the signed-in owner, so every id below is theirs. */
function depsFor(ownerId: string, row: WebsiteRow): EditDeps {
  const admin = () => createAdminClient();
  const websiteId = row.id;
  const code = (where: string, e: { message?: string } | null) => console.error(`[website-edit] ${where} failed: ${(e?.message ?? 'error').slice(0, 80)}`);

  return {
    site: async () => {
      const fresh = await ownSite(ownerId);
      return fresh ? editSite(fresh) : null;
    },
    now: () => new Date(),
    readDraft: async () => {
      const { data, error } = await admin().from('website_drafts').select('settings, pages, base_version, pending_pages').eq('website_id', websiteId).maybeSingle();
      if (error) {
        code('read draft', error);
        return null;
      }
      return data ? toDraft(data as Record<string, unknown>, row.pages) : null;
    },
    writeDraft: async (d) => {
      const { error } = await admin()
        .from('website_drafts')
        .upsert({ website_id: websiteId, settings: d.settings, pages: d.pages, base_version: d.baseVersion, pending_pages: d.pendingPages, updated_at: new Date().toISOString() }, { onConflict: 'website_id' });
      if (error) code('write draft', error);
      return !error;
    },
    deleteDraft: async () => {
      const { error } = await admin().from('website_drafts').delete().eq('website_id', websiteId);
      if (error) code('delete draft', error);
      return !error;
    },
    snapshot: async () => {
      const { data, error } = await admin().rpc('website_version_snapshot', { p_website: websiteId, p_by: ownerId });
      if (error) {
        code('snapshot', error);
        return null;
      }
      return typeof data === 'number' ? data : null;
    },
    listVersions: async () => {
      const { data, error } = await admin()
        .from('website_versions')
        .select('id, version_no, settings, pages, kind, restored_from, published_at')
        .eq('website_id', websiteId)
        .order('version_no', { ascending: false });
      if (error) {
        code('list versions', error);
        return [];
      }
      return (data ?? []).map((r) => toVersion(r as Record<string, unknown>));
    },
    publish: async (a): Promise<PublishRpc | null> => {
      const { data, error } = await admin().rpc('website_version_publish', {
        p_website: websiteId,
        p_base_version: a.base,
        p_settings: a.settings,
        p_pages: a.pages,
        p_kind: a.kind,
        p_restored_from: a.restoredFrom,
        p_by: ownerId,
      });
      if (error) {
        code('publish', error);
        return null;
      }
      const r = data as { result?: string; version_no?: number; version_id?: string; pruned?: string[] } | null;
      if (r?.result === 'stale') return { result: 'stale' };
      if (r?.result === 'published' && typeof r.version_no === 'number' && typeof r.version_id === 'string') {
        return { result: 'published', versionNo: r.version_no, versionId: r.version_id, pruned: Array.isArray(r.pruned) ? r.pruned : [] };
      }
      return null;
    },
    revert: async (a) => {
      const now = new Date().toISOString();
      const { error } = await admin().from('websites').update({ settings: a.previous.settings, pages: a.previous.pages ?? {}, updated_at: now }).eq('id', websiteId);
      if (error) {
        code('revert site', error);
        return false;
      }
      // The version that failed its page checks is not part of the history.
      const gone = await admin().from('website_versions').delete().eq('website_id', websiteId).eq('version_no', a.versionNo);
      if (gone.error) code('revert version', gone.error);
      if (a.draft) {
        const back = await admin()
          .from('website_drafts')
          .upsert({ website_id: websiteId, settings: a.draft.settings, pages: a.draft.pages, base_version: a.draft.baseVersion, pending_pages: a.draft.pendingPages, updated_at: now }, { onConflict: 'website_id' });
        if (back.error) code('revert draft', back.error);
      }
      return true;
    },
    readAllowance: async (): Promise<Allowance | null> => {
      const { data, error } = await admin().from('websites').select('edit_rewrites_month, edit_rewrites_used').eq('id', websiteId).maybeSingle();
      if (error || !data) return null;
      const r = data as { edit_rewrites_month: string | null; edit_rewrites_used: number | null };
      return { month: r.edit_rewrites_month, used: Number(r.edit_rewrites_used) || 0 };
    },
    takeAllowance: async (from, to) => {
      let q = admin().from('websites').update({ edit_rewrites_month: to.month, edit_rewrites_used: to.used }).eq('id', websiteId).eq('edit_rewrites_used', from.used);
      q = from.month === null ? q.is('edit_rewrites_month', null) : q.eq('edit_rewrites_month', from.month);
      const { data, error } = await q.select('id');
      if (error) code('take allowance', error);
      return !error && (data?.length ?? 0) === 1;
    },
    giveBackAllowance: async (taken, to) => {
      let q = admin().from('websites').update({ edit_rewrites_month: to.month, edit_rewrites_used: to.used }).eq('id', websiteId).eq('edit_rewrites_used', taken.used);
      q = taken.month === null ? q.is('edit_rewrites_month', null) : q.eq('edit_rewrites_month', taken.month);
      const { error } = await q;
      if (error) code('give back allowance', error);
    },
    writeCopy: async ({ settings, only }) => {
      const r = await generateSiteCopy({ websiteId, site: { slug: row.slug, domain: row.domain }, settings: settings as SiteSettings, kind: 'edit', only });
      return r.ok ? { ok: true, copy: r.copy } : { ok: false, message: r.message };
    },
    uploadImage: async (bytes) => uploadLogo({ userId: ownerId, funnelId: row.funnelId, bytes }),
    deleteFile: (url) => deleteLogoIfOurs(url),
    fetchPage: (url, init) => fetch(url, init),
    record: (kind, opts) => recordActivity(ownerId, kind, { dedupeKey: opts.dedupeKey, extras: opts.extras }),
  };
}

/**
 * The edit run for the signed-in account owner's own site, or null when they
 * have none (or the service role is not configured). `ownerId` must come from
 * websiteActor(): this never accepts a website, funnel or version id.
 */
export async function editRunFor(ownerId: string): Promise<EditRun | null> {
  if (!hasServiceRole()) return null;
  const row = await ownSite(ownerId);
  if (!row) return null;
  return createEditRun(depsFor(ownerId, row));
}
