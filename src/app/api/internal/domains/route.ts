import { authoriseInternal, internalSecretsConfigured } from '@/lib/internal-auth';
import { adminEmails } from '@/lib/admin';
import { hasServiceRole } from '@/lib/supabase/admin';
import { isEmailConfigured, sendEmail } from '@/lib/email/send';
import { brandedFrom } from '@/lib/email/from';
import { siteUrl } from '@/lib/url';
import { runDomains } from '@/lib/domains/cron-run';
import { createLiveStore, liveDomainEngine, listDomainRows, transferredDomainIds } from '@/lib/domains/store-server';

/**
 * Batch 33: the website domains' status cron (every 15 minutes).
 *
 * The rules are src/lib/domains/cron-run.ts's (and the engine's: purchase-server.ts):
 *   1 held_cap from an earlier UK day: buy        5 renewals within 30 days: one admin email each
 *   2 registering for 15 minutes: buy again       6 7 days left, no decision: the auto-renew rule
 *   3 connecting: advance                         7 renew decisions: renew
 *   4 stuck for 24 hours: one admin email
 * No new piece of work starts after 40 seconds (maxDuration 60).
 *
 * Same auth as the other internal routes: Vercel Cron's bearer or the shared
 * header. A run can spend money (Stayful's, on a registrar), so it never runs open.
 *
 * `?dry=1` is read-only: it lists what a run would do, from our own database
 * only: no registrar or Vercel call, no email, no write.
 *
 * Logs carry an error name at most: never a body, a header or a credential.
 */

export const maxDuration = 60;

const adminFrom = () => brandedFrom(process.env.EMAIL_FROM, 'Stayful Intelligence') ?? undefined;

export async function GET(request: Request) {
  if (!internalSecretsConfigured()) return new Response('Not found', { status: 404 });
  if (!authoriseInternal(request)) return new Response('Unauthorised', { status: 401 });
  if (!hasServiceRole()) return Response.json({ error: 'service role not configured' }, { status: 503 });

  const dry = new URL(request.url).searchParams.get('dry') === '1';
  try {
    const store = createLiveStore();
    const report = await runDomains(
      {
        engine: liveDomainEngine(),
        list: listDomainRows,
        skip: transferredDomainIds,
        stamp: (id, patch) => store.updateDomain(id, patch),
        async sendAdmin(copy, key) {
          if (!isEmailConfigured()) return false;
          const to = adminEmails();
          if (to.length === 0) return false;
          const from = adminFrom();
          let any = false;
          for (const address of to) {
            const res = await sendEmail({ to: address, ...copy, ...(from ? { from } : {}), idempotencyKey: `${key}:${address}` });
            any = any || res.sent;
          }
          return any;
        },
        panelUrl: siteUrl('/admin/management'),
        now: () => new Date(),
      },
      { dry },
    );
    return Response.json(report);
  } catch (err) {
    console.error('[domains] run failed:', err instanceof Error ? err.name : 'error');
    return Response.json({ error: 'run failed' }, { status: 500 });
  }
}
