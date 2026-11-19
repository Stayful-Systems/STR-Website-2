import 'server-only';

import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createAdminClient, hasServiceRole } from '@/lib/supabase/admin';
import { isPaid, type AccessProfile } from '@/lib/access';
import { isManagement } from '@/lib/management/stamp';
import { ownerIdOrNull } from '@/lib/leads/scope';
import { websiteAccess, type AccessDenial } from '@/lib/websites/policy';
import { ownSite, readWebsiteSettings, type WebsiteRow } from '@/lib/websites/store-server';
import { isEditable, resumeStep, WEBSITE_SETUP_PATH, type WebsiteStepNo } from './steps';

/**
 * Batch 31, Phase 10: who is at the website setup, and which site is theirs.
 *
 * Owner-only: only an account owner has a website (ownerIdOrNull), so a team
 * member is refused. Invited-only: the site is found by the SIGNED-IN OWNER's
 * id, never by an id from the address or a form, so there is nothing to forge.
 * The plan gate (websiteAccess, purpose go_live) is read while the site is
 * still being set up; a site that is already live or paused is never blocked
 * by it (purpose keep_live), because the gate stops going live, not live sites.
 *
 * Every setup action goes through websiteActor(); the pages through
 * websiteSetupContext(), which is the same check with a redirect or a notice.
 */

export type ActorDenial = 'signed_out' | AccessDenial | 'unavailable';

export interface WebsiteActor {
  /** The signed-in person: always the account owner here. */
  userId: string;
  email: string | null;
  site: WebsiteRow;
  /** invited / setup / preview: the setup can still change the site. */
  editable: boolean;
}

export type ActorResult = { ok: true; actor: WebsiteActor } | { ok: false; reason: ActorDenial };

const PROFILE_COLUMNS = 'signup_path, plan, plan_code, plan_source, stripe_subscription_id, stripe_subscription_status, subscription_paused_from, subscription_paused_until, subscription_cancel_at';

export async function websiteActor(): Promise<ActorResult> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: 'signed_out' };
  // A team member's own id never has a site: they are refused here.
  const ownerId = await ownerIdOrNull(user);
  if (!ownerId) return { ok: false, reason: 'not_owner' };
  if (!hasServiceRole()) return { ok: false, reason: 'unavailable' };

  const [site, settings, { data: profile }] = await Promise.all([
    ownSite(ownerId),
    readWebsiteSettings(),
    createAdminClient().from('profiles').select(PROFILE_COLUMNS).eq('id', ownerId).maybeSingle(),
  ]);
  if (!site) return { ok: false, reason: 'not_invited' };
  if (!profile) return { ok: false, reason: 'unavailable' };

  const editable = isEditable(site.status);
  const access = websiteAccess(
    { isManagement: isManagement((profile as { signup_path?: string | null }).signup_path), isOwner: true, invited: true, paid: isPaid(profile as AccessProfile) },
    settings.planGateOn,
    editable ? 'go_live' : 'keep_live',
  );
  if (!access.allowed) return { ok: false, reason: access.reason };
  return { ok: true, actor: { userId: ownerId, email: user.email ?? null, site, editable } };
}

/** Step 4 (optional) continued from or skipped: the activity row the step logs. */
async function stepDone(userId: string, step: number): Promise<boolean> {
  if (!hasServiceRole()) return false;
  const { data, error } = await createAdminClient().from('activity_events').select('id').eq('user_id', userId).eq('dedupe_key', `website_setup_step:${step}`).limit(1);
  return !error && (data?.length ?? 0) > 0;
}

export type SetupContext =
  | { kind: 'ready'; actor: WebsiteActor; resume: WebsiteStepNo }
  /** Live or paused: nothing to edit here. */
  | { kind: 'closed'; actor: WebsiteActor }
  | { kind: 'plan_required' };

/** For the pages: sign-in and the owner-only, invited-only rules as redirects; the plan gate as a notice. */
export async function websiteSetupContext(): Promise<SetupContext> {
  const r = await websiteActor();
  if (!r.ok) {
    if (r.reason === 'signed_out') redirect(`/login?redirect=${WEBSITE_SETUP_PATH}`);
    if (r.reason === 'plan_required') return { kind: 'plan_required' };
    // A team member, a member with no site, a non-management account: back to Leads, as every owner-only page does.
    redirect('/leads');
  }
  const { actor } = r;
  if (!actor.editable) return { kind: 'closed', actor };
  const aboutDone = await stepDone(actor.userId, 4);
  return { kind: 'ready', actor, resume: resumeStep({ settings: actor.site.settings, hasPages: actor.site.pages !== null, aboutDone }) };
}
