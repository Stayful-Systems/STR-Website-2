import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { SHEET_SETTING_KEYS, parseSheetSettings } from './settings.ts';
import { readRanking } from './ranking.ts';
import type { RankAdRef, RankLead, RankLink, RankingStore, RankingView } from './ranking.ts';

/**
 * Batch 35 (Phase 9): the real store behind "Your ads". Service role only.
 *
 * Reads ONLY `leads` (user_id = the owner, archived leads left out) and
 * `ad_pack_lead_links` (owner_id = the owner), plus the three billing_settings
 * rows the ranking needs. Writes nothing. Both tables have RLS on with no
 * policy, so every read is filtered by the owner here and checked again in
 * ranking.ts. A failure logs a table name and the database's error code at
 * most: never a lead, an address or a row.
 */

const db = () => createAdminClient();
const PAGE = 1000;
/** A hard stop so one account can never make this read unbounded. */
const MAX_ROWS = 20_000;

function fail(table: string, code: string | undefined): never {
  console.error(`[ad-sheets] ${table} failed:`, code ?? 'error');
  throw new Error('db');
}

export function supabaseRankingStore(): RankingStore {
  return {
    async leads(ownerId) {
      const out: RankLead[] = [];
      for (let from = 0; from < MAX_ROWS; from += PAGE) {
        const { data, error } = await db()
          .from('leads')
          .select('id, user_id, stage, meeting_reached_at, created_at')
          .eq('user_id', ownerId)
          .is('archived_at', null)
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) fail('leads', error.code);
        const rows = (data ?? []) as { id: string; user_id: string; stage: string | null; meeting_reached_at: string | null; created_at: string }[];
        for (const r of rows) {
          out.push({ id: r.id, ownerId: r.user_id, stage: r.stage ?? 'new', meetingReachedAt: r.meeting_reached_at, createdAt: r.created_at, archived: false });
        }
        if (rows.length < PAGE) break;
      }
      return out;
    },

    async links(ownerId) {
      const out: RankLink[] = [];
      for (let from = 0; from < MAX_ROWS; from += PAGE) {
        const { data, error } = await db()
          .from('ad_pack_lead_links')
          .select('lead_id, owner_id, pack_ad_id, match, ad_code_seen')
          .eq('owner_id', ownerId)
          .order('lead_id', { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) fail('ad_pack_lead_links', error.code);
        const rows = (data ?? []) as { lead_id: string; owner_id: string; pack_ad_id: string | null; match: string; ad_code_seen: string | null }[];
        for (const r of rows) out.push({ leadId: r.lead_id, ownerId: r.owner_id, packAdId: r.pack_ad_id, match: r.match, adCodeSeen: r.ad_code_seen });
        if (rows.length < PAGE) break;
      }
      return out;
    },

    async settings() {
      const keys = [SHEET_SETTING_KEYS.minLeads, SHEET_SETTING_KEYS.outcomePct, SHEET_SETTING_KEYS.outcomeAgeDays];
      const { data, error } = await db().from('billing_settings').select('key, value').in('key', keys);
      // A missing or unreadable setting falls back to its default.
      return parseSheetSettings(error ? [] : ((data ?? []) as { key: string; value: unknown }[]));
    },
  };
}

/** The ranking for one owner, or null when the database is not reachable (the section then stays out of the way). */
export async function ownerRanking(ownerId: string, ads: readonly RankAdRef[], now: Date = new Date()): Promise<RankingView | null> {
  if (!hasServiceRole()) return null;
  try {
    return await readRanking(supabaseRankingStore(), ownerId, ads, now);
  } catch {
    return null;
  }
}
