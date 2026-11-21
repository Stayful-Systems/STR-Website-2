import 'server-only';

import { createAdminClient } from '../supabase/admin';
import { abandonSend, claimSlot, finishSend, markSending, releaseClaim } from '../notify/sends';
import { isEmailConfigured, sendEmail } from '../email/send';
import { brandedFrom } from '../email/from';
import { renderWebsiteGraceEmail } from '../email/website-grace';
import { DEFAULT_QUIET_DAYS, runQuietCheck } from './quiet.ts';
import type { QuietLink, QuietResult, QuietStore } from './quiet.ts';

/**
 * Batch 35 (Phase 6): the real store behind the quiet-sheet email. Service role
 * only. Reads ad_sheet_links, profiles (the owner's email, sent to and never
 * logged) and billing_settings; writes ad_sheet_links.quiet_email_sent_at and
 * the cap's own notification_sends row. A failure logs a table name and a code
 * at most: never an address, never a row.
 */

const db = () => createAdminClient();
const MAX_LINKS = 500;

/** billing_settings ad_sheets_enabled: false when missing, unreadable or anything but true (the whole feature ships off). */
export async function adSheetsEnabled(): Promise<boolean> {
  const { data, error } = await db().from('billing_settings').select('value').eq('key', 'ad_sheets_enabled').maybeSingle();
  if (error) return false;
  return (data as { value: unknown } | null)?.value === true;
}

export function supabaseQuietStore(): QuietStore {
  const admin = db();
  return {
    async quietDays() {
      const { data, error } = await admin.from('billing_settings').select('value').eq('key', 'ad_sheet_quiet_days').maybeSingle();
      if (error) return DEFAULT_QUIET_DAYS;
      const n = Number((data as { value: unknown } | null)?.value);
      return Number.isFinite(n) && n >= 1 && n <= 365 ? Math.floor(n) : DEFAULT_QUIET_DAYS;
    },

    async activeLinks() {
      const { data, error } = await admin
        .from('ad_sheet_links')
        .select('id, owner_id, state, last_row_at, activated_at, quiet_email_sent_at')
        .eq('state', 'active')
        .is('quiet_email_sent_at', null)
        .limit(MAX_LINKS);
      if (error) throw new Error(`ad_sheet_links read failed: ${error.code ?? 'error'}`);
      return ((data ?? []) as { id: string; owner_id: string; state: string; last_row_at: string | null; activated_at: string | null; quiet_email_sent_at: string | null }[]).map(
        (r): QuietLink => ({ id: r.id, ownerId: r.owner_id, state: r.state, lastRowAt: r.last_row_at, activatedAt: r.activated_at, quietEmailSentAt: r.quiet_email_sent_at }),
      );
    },

    async ownerEmail(ownerId) {
      const { data, error } = await admin.from('profiles').select('email').eq('id', ownerId).maybeSingle();
      if (error) return null;
      const e = (data as { email?: string | null } | null)?.email;
      return typeof e === 'string' && e ? e : null;
    },

    claimSlot: async (userId, kind, now) => {
      const c = await claimSlot(admin, userId, kind, now);
      return c.ok ? { ok: true, id: c.id } : { ok: false, reason: c.reason };
    },
    releaseClaim: (id) => releaseClaim(admin, id),
    markSending: (id, summary) => markSending(admin, id, summary, null),
    abandonSend: (id) => abandonSend(admin, id),
    finishSend: async (id, summary) => {
      await finishSend(admin, id, true, summary, []);
    },

    async stamp(linkId, atIso) {
      const { error } = await admin.from('ad_sheet_links').update({ quiet_email_sent_at: atIso, updated_at: atIso }).eq('id', linkId).is('quiet_email_sent_at', null);
      if (error) throw new Error(`ad_sheet_links write failed: ${error.code ?? 'error'}`);
    },

    async send(to, copy, idempotencyKey) {
      if (!isEmailConfigured()) return { sent: false, reason: 'not_configured' };
      const from = brandedFrom(process.env.EMAIL_FROM, 'Stayful Intelligence') ?? undefined;
      return sendEmail({ to, ...renderWebsiteGraceEmail(copy), ...(from ? { from } : {}), idempotencyKey });
    },

    log: (line) => console.error(line),
  };
}

/** The quiet check with the real store. Never throws. */
export async function runQuietCheckLive(opts: { dry?: boolean } = {}): Promise<QuietResult> {
  try {
    return await runQuietCheck(supabaseQuietStore(), opts);
  } catch {
    console.error('[ad-sheets] quiet check failed');
    return { ok: false, dry: opts.dry === true, checked: 0, due: 0, sent: 0, waiting: 0, failed: 0, entries: [] };
  }
}
