import 'server-only';

import { createAdminClient, hasServiceRole } from '../supabase/admin';
import { isCalculatorMode } from '../websites/calculator';

/**
 * Batch 55 step 2: what the lead view needs to word an ad lead (rule 12): whether the lead came from a calculator site,
 * and whether it is a repeat landlord (the delivery row's frozen repeat_of_lead_id). Flags only: never a lead's
 * details, the result or an address. The caller has already found the lead under the signed-in owner's id.
 */
export async function adLeadPanelFacts(leadId: string): Promise<{ adLead: boolean; repeat: boolean }> {
  const none = { adLead: false, repeat: false };
  if (!hasServiceRole()) return none;
  try {
    const admin = createAdminClient();
    const { data: rep } = await admin.from('website_reports').select('website_id').eq('lead_id', leadId).maybeSingle();
    const websiteId = (rep as { website_id?: string } | null)?.website_id;
    if (!websiteId) return none;
    const { data: site } = await admin.from('websites').select('mode').eq('id', websiteId).maybeSingle();
    if (!isCalculatorMode((site as { mode?: unknown } | null)?.mode)) return none;
    const { data: delivery } = await admin.from('leaddb_ad_deliveries').select('repeat_of_lead_id').eq('lead_id', leadId).maybeSingle();
    return { adLead: true, repeat: Boolean((delivery as { repeat_of_lead_id?: string | null } | null)?.repeat_of_lead_id) };
  } catch {
    console.error('[leaddb-ad] panel facts failed for lead', leadId);
    return none;
  }
}
