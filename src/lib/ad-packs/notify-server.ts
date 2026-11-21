import 'server-only';

import { createAdminClient } from '../supabase/admin';
import { brandedFrom } from '../email/from.ts';
import { sendVideoEmail } from '../email/ad-pack-video.ts';
import type { VideoNotifyDeps } from './notify-core.ts';

/**
 * Batch 38b: the real mailer and address lookup for the "your video ad is ready / we couldn't finish it" email
 * (notify-core.ts has the rules: when, once, and what a failed send does).
 *
 * The address is the pack owner's own login email, read here on the server from their profile (the same lookup the
 * website operator emails use); it is never taken from anything the operator or a lead typed, and it is never
 * logged. The email is a reply to something the operator started, so it is outside the one-email-a-day cap (like the
 * website change and new-lead emails): it goes straight through sendEmail, from "Stayful Intelligence", with its own
 * idempotency key. The link uses the site's base URL helper.
 */
export function createVideoNotifier(): VideoNotifyDeps {
  return {
    async ownerEmail(ownerId) {
      const { data, error } = await createAdminClient().from('profiles').select('email').eq('id', ownerId).maybeSingle();
      // A read that failed throws (the row is left for the next tick); "no address" is null.
      if (error) throw new Error(error.code ?? 'error');
      const to = (data as { email?: string | null } | null)?.email;
      return to && to.includes('@') ? to : null;
    },
    async send(to, o) {
      const from = brandedFrom(process.env.EMAIL_FROM, 'Stayful Intelligence') ?? undefined;
      const res = await sendVideoEmail(to, { outcome: o.outcome, errorCode: o.errorCode, idempotencyKey: o.idempotencyKey, ...(from ? { from } : {}) });
      return { sent: res.sent };
    },
  };
}
