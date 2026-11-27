import { authoriseInternal, internalSecretsConfigured } from '@/lib/internal-auth';
import { hasServiceRole } from '@/lib/supabase/admin';
import { drainLeadDbDeliveries, sweepLeadDbDeliveries } from '@/lib/leaddb/deliver';
import { drainAdLeadDeliveries } from '@/lib/leaddb/ad-deliver';

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
 *
 * Batch 55 step 2: then the calculator leads (`si_ad`, leaddb_ad_deliveries) and the pending "first ad pack made"
 * calls, in what is left of the time budget (the same `?dry=1` rule).
 */

export const maxDuration = 60;

/** Each report push renders a PDF, and there are sixty seconds. */
const MAX_PER_RUN = 10;

/** Batch 55 step 2: the ad lead drain stops starting new pushes this far into the run. */
const AD_BUDGET_END_MS = 50_000;

export async function GET(request: Request) {
  if (!internalSecretsConfigured()) return new Response('Not found', { status: 404 });
  if (!authoriseInternal(request)) return new Response('Unauthorised', { status: 401 });
  if (!hasServiceRole()) return Response.json({ error: 'service role not configured' }, { status: 503 });

  const dry = new URL(request.url).searchParams.get('dry') === '1';
  const started = Date.now();
  const sweep = await sweepLeadDbDeliveries(50, { dry });
  const drain = await drainLeadDbDeliveries(MAX_PER_RUN, { dry, budgetMs: 40_000 });
  // Batch 55 step 2: what is left of the minute, keeping a margin for the answer.
  const adLeads = await drainAdLeadDeliveries(MAX_PER_RUN, { dry, budgetMs: Math.max(0, AD_BUDGET_END_MS - (Date.now() - started)) });
  return Response.json({ sweep, drain, adLeads, dry, ms: Date.now() - started });
}
