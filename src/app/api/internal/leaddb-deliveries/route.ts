import { authoriseInternal, internalSecretsConfigured } from '@/lib/internal-auth';
import { hasServiceRole } from '@/lib/supabase/admin';
import { drainLeadDbDeliveries, sweepLeadDbDeliveries } from '@/lib/leaddb/deliver';

/**
 * Pushes website leads into operators' lead database accounts (Batch 32).
 *
 * A push is never made inline with the landlord's request. The lead is already
 * stored and listed in SI Leads by the time anything reaches this queue; the
 * push is the copy, and it retries with backoff. This runs the sweep (the
 * safety net for a lead whose enqueue was cut off, and a finished report not
 * yet sent) and then the drain, inside a time budget.
 *
 * Same auth as every other internal route: Vercel Cron's bearer or the shared
 * header; 404 when no secret is configured. `?dry=1` lists what is due (ids
 * only) and sends and queues nothing.
 */

export const maxDuration = 60;

/** Each report push renders a PDF, and there are sixty seconds. */
const MAX_PER_RUN = 10;

export async function GET(request: Request) {
  if (!internalSecretsConfigured()) return new Response('Not found', { status: 404 });
  if (!authoriseInternal(request)) return new Response('Unauthorised', { status: 401 });
  if (!hasServiceRole()) return Response.json({ error: 'service role not configured' }, { status: 503 });

  const dry = new URL(request.url).searchParams.get('dry') === '1';
  const started = Date.now();
  const sweep = await sweepLeadDbDeliveries(50, { dry });
  const drain = await drainLeadDbDeliveries(MAX_PER_RUN, { dry, budgetMs: 40_000 });
  return Response.json({ sweep, drain, dry, ms: Date.now() - started });
}
