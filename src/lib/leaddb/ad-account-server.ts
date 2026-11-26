import 'server-only';

import { createAdminClient } from '../supabase/admin';
import {
  rowToAdAccount,
  shouldApplyState,
  stateToRowPatch,
  type AdAccountState,
  type LeadDbAdAccount,
  type LeadDbAdAccountRow,
} from './ad-account';

/**
 * The real database behind the lead database ad account (Batch 55, Part A).
 * Service role only: `leaddb_ad_accounts` has RLS on with no policy.
 *
 * A pushed state never touches `allowed`, `allowed_by` or `allowed_at`: those
 * are Zac's (`setAdAccountAllowed`). Log lines carry an owner id or a code at
 * most, never an email or a body.
 */

const COLUMNS =
  'owner_id, ld_customer_id, link_id, allowed, allowed_by, allowed_at, card_on_file, account_status, cancel_effective_at, lapsed, state_as_of, created_at, updated_at';

const db = () => createAdminClient();

export async function readAdAccount(ownerId: string): Promise<LeadDbAdAccount | null> {
  const { data, error } = await db().from('leaddb_ad_accounts').select(COLUMNS).eq('owner_id', ownerId).maybeSingle();
  if (error) {
    console.error('[leaddb-ad-account] read failed:', error.code ?? 'error');
    return null;
  }
  return data ? rowToAdAccount(data as LeadDbAdAccountRow) : null;
}

export async function readAdAccountByCustomerId(ldCustomerId: string): Promise<LeadDbAdAccount | null> {
  const { data, error } = await db().from('leaddb_ad_accounts').select(COLUMNS).eq('ld_customer_id', ldCustomerId).maybeSingle();
  if (error) {
    console.error('[leaddb-ad-account] read by customer failed:', error.code ?? 'error');
    return null;
  }
  return data ? rowToAdAccount(data as LeadDbAdAccountRow) : null;
}

/**
 * Stores a pushed state. 'stale' when it is older than the one held (an equal
 * time is applied); 'no_account' when the owner has no row. Never changes
 * allowed, allowed_by or allowed_at.
 */
export async function applyAdAccountState(ownerId: string, state: AdAccountState): Promise<'applied' | 'stale' | 'no_account'> {
  const current = await readAdAccount(ownerId);
  if (!current) return 'no_account';
  if (!shouldApplyState(current, state)) return 'stale';
  // The filter repeats the rule in SQL so two pushes landing together cannot let the older one win (UTC form: a + offset breaks a URL filter).
  const { data, error } = await db()
    .from('leaddb_ad_accounts')
    .update({ ...stateToRowPatch(state), updated_at: new Date().toISOString() })
    .eq('owner_id', ownerId)
    .or(`state_as_of.is.null,state_as_of.lte.${new Date(state.stateAsOf).toISOString()}`)
    .select('owner_id');
  if (error) {
    console.error('[leaddb-ad-account] apply failed:', error.code ?? 'error');
    throw new Error(`ad_account_apply_failed:${error.code ?? 'error'}`);
  }
  return (data ?? []).length > 0 ? 'applied' : 'stale';
}

/**
 * Creates the owner's row with allowed = false. Idempotent: the same owner and
 * the same lead database customer again is 'exists'. 'conflict' when the owner
 * already has a row for a DIFFERENT customer id, or the customer id belongs to
 * another owner. Throws (with a code only) on a database error.
 */
export async function createAdAccount(input: {
  ownerId: string;
  ldCustomerId: string;
  linkId?: string | null;
  state: AdAccountState;
}): Promise<'created' | 'exists' | 'conflict'> {
  const decide = async (): Promise<'exists' | 'conflict' | null> => {
    const mine = await readAdAccount(input.ownerId);
    if (mine) return mine.ldCustomerId === input.ldCustomerId ? 'exists' : 'conflict';
    const theirs = await readAdAccountByCustomerId(input.ldCustomerId);
    if (theirs) return theirs.ownerId === input.ownerId ? 'exists' : 'conflict';
    return null;
  };

  const before = await decide();
  if (before) return before;

  const nowIso = new Date().toISOString();
  const { error } = await db()
    .from('leaddb_ad_accounts')
    .insert({
      owner_id: input.ownerId,
      ld_customer_id: input.ldCustomerId,
      link_id: input.linkId ?? null,
      allowed: false,
      ...stateToRowPatch(input.state),
      created_at: nowIso,
      updated_at: nowIso,
    });
  if (!error) return 'created';
  if (error.code === '23505') {
    // Lost a race with another insert: read again and answer from what is there.
    const after = await decide();
    if (after) return after;
  }
  console.error('[leaddb-ad-account] create failed:', error.code ?? 'error');
  throw new Error(`ad_account_create_failed:${error.code ?? 'error'}`);
}

/**
 * Zac's switch for one owner (the admin screen, phase A8). Stamps who and when
 * on every change, on or off. False when the owner has no row.
 */
export async function setAdAccountAllowed(ownerId: string, allowed: boolean, adminId: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const { data, error } = await db()
    .from('leaddb_ad_accounts')
    .update({ allowed, allowed_by: adminId, allowed_at: nowIso, updated_at: nowIso })
    .eq('owner_id', ownerId)
    .select('owner_id');
  if (error) {
    console.error('[leaddb-ad-account] allow failed:', error.code ?? 'error');
    throw new Error(`ad_account_allow_failed:${error.code ?? 'error'}`);
  }
  return (data ?? []).length > 0;
}
