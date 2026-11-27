import { hasServiceRole } from '@/lib/supabase/admin';
import { runStageUpdate } from '@/lib/leaddb/ad-stage';
import { liveAdStageDeps } from '@/lib/leaddb/ad-stage-server';
import { verifyInbound } from '@/lib/leaddb/inbound';

// ─── Lead database ad route: stage (Batch 55 step 2, contract section 11) ─────────
// The lead database pushes a stage change on an ad lead (si_ad) so the customer never taps it twice. The lead must be
// one of this customer's calculator leads. Ordered by stageAt; Meeting booked or Signed stamps meeting_reached_at once.
//
//   POST { ld_customer_id, si_lead_id, stage, ld_stage, stageAt }   (signed, see inbound.ts)
//   → 200 { ok: true, code: 'applied' | 'stale' }
//   → 400 bad_request   404 unknown_customer | unknown_lead   500 server_error
//
// The decision is in src/lib/leaddb/ad-stage.ts. Never writes the lead's delivery status or CRM push time. Codes only.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: Request) {
  const verified = await verifyInbound(request);
  if (!verified.ok) return verified.response;
  if (!hasServiceRole()) return Response.json({ ok: false, code: 'server_error' }, { status: 503 });

  const outcome = await runStageUpdate(liveAdStageDeps(), verified.json);
  if (outcome.status === 500) console.error('[leaddb-ad-route] stage failed:', outcome.body.code);
  return Response.json(outcome.body, { status: outcome.status });
}
