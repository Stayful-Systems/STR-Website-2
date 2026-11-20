'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { ownerIdOrNull } from '@/lib/leads/scope';
import { hasServiceRole } from '@/lib/supabase/admin';
import { recordActivity } from '@/lib/activity/log';
import { startLink, confirmLink, revokeLink, testPush } from '@/lib/leaddb/links';
import { supabaseLinkDeps } from '@/lib/leaddb/store';
import { leadDbConfig } from '@/lib/leaddb/client';
import { leadDbMessage, needsAccount, NOT_AVAILABLE } from '@/lib/leaddb/messages';

/**
 * Connecting the lead database (Batch 32). Every action resolves the session
 * itself and acts for the OWNER only: a team member gets "Only the account
 * owner can change this." (they see the status, never the controls). Nothing
 * the lead database says reaches the browser as it came: codes become
 * sentences (messages.ts), and the connect code itself is never stored here.
 */

export interface LeadDbState {
  error?: string;
  notice?: string;
  /** True when the email has no lead database account: the panel then offers "Get the lead database". */
  noAccount?: boolean;
}

const MEMBER_REFUSED = 'Only the account owner can change this.';

async function owner(): Promise<{ id: string } | 'member' | null> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const ownerId = await ownerIdOrNull(user);
  return ownerId ? { id: ownerId } : 'member';
}

/** Common gate: signed in, the owner, service role present, link configured. */
async function gate(): Promise<{ id: string } | LeadDbState> {
  const who = await owner();
  if (!who) return { error: 'Please sign in again.' };
  if (who === 'member') return { error: MEMBER_REFUSED };
  if (!hasServiceRole() || leadDbConfig() === null) return { error: NOT_AVAILABLE };
  return who;
}

const isState = (g: { id: string } | LeadDbState): g is LeadDbState => !('id' in g);

export async function sendCodeAction(_prev: LeadDbState, formData: FormData): Promise<LeadDbState> {
  const g = await gate();
  if (isState(g)) return g;
  const out = await startLink(g.id, String(formData.get('email') ?? ''), supabaseLinkDeps());
  revalidatePath('/leads/integrations');
  if (!out.ok) return { error: leadDbMessage(out.code), noAccount: needsAccount(out.code) };
  return { notice: 'We have emailed a 6-digit code to the login email of that lead database account. It lasts 15 minutes.' };
}

export async function confirmCodeAction(_prev: LeadDbState, formData: FormData): Promise<LeadDbState> {
  const g = await gate();
  if (isState(g)) return g;
  const out = await confirmLink(g.id, String(formData.get('code') ?? ''), supabaseLinkDeps());
  revalidatePath('/leads/integrations');
  if (!out.ok) return { error: leadDbMessage(out.code) };
  await recordActivity(g.id, 'leaddb_connected');
  return { notice: 'Connected. New website leads now go into your lead database too.' };
}

export async function testLeadAction(): Promise<LeadDbState> {
  const g = await gate();
  if (isState(g)) return g;
  const out = await testPush(g.id, supabaseLinkDeps());
  revalidatePath('/leads/integrations');
  if (!out.ok) return { error: leadDbMessage(out.code) };
  return { notice: 'Test lead sent. Look for “Test lead from Stayful Intelligence” in your lead database.' };
}

export async function disconnectLeadDbAction(): Promise<LeadDbState> {
  const who = await owner();
  if (!who) return { error: 'Please sign in again.' };
  if (who === 'member') return { error: MEMBER_REFUSED };
  if (!hasServiceRole()) return { error: NOT_AVAILABLE };
  await revokeLink(who.id, supabaseLinkDeps());
  revalidatePath('/leads/integrations');
  return { notice: 'Disconnected. Website leads will stay in Stayful Intelligence only.' };
}
