import 'server-only';

import { createSupabaseServerClient } from '../supabase/server';
import { setAdAccountAllowed } from '../leaddb/ad-account-server';
import { leadDbAdminRunner, type LeadDbAdminRunner } from './ld-admin-run.ts';
import { insertRoundGrant } from './store-server';

/**
 * Batch 55 (A8): the lead database admin runner over the real wiring: the verified session user, the account switch
 * (ad-account-server.ts) and the grant insert (store-server.ts). The audit line is `[admin] ad-packs: ...`, ids only.
 */
export function liveLeadDbAdminRunner(): LeadDbAdminRunner {
  return leadDbAdminRunner({
    currentUser: async () => {
      const supabase = await createSupabaseServerClient();
      const { data } = await supabase.auth.getUser();
      return data.user ?? null;
    },
    setAllowed: (ownerId, allowed, adminId) => setAdAccountAllowed(ownerId, allowed, adminId),
    grantRound: (ownerId, adminId, reason) => insertRoundGrant(ownerId, adminId, reason),
    audit: (line) => console.info(`[admin] ad-packs: ${line}`),
  });
}
