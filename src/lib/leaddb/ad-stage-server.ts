import 'server-only';

import { createAdminClient } from '../supabase/admin';
import { isCalculatorMode } from '../websites/calculator';
import type { AdStageDeps } from './ad-stage';

/**
 * The live wiring for the lead database's stage push on an ad lead (Batch 55 step 2). The decision is in
 * ad-stage.ts. Service role only. Writes only stage, stage_changed_at, ld_stage_as_of and meeting_reached_at on
 * `leads`: never status or crm_pushed_at. Log lines carry a code at most.
 */

const db = () => createAdminClient();

export function liveAdStageDeps(): AdStageDeps {
  return {
    async ownerOfCustomer(ldCustomerId) {
      const { data, error } = await db().from('leaddb_ad_accounts').select('owner_id').eq('ld_customer_id', ldCustomerId).maybeSingle();
      if (error) throw new Error(`stage_account_read_failed:${error.code ?? 'error'}`);
      return (data as { owner_id: string } | null)?.owner_id ?? null;
    },

    async lead(ownerId, leadId) {
      const admin = db();
      const { data, error } = await admin
        .from('leads')
        .select('id, user_id, ld_stage_as_of, meeting_reached_at')
        .eq('id', leadId)
        .eq('user_id', ownerId)
        .maybeSingle();
      if (error) throw new Error(`stage_lead_read_failed:${error.code ?? 'error'}`);
      if (!data) return null;
      const row = data as { id: string; user_id: string; ld_stage_as_of: string | null; meeting_reached_at: string | null };
      const { data: rep } = await admin.from('website_reports').select('website_id').eq('lead_id', leadId).maybeSingle();
      let calculator = false;
      const websiteId = (rep as { website_id?: string } | null)?.website_id;
      if (websiteId) {
        const { data: site } = await admin.from('websites').select('mode').eq('id', websiteId).maybeSingle();
        calculator = isCalculatorMode((site as { mode?: unknown } | null)?.mode);
      }
      return { id: row.id, ownerId: row.user_id, calculator, ldStageAsOf: row.ld_stage_as_of, meetingReachedAt: row.meeting_reached_at };
    },

    async writeStage(ownerId, leadId, stage, stageAtIso) {
      const { data, error } = await db()
        .from('leads')
        .update({ stage, stage_changed_at: stageAtIso, ld_stage_as_of: stageAtIso })
        .eq('id', leadId)
        .eq('user_id', ownerId)
        .or(`ld_stage_as_of.is.null,ld_stage_as_of.lte.${stageAtIso}`)
        .select('id');
      if (error) throw new Error(`stage_write_failed:${error.code ?? 'error'}`);
      return (data ?? []).length > 0;
    },

    async stampMeeting(ownerId, leadId, atIso) {
      const { error } = await db()
        .from('leads')
        .update({ meeting_reached_at: atIso })
        .eq('id', leadId)
        .eq('user_id', ownerId)
        .is('meeting_reached_at', null);
      // A missed stamp is logged (a code), never shown as a failed stage move.
      if (error) console.error('[leaddb-ad-stage] meeting stamp failed:', error.code ?? 'error');
    },
  };
}
