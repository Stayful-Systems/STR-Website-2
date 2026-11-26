import { createAdminClient, hasServiceRole } from '@/lib/supabase/admin';
import { confirmLink } from '@/lib/auth/magic-link';
import { readAdAccountByCustomerId } from '@/lib/leaddb/ad-account-server';
import { asObject, parseLdCustomerId, verifyInbound } from '@/lib/leaddb/inbound';

// ─── Lead database ad route: sign-in (Batch 55, Part A, phase A3) ───────
// A linked customer pressing "Make my ads" in the lead database lands signed
// in on /leads/ads. This mints ONE single-use sign-in link (generateLink then
// our own /auth/confirm link, like lead provisioning) and hands it back. No
// email is sent by this route or by Supabase; Supabase expires the link.
//
//   POST { ld_customer_id }   (signed, see inbound.ts)
//   → 200 { ok: true, url }
//   → 400 bad_request   404 unknown_customer   500 server_error
//
// Works only for a linked ld_customer_id. The url and the email are never
// logged. Contract: docs/build/batch-55-part-a-CONTRACT.md.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Where the signed-in customer lands. */
const LANDING_PATH = '/leads/ads';

export async function POST(request: Request) {
  const verified = await verifyInbound(request);
  if (!verified.ok) return verified.response;
  if (!hasServiceRole()) return Response.json({ ok: false, code: 'server_error' }, { status: 503 });

  const ldCustomerId = parseLdCustomerId(asObject(verified.json)?.ld_customer_id);
  if (!ldCustomerId) return Response.json({ ok: false, code: 'bad_request' }, { status: 400 });

  try {
    const account = await readAdAccountByCustomerId(ldCustomerId);
    if (!account) return Response.json({ ok: false, code: 'unknown_customer' }, { status: 404 });

    const admin = createAdminClient();
    const { data: profile, error: profileErr } = await admin.from('profiles').select('email').eq('id', account.ownerId).maybeSingle();
    const email = (profile as { email: string | null } | null)?.email ?? null;
    if (profileErr || !email) {
      console.error('[leaddb-ad-route] signin profile read failed:', profileErr?.code ?? 'no_email');
      return Response.json({ ok: false, code: 'server_error' }, { status: 500 });
    }

    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    const hashed = link?.properties?.hashed_token;
    if (linkErr || !hashed) {
      console.error('[leaddb-ad-route] signin link failed');
      return Response.json({ ok: false, code: 'server_error' }, { status: 500 });
    }
    return Response.json({ ok: true, url: confirmLink(hashed, LANDING_PATH) });
  } catch (err) {
    const text = err instanceof Error ? err.message : '';
    console.error('[leaddb-ad-route] signin failed:', /^[a-z_]+:[A-Za-z0-9_]+$/.test(text) ? text : 'error');
    return Response.json({ ok: false, code: 'server_error' }, { status: 500 });
  }
}
