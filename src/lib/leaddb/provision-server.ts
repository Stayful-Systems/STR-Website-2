import 'server-only';

import { createAdminClient } from '../supabase/admin';
import { emailKey } from '../supabase/email-key';
import { ensureCalculatorSite } from '../websites/store-server';
import { applyAdAccountState, createAdAccount, readAdAccount, readAdAccountByCustomerId } from './ad-account-server';
import { applyAdProfile } from './ad-profile-server';
import type { ProvisionDeps } from './provision-run';

/**
 * The live wiring for the ad route's provision call (Batch 55, Part A, A3).
 * The decisions are in provision-run.ts. Service role only. Nothing here
 * sends an email or logs a person's details: a log line carries a code.
 */

const db = () => createAdminClient();

/** The profile (a login's row) for an email, if any. */
async function profileIdByEmail(email: string): Promise<string | null> {
  const { data, error } = await db().from('profiles').select('id').eq('email', emailKey(email)).limit(1);
  if (error) {
    console.error('[leaddb-ad-route] profile lookup failed:', error.code ?? 'error');
    throw new Error(`profile_lookup_failed:${error.code ?? 'error'}`);
  }
  return ((data ?? [])[0] as { id: string } | undefined)?.id ?? null;
}

/** The three mandatory profile questions are answered (as stampManagement reads it). False on any failure. */
async function quizDone(userId: string): Promise<boolean> {
  try {
    const { profileSummaryFor } = await import('../profile/server');
    const s = await profileSummaryFor(userId);
    return Boolean(s?.progress.mandatoryDone);
  } catch {
    return false;
  }
}

export function liveProvisionDeps(): ProvisionDeps {
  return {
    readAccountByCustomerId: readAdAccountByCustomerId,
    readAccountByOwner: readAdAccount,
    applyState: applyAdAccountState,
    createAccount: (input) => createAdAccount(input),
    findOwnerByEmail: profileIdByEmail,

    async isTeamMember(userId) {
      const { data, error } = await db().from('team_members').select('member_id').eq('member_id', userId).maybeSingle();
      if (error) {
        console.error('[leaddb-ad-route] team lookup failed:', error.code ?? 'error');
        throw new Error(`team_lookup_failed:${error.code ?? 'error'}`);
      }
      return Boolean(data);
    },

    async hasSiteWebsite(ownerId) {
      const { data, error } = await db().from('websites').select('mode').eq('user_id', ownerId).maybeSingle();
      if (error) {
        console.error('[leaddb-ad-route] website lookup failed:', error.code ?? 'error');
        throw new Error(`website_lookup_failed:${error.code ?? 'error'}`);
      }
      return Boolean(data) && (data as { mode: string | null }).mode !== 'calculator';
    },

    async createMember(email) {
      const admin = db();
      const { data, error } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { lead_source: 'leaddb_ad_route' },
      });
      let userId: string | null = data?.user?.id ?? null;
      if (error || !userId) {
        // A race, or a login without a profile row: look once more before giving up.
        userId = await profileIdByEmail(email);
        if (!userId) {
          console.error('[leaddb-ad-route] create member failed');
          return null;
        }
        return userId;
      }
      // The trigger creates the profile on auth.users insert; it may lag a moment.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { data: prof } = await admin.from('profiles').select('id').eq('id', userId).maybeSingle();
        if (prof) return userId;
        await new Promise((r) => setTimeout(r, 400));
      }
      const { error: insErr } = await admin.from('profiles').insert({ id: userId, email });
      if (insErr && insErr.code !== '23505') {
        console.error('[leaddb-ad-route] profile insert failed:', insErr.code ?? 'error');
        return null;
      }
      return userId;
    },

    ensureSite: (input) => ensureCalculatorSite(input),

    // Batch 55 step 5: the profile inside provision fills the calculator exactly as the profile call does.
    applyProfile: (ownerId, profile) => applyAdProfile(ownerId, profile),

    // Batch 55 step 2: the first sign-in lands on the ads, not the /welcome quiz: the management stamp, written only
    // while signup_path is null. Written directly, NOT through stampManagement: that records mc_signup and sends a Meta
    // conversion, which must never fire for a provisioned lead database customer. Daily picks go off unless the quiz is
    // done (as stampManagement does), with no funnel sync, activity or conversion. A member this call created is not
    // given the welcome credit (the check ensureWelcomeGrant reads, stamped done with its own reason).
    async settleMember(ownerId, isNew) {
      const nowIso = new Date().toISOString();
      const { data: stamped, error: stampErr } = await db()
        .from('profiles')
        .update({ signup_path: 'management', signup_path_at: nowIso, signup_path_via: 'account' })
        .eq('id', ownerId)
        .is('signup_path', null)
        .select('id');
      if (stampErr) console.error('[leaddb-ad-route] management stamp failed:', stampErr.code ?? 'error');
      if (!stampErr && (stamped ?? []).length > 0 && !(await quizDone(ownerId))) {
        const { error: picksErr } = await db().from('profiles').update({ sourcing_alerts: false }).eq('id', ownerId);
        if (picksErr) console.error('[leaddb-ad-route] picks off failed:', picksErr.code ?? 'error');
      }
      if (!isNew) return;
      const { error } = await db()
        .from('profiles')
        .update({ welcome_checked_at: nowIso, welcome_withheld_reason: 'leaddb_ad_route' })
        .eq('id', ownerId)
        .is('welcome_checked_at', null);
      if (error) console.error('[leaddb-ad-route] welcome check stamp failed:', error.code ?? 'error');
    },
  };
}
