'use server';

/**
 * Batch 31a, Phase 6: the Academy admin actions on /admin/billing (AcademyPanel).
 * Link a purchase to a member, Unlink it while nothing has been charged, and the
 * daily reminders cron. Every action: admin only, a dry run that changes nothing
 * first (the panel offers Run only after a clean one), and an answer in place —
 * never a throw. Logs carry ids only, never an email.
 */
import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { emailKey } from '@/lib/supabase/email-key';
import { isAdminEmail } from '@/lib/admin';
import { linkAcademyPurchase, unlinkAcademyPurchase } from '@/lib/academy/deps';
import { runAcademyReminders } from '@/lib/academy/reminders-run';
import { ACADEMY_FACTS } from '@/lib/academy/rules';

async function requireAdmin(): Promise<{ email: string }> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user || !isAdminEmail(data.user.email)) throw new Error('Not allowed');
  return { email: data.user.email! };
}

export interface AcademyPreview {
  title: string;
  subject: string;
  text: string;
}

export type AcademyActionState = {
  ok: boolean;
  message: string;
  dry?: boolean;
  /** The dry run said the action would go ahead (Run may be offered). */
  clean?: boolean;
  /** What the dry run was for (purchase + member), so Run matches the same input. */
  key?: string;
  body?: { lines: string[]; previews?: AcademyPreview[] };
} | null;

const REFUSALS: Record<string, string> = {
  live_plan: "a live plan already sits on the account's or the purchase's Stripe customer",
  email_mismatch: "the account's email does not match the purchase email",
  unconfirmed_email: "the account's sign-in email is not confirmed",
  refunded: 'the purchase was refunded',
  team_member: 'the account is a team member (billing is owned by the team owner)',
  no_consent: 'the purchase has no saved-card consent (the terms tick box)',
  repeat_purchase: 'this email has already had an Academy trial (one trial per buyer)',
  no_card: 'the purchase has no Stripe customer or saved card to charge',
  not_found: 'the purchase was not found',
  no_profile: 'the member account was not found',
  stripe_unavailable: 'Stripe could not be asked (try again)',
  pro_price_missing: 'the Pro price (STRIPE_PRICE_PRO) is not set',
  not_linked: 'the purchase is not linked to an account',
  paid_invoice: 'an invoice on the trial has already been paid, so it can no longer be unlinked',
  unlinked_admin: 'an admin unlinked this purchase, so only an admin link can link it again',
  subscription_not_trialing: 'Stripe returned a subscription that is not trialing, so nothing was recorded',
};

function why(reason: string | null): string {
  if (!reason) return 'unknown reason';
  return REFUSALS[reason.replace(/^refuse_/, '')] ?? reason;
}

function day(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' });
}

function msg(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

/** The one profile with this sign-in email, or why not. */
async function memberByEmail(raw: string): Promise<{ id: string; email: string } | { error: string }> {
  const key = emailKey(raw);
  if (!key || !key.includes('@')) return { error: 'Enter the member’s sign-in email.' };
  const admin = createAdminClient();
  const { data, error } = await admin.from('profiles').select('id, email').eq('email', key).limit(2);
  if (error) return { error: `Profiles could not be read: ${error.message}` };
  const rows = (data ?? []) as { id: string; email: string }[];
  if (rows.length === 0) return { error: 'No account has that sign-in email.' };
  if (rows.length > 1) return { error: 'More than one account has that email: link it by hand in the database.' };
  return rows[0];
}

/** Link to member: Dry run (apply=0) says exactly what would happen; Run (apply=1) does it. */
export async function academyLinkAction(_prev: AcademyActionState, formData: FormData): Promise<AcademyActionState> {
  try {
    await requireAdmin();
    const purchaseId = String(formData.get('purchase_id') ?? '').trim();
    const memberEmail = String(formData.get('member_email') ?? '');
    const apply = formData.get('apply') === '1';
    const key = `${purchaseId}|${emailKey(memberEmail)}`;
    if (!purchaseId) return { ok: false, message: 'Pick a purchase.', key };
    const member = await memberByEmail(memberEmail);
    if ('error' in member) return { ok: false, message: member.error, key };

    const r = await linkAcademyPurchase(purchaseId, member.id, 'admin', { dry: !apply });
    const lines: string[] = [];
    let message: string;
    if (r.outcome === 'start') {
      message = apply
        ? r.done
          ? `Linked to ${member.email}: the ${ACADEMY_FACTS.trialDays}-day Pro trial has started.`
          : `Not linked: another run got there first (nothing changed).`
        : `Would link to ${member.email} and start the ${ACADEMY_FACTS.trialDays}-day Pro trial.`;
      if (r.customerAction === 'use_purchase_customer') lines.push(`Customer: the account has no Stripe customer, so it takes the purchase's customer ${r.customerId}.`);
      else if (r.customerAction === 'same_customer') lines.push(`Customer: the account already uses the purchase's customer ${r.customerId}.`);
      else if (r.customerAction === 'switch_to_purchase_customer')
        lines.push(`Customer: the account switches from ${r.previousCustomerId} (no live plan there) to the purchase's customer ${r.customerId}. The old id is kept on the purchase and left untouched in Stripe.`);
      lines.push(r.cardLast4 ? `Card: ending ${r.cardLast4} (the card the Academy was paid with).` : 'Card: the saved card on the purchase (last 4 digits not readable).');
      lines.push(`Trial: ${day(r.trialStart)} to ${day(r.trialEnd)}. First charge on ${day(r.trialEnd)} unless cancelled; reminder ${ACADEMY_FACTS.reminderDaysBefore} days before.`);
      if (r.reusedSubscription) lines.push(`An existing trial subscription for this purchase was found in Stripe and is reused (no new one created).`);
      if (r.subscriptionId) lines.push(`Subscription: ${r.subscriptionId}.`);
    } else if (r.outcome === 'already') {
      message = 'Already linked: its trial has started, nothing to do.';
      lines.push(`Subscription ${r.subscriptionId ?? '—'}, trial ${day(r.trialStart)} to ${day(r.trialEnd)}.`);
    } else if (r.outcome === 'refused') {
      message = apply ? `Refused: ${why(r.decision)}. The purchase is flagged; no trial.` : `Would refuse: ${why(r.decision)}. Nothing would be created.`;
    } else {
      message = `Could not tell: ${why(r.reason)}.`;
    }
    if (apply && r.done) revalidatePath('/admin/billing');
    return { ok: r.outcome !== 'error', message, dry: !apply, clean: r.outcome === 'start', key, body: { lines } };
  } catch (err) {
    return { ok: false, message: msg(err) };
  }
}

/** Unlink: Dry run (apply=0) / Run (apply=1). Only while nothing has been paid on the trial (checked in Stripe). */
export async function academyUnlinkAction(_prev: AcademyActionState, formData: FormData): Promise<AcademyActionState> {
  try {
    await requireAdmin();
    const purchaseId = String(formData.get('purchase_id') ?? '').trim();
    const apply = formData.get('apply') === '1';
    if (!purchaseId) return { ok: false, message: 'Pick a linked purchase.', key: purchaseId };

    const r = await unlinkAcademyPurchase(purchaseId, { dry: !apply });
    const lines: string[] = [];
    let message: string;
    if (r.outcome === 'unlink') {
      message = apply ? (r.done ? 'Unlinked: the purchase is free to link to another account (a fresh trial).' : 'Not unlinked (nothing changed).') : 'Would unlink the purchase and free it to be linked again.';
      lines.push(
        r.cancelsSubscription
          ? `Trial subscription ${r.subscriptionId} (${r.subscriptionStatus ?? 'unknown'}) is cancelled now; nothing is charged.`
          : `Trial subscription ${r.subscriptionId} is already ${r.subscriptionStatus ?? 'gone'} in Stripe; nothing to cancel.`,
      );
      lines.push(
        r.restoresProfileCustomer
          ? r.restoredCustomerId
            ? `The account goes back to its own customer ${r.restoredCustomerId}, and the buyer's card is cleared from it.`
            : "The account goes back to having no Stripe customer, and the buyer's card is cleared from it."
          : "The account's Stripe customer is left as it is.",
      );
    } else if (r.outcome === 'refused') {
      message = `${apply ? 'Refused' : 'Would refuse'}: ${why(r.reason)}.`;
    } else {
      message = `Could not tell: ${why(r.reason)}.`;
    }
    if (apply && r.done) revalidatePath('/admin/billing');
    return { ok: r.outcome !== 'error', message, dry: !apply, clean: r.outcome === 'unlink', key: purchaseId, body: { lines } };
  } catch (err) {
    return { ok: false, message: msg(err) };
  }
}

type Item = Record<string, unknown>;

/** The daily Academy cron (link sweep + reminder emails), run by hand: Dry run (apply=0) / Run (apply=1). */
export async function academyRemindersAction(_prev: AcademyActionState, formData: FormData): Promise<AcademyActionState> {
  try {
    await requireAdmin();
    const apply = formData.get('apply') === '1';
    const r = await runAcademyReminders({ dry: !apply });
    const b = r.body;
    if (r.status !== 200) return { ok: false, message: String(b.error ?? `Failed (${r.status})`), dry: !apply };

    // Purchase emails, so the admin sees who (the runner returns ids only).
    const items = (k: string) => (Array.isArray(b[k]) ? (b[k] as Item[]) : []);
    const ids = [...new Set([...items('wouldLink'), ...items('wouldSend'), ...items('waiting')].map((x) => String(x.purchaseId)))];
    const emails = new Map<string, string>();
    if (ids.length > 0) {
      const { data } = await createAdminClient().from('academy_purchases').select('id, email').in('id', ids);
      for (const row of (data ?? []) as { id: string; email: string }[]) emails.set(row.id, row.email);
    }
    const who = (x: Item) => emails.get(String(x.purchaseId)) ?? String(x.purchaseId);

    const lines: string[] = [];
    const previews: AcademyPreview[] = [];
    const errors = Array.isArray(b.errors) ? (b.errors as string[]) : [];
    let message: string;
    if (!apply) {
      const wouldLink = items('wouldLink');
      const wouldSend = items('wouldSend');
      const waiting = items('waiting');
      const skipped = items('skipped');
      message = `Dry run: would link ${wouldLink.filter((x) => x.outcome === 'start').length}, send ${wouldSend.length} reminder${wouldSend.length === 1 ? '' : 's'}, ${waiting.length} waiting, ${skipped.length} skipped. Nothing was sent or changed.`;
      for (const x of wouldLink) {
        lines.push(x.outcome === 'start' ? `Would link ${who(x)} (trial to ${day(x.trialEnd as string | null)}).` : `Would not link ${who(x)}: ${why((x.reason as string | null) ?? (x.decision as string))}.`);
      }
      for (const x of wouldSend) {
        lines.push(`Would send the reminder to ${who(x)}${x.decision === 'send_anyway' ? ` (last day: sent even if today's email slot is used)` : ''}.`);
        previews.push({ title: who(x), subject: String(x.subject ?? ''), text: String(x.text ?? '') });
      }
      for (const x of waiting) lines.push(`Waiting: ${who(x)} — today's email slot is used${x.slotTakenBy ? ` (${String(x.slotTakenBy)})` : ''}; tries again tomorrow.`);
      for (const x of skipped) lines.push(`Skipped ${String(x.purchaseId)}: ${String(x.reason)}.`);
    } else {
      message = `Done: linked ${Number(b.linked) || 0}, sent ${Number(b.sent) || 0}, waiting ${Number(b.waited) || 0}, skipped ${Number(b.skipped) || 0}, failed ${Number(b.failed) || 0}.`;
      if (Number(b.linked) > 0 || Number(b.sent) > 0) revalidatePath('/admin/billing');
    }
    for (const e of errors) lines.push(`Error: ${e}`);
    if (b.ranOutOfTime) lines.push('Ran out of time: run again to finish the rest.');
    return { ok: true, message, dry: !apply, clean: true, body: { lines, previews } };
  } catch (err) {
    return { ok: false, message: msg(err) };
  }
}
