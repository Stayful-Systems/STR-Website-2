import 'server-only';

import { createAdminClient } from '../supabase/admin';
import { emailKey } from '../supabase/email-key';
import { ensureCalculatorSite } from '../websites/store-server';
import { applyAdAccountState, createAdAccount, readAdAccount, readAdAccountByCustomerId } from './ad-account-server';
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
  };
}
