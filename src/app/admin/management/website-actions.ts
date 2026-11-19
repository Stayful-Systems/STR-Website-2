'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createAdminClient, hasServiceRole } from '@/lib/supabase/admin';
import { emailKey } from '@/lib/supabase/email-key';
import { isAdminEmail } from '@/lib/admin';
import { isPaid, type AccessProfile } from '@/lib/access';
import { isManagement } from '@/lib/management/stamp';
import { ownerIdOrNull } from '@/lib/leads/scope';
import { invalidateCreditCaches, updateBillingSetting } from '@/lib/credit/unit-costs';
import { inviteWebsite, readWebsiteSettings, setStatus, siteById } from '@/lib/websites/store-server';
import { WEBSITE_KEYS } from '@/lib/websites/settings';
import {
  describeSettingsChanges,
  dryRunInvite,
  inviteDenialText,
  looksLikeEmail,
  normaliseEmail,
  normaliseSlug,
  planSiteStatus,
  runInvite,
  validateWebsiteSettings,
  type ChecklistItem,
  type InviteFacts,
  type SettingsErrors,
  type SiteAction,
} from '@/lib/websites/invite-run';
import { slugProblem } from '@/lib/websites/slug';

/**
 * Batch 31, Phase 11: /admin/management's customer-website actions.
 *
 *   dryRunGiveWebsiteAction / giveWebsiteAction   the checklist, then create
 *   dryRunSiteStatusAction / setSiteStatusAction   pause / unpause, dry run first
 *   saveWebsiteSettingsAction                      the five billing_settings
 *
 * Each checks the admin itself (as the neighbouring actions do) and answers
 * with a message. A dry run only READS: it has no insert, update, upsert, rpc
 * or inviteWebsite call (invite-run.test.ts pins that). Nothing here returns a
 * lead's contact details or address.
 */

async function requireAdmin(): Promise<{ id: string; email: string }> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user || !isAdminEmail(data.user.email)) throw new Error('Not allowed');
  return { id: data.user.id, email: data.user.email! };
}

/** The admin trail: who did what to which site (the websites row also keeps invited_by / invited_at / paused_at). */
function audit(admin: { email: string }, what: string): void {
  console.info(`[admin] websites: ${admin.email} ${what}`);
}

export interface WebsiteActionResult {
  ok: boolean;
  message: string;
  /** The give-a-website checklist, when there is one. */
  checklist?: ChecklistItem[];
  /** Whether the Run button may now be offered (the dry run passed). */
  canRun?: boolean;
  /** What a pause / unpause would change. */
  lines?: string[];
}

// ── Give a website ──

/** READS only: the profile, the owner check, the site, the slug and the plan-gate setting. */
async function gatherInviteFacts(rawEmail: string, rawSlug: string): Promise<InviteFacts> {
  if (!hasServiceRole()) throw new Error('The service role is not configured.');
  const admin = createAdminClient();
  const email = normaliseEmail(rawEmail);
  const slug = normaliseSlug(rawSlug);

  let member: InviteFacts['member'] = null;
  let isOwner = false;
  let hasSite = false;
  if (looksLikeEmail(email)) {
    const { data: profile, error } = await admin
      .from('profiles')
      .select('id, signup_path, plan, plan_code, plan_source, stripe_subscription_id, stripe_subscription_status, subscription_paused_from, subscription_paused_until, subscription_cancel_at')
      .eq('email', emailKey(email))
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (profile) {
      const p = profile as { id: string; signup_path?: string | null };
      member = { id: p.id, isManagement: isManagement(p.signup_path), paid: isPaid(profile as AccessProfile) };
      isOwner = (await ownerIdOrNull({ id: p.id })) === p.id;
      const { data: site, error: siteError } = await admin.from('websites').select('id').eq('user_id', p.id).maybeSingle();
      if (siteError) throw new Error(siteError.message);
      hasSite = Boolean(site);
    }
  }

  let slugTaken = false;
  if (slugProblem(slug) === null) {
    const { data: taken, error } = await admin.from('websites').select('id').eq('slug', slug).maybeSingle();
    if (error) throw new Error(error.message);
    slugTaken = Boolean(taken);
  }

  const settings = await readWebsiteSettings();
  return { email, slug, member, isOwner, hasSite, slugTaken, planGateOn: settings.planGateOn };
}

export async function dryRunGiveWebsiteAction(email: string, slug: string): Promise<WebsiteActionResult> {
  try {
    await requireAdmin();
    const checklist = dryRunInvite(await gatherInviteFacts(String(email ?? ''), String(slug ?? '')));
    return {
      ok: checklist.canRun,
      canRun: checklist.canRun,
      checklist: checklist.items,
      message: checklist.canRun ? `Dry run: ${checklist.email} can be given /s/${checklist.slug}. Nothing was written.` : 'Dry run: not yet. Nothing was written.',
    };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function giveWebsiteAction(email: string, slug: string): Promise<WebsiteActionResult> {
  try {
    const admin = await requireAdmin();
    const facts = await gatherInviteFacts(String(email ?? ''), String(slug ?? ''));
    const out = await runInvite(facts, () => inviteWebsite({ memberId: facts.member!.id, invitedBy: admin.id, slug: facts.slug }));
    if (!out.ran) return { ok: false, canRun: false, checklist: out.checklist.items, message: 'Not created: a check failed. Nothing was written.' };
    if (!out.result.ok) return { ok: false, checklist: out.checklist.items, message: `Not created: ${inviteDenialText(out.result.reason)}` };
    audit(admin, `gave ${facts.email} the website /s/${facts.slug} (status invited)`);
    revalidatePath('/admin/management');
    return { ok: true, checklist: out.checklist.items, message: `Gave ${facts.email} a website at /s/${facts.slug}. It is invited: they set it up from /leads.` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

// ── Pause / unpause ──

function siteAction(v: unknown): SiteAction | null {
  return v === 'pause' || v === 'unpause' ? v : null;
}

/** READS only: what the pause or unpause would change. */
export async function dryRunSiteStatusAction(websiteId: string, action: string): Promise<WebsiteActionResult> {
  try {
    await requireAdmin();
    const act = siteAction(action);
    if (!act) return { ok: false, message: 'Pause or unpause.' };
    const site = await siteById(String(websiteId ?? ''));
    if (!site) return { ok: false, message: 'No such website.' };
    const plan = planSiteStatus({ slug: site.slug, status: site.status }, act);
    return { ok: plan.ok, canRun: plan.ok, lines: plan.lines, message: plan.ok ? `Dry run: /s/${site.slug} would go ${plan.to}. Nothing was changed.` : `Dry run: ${plan.lines[0]}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function setSiteStatusAction(websiteId: string, action: string): Promise<WebsiteActionResult> {
  try {
    const admin = await requireAdmin();
    const act = siteAction(action);
    if (!act) return { ok: false, message: 'Pause or unpause.' };
    const site = await siteById(String(websiteId ?? ''));
    if (!site) return { ok: false, message: 'No such website.' };
    const plan = planSiteStatus({ slug: site.slug, status: site.status }, act);
    if (!plan.ok || !plan.to) return { ok: false, lines: plan.lines, message: plan.lines[0] };
    // setStatus is conditional on the status it read, so two clicks cannot both win. It never touches the funnel row.
    const r = await setStatus(site.userId, plan.to);
    if (!r.ok) return { ok: false, message: r.reason === 'conflict' ? 'The site changed while you were looking. Reload and try again.' : 'The status could not be changed. Nothing was changed.' };
    audit(admin, `${act}d /s/${site.slug} (${site.status} → ${plan.to})`);
    revalidatePath('/admin/management');
    return { ok: true, lines: plan.lines, message: `/s/${site.slug} is now ${plan.to}.` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

// ── The five settings ──

export type WebsiteSettingsState = { ok: boolean; message: string; errors?: SettingsErrors; changes?: string[] } | null;

/**
 * Saves the five website settings. Validated first (switches strict, whole
 * numbers, pence 1-10000, one site never above the daily total); nothing is
 * written unless every field passes. Analysis pricing settings are not touched.
 */
export async function saveWebsiteSettingsAction(_prev: WebsiteSettingsState, formData: FormData): Promise<WebsiteSettingsState> {
  try {
    const admin = await requireAdmin();
    const get = (k: string) => {
      const v = formData.get(k);
      return typeof v === 'string' ? v : undefined;
    };
    const checked = validateWebsiteSettings({
      reportChargeOn: get('reportChargeOn'),
      reportPence: get('reportPence'),
      planGateOn: get('planGateOn'),
      freeReportsPerDay: get('freeReportsPerDay'),
      freeReportsPerSitePerDay: get('freeReportsPerSitePerDay'),
    });
    if (!checked.ok) return { ok: false, message: 'Nothing was saved: check the highlighted fields.', errors: checked.errors };
    const before = await readWebsiteSettings();
    const changes = describeSettingsChanges(before, checked.values);
    if (changes.length === 0) return { ok: true, message: 'No change.', changes };
    for (const field of Object.keys(WEBSITE_KEYS) as Array<keyof typeof WEBSITE_KEYS>) {
      if (before[field] !== checked.values[field]) await updateBillingSetting(WEBSITE_KEYS[field], checked.values[field]);
    }
    // updateBillingSetting clears the 60 second settings cache each time; once more, as the calls settings do.
    invalidateCreditCaches();
    audit(admin, `changed the website settings: ${changes.join('; ')}`);
    revalidatePath('/admin/management');
    return { ok: true, message: 'Saved.', changes };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
