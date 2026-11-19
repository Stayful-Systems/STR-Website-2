import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { countBy, weekStart } from './invite-run';
import { readWebsiteSettings } from './store-server';
import type { WebsiteSettings } from './settings';

/**
 * Batch 31, Phase 11: what the admin panel (/admin/management) shows about
 * customer websites. Read only, service role. Never lead contact details or
 * addresses: counts, the member's account email and the site's own fields.
 */

export interface AdminSiteRow {
  id: string;
  slug: string;
  status: string;
  member: string;
  /** Leads on the site's funnel in the last seven days. */
  leadsThisWeek: number;
  /** Free reports claimed today (UK day) from website_report_slots. */
  freeToday: number;
  /** Reports held for the daily limit (held_cap). */
  heldBacklog: number;
  pausedAt: string | null;
  liveAt: string | null;
}

export interface WebsitesAdminData {
  available: boolean;
  readError: string | null;
  settings: WebsiteSettings;
  /** The UK day the "free today" counts are for. */
  ukDay: string | null;
  sites: AdminSiteRow[];
}

const LIMIT = 20_000;

export async function loadWebsitesAdmin(): Promise<WebsitesAdminData> {
  const settings = await readWebsiteSettings();
  if (!hasServiceRole()) return { available: false, readError: null, settings, ukDay: null, sites: [] };
  const admin = createAdminClient();

  const { data: siteRows, error: siteError } = await admin
    .from('websites')
    .select('id, user_id, funnel_id, slug, status, paused_at, live_at')
    .order('created_at', { ascending: false })
    .limit(500);
  if (siteError) return { available: true, readError: siteError.message, settings, ukDay: null, sites: [] };
  const sites = (siteRows ?? []) as Array<{ id: string; user_id: string; funnel_id: string; slug: string; status: string; paused_at: string | null; live_at: string | null }>;
  if (sites.length === 0) return { available: true, readError: null, settings, ukDay: null, sites: [] };

  const ids = sites.map((s) => s.id);
  const funnelIds = sites.map((s) => s.funnel_id);
  const userIds = sites.map((s) => s.user_id);
  const { data: day } = await admin.rpc('website_uk_day');
  const ukDay = typeof day === 'string' ? day : null;

  const [profiles, slots, held, leads] = await Promise.all([
    admin.from('profiles').select('id, email').in('id', userIds),
    ukDay ? admin.from('website_report_slots').select('website_id').eq('day', ukDay).in('website_id', ids).limit(LIMIT) : Promise.resolve({ data: [], error: null }),
    admin.from('website_reports').select('website_id').eq('state', 'held_cap').in('website_id', ids).limit(LIMIT),
    // Only the funnel id comes back: no names, emails, phones or addresses.
    admin.from('leads').select('funnel_id').in('funnel_id', funnelIds).gte('created_at', weekStart(new Date())).limit(LIMIT),
  ]);
  const readError = profiles.error?.message ?? slots.error?.message ?? held.error?.message ?? leads.error?.message ?? null;

  const emails = new Map((profiles.data ?? []).map((p) => [String((p as { id: unknown }).id), (p as { email: string | null }).email]));
  const freeBy = countBy((slots.data ?? []).map((r) => (r as { website_id: unknown }).website_id));
  const heldBy = countBy((held.data ?? []).map((r) => (r as { website_id: unknown }).website_id));
  const leadsBy = countBy((leads.data ?? []).map((r) => (r as { funnel_id: unknown }).funnel_id));

  return {
    available: true,
    readError,
    settings,
    ukDay,
    sites: sites.map((s) => ({
      id: s.id,
      slug: s.slug,
      status: s.status,
      member: emails.get(s.user_id) ?? s.user_id,
      leadsThisWeek: leadsBy.get(s.funnel_id) ?? 0,
      freeToday: freeBy.get(s.id) ?? 0,
      heldBacklog: heldBy.get(s.id) ?? 0,
      pausedAt: s.paused_at,
      liveAt: s.live_at,
    })),
  };
}
