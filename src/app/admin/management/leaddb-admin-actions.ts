'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { isAdminEmail } from '@/lib/admin';
import { leadDbRetry, leadDbRetryPreview } from '@/lib/leaddb/store';

/**
 * Batch 32: /admin/management's lead database failures. Each action checks
 * the admin itself. The dry run only READS (no insert, update, upsert or rpc:
 * leaddb-admin.test.ts pins that); the retry only resets one delivery row, and
 * the cron then sends it. Nothing here returns a lead's contact details.
 */

async function requireAdmin(): Promise<{ email: string }> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user || !isAdminEmail(data.user.email)) throw new Error('Not allowed');
  return { email: data.user.email! };
}

const UUID = /^[0-9a-f-]{36}$/i;

export interface LeadDbRetryResult {
  ok: boolean;
  message: string;
}

export async function dryRunLeadDbRetryAction(leadId: string): Promise<LeadDbRetryResult> {
  await requireAdmin();
  if (!UUID.test(leadId)) return { ok: false, message: 'That is not a lead id.' };
  return leadDbRetryPreview(leadId);
}

export async function leadDbRetryAction(leadId: string): Promise<LeadDbRetryResult> {
  const admin = await requireAdmin();
  if (!UUID.test(leadId)) return { ok: false, message: 'That is not a lead id.' };
  // The preview's refusals are the real ones: a retry against a dead link would only fail again.
  const preview = await leadDbRetryPreview(leadId);
  if (!preview.ok) return preview;
  const done = await leadDbRetry(leadId);
  console.info(`[admin] leaddb: ${admin.email} retried lead ${leadId}`);
  revalidatePath('/admin/management');
  return done ? { ok: true, message: 'Reset. It will be sent on the next run.' } : { ok: false, message: 'Nothing changed: it may have gone through in the meantime.' };
}
