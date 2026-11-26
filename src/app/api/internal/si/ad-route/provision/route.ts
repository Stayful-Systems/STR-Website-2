import { hasServiceRole } from '@/lib/supabase/admin';
import { verifyInbound } from '@/lib/leaddb/inbound';
import { parseProvisionBody, runProvision } from '@/lib/leaddb/provision-run';
import { liveProvisionDeps } from '@/lib/leaddb/provision-server';

// ─── Lead database ad route: provision (Batch 55, Part A, phase A3) ─────
// The lead database calls this once a customer who has no Academy, no website
// and no domain wants the three landlord ads. It creates (or links) the
// member, stores the ad account (allowed = false: Zac switches each owner on
// at /admin/ad-packs) and makes the branded calculator site.
//
//   POST { ld_customer_id, email, company, phone, state }   (signed, see inbound.ts)
//   → 200 { ok: true, code: 'created' | 'exists' }
//   → 400 bad_request   409 has_website | conflict   500 server_error
//
// Repeating a call for the same ld_customer_id is safe: 'exists', the state is
// applied (older pushes are ignored), the site is finished if it was not.
// The response and the logs carry codes only: never an email, a company, a
// phone or a body. Nothing here sends an email or writes leads.status.
// Contract for the lead database: docs/build/batch-55-part-a-CONTRACT.md.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: Request) {
  const verified = await verifyInbound(request);
  if (!verified.ok) return verified.response;
  if (!hasServiceRole()) return Response.json({ ok: false, code: 'server_error' }, { status: 503 });

  const input = parseProvisionBody(verified.json);
  if (!input) return Response.json({ ok: false, code: 'bad_request' }, { status: 400 });

  try {
    const outcome = await runProvision(liveProvisionDeps(), input);
    return Response.json(outcome.body, { status: outcome.status });
  } catch (err) {
    // A code only (the database's own), never the error's text.
    const text = err instanceof Error ? err.message : '';
    console.error('[leaddb-ad-route] provision failed:', /^[a-z_]+:[A-Za-z0-9_]+$/.test(text) ? text : 'error');
    return Response.json({ ok: false, code: 'server_error' }, { status: 500 });
  }
}
