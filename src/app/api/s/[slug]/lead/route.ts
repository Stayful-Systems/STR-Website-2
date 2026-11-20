import { createAdminClient, hasServiceRole } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { teamOf } from '@/lib/team';
import { capMessage, countAttempt } from '@/lib/funnels/caps';
import { captureLead } from '@/lib/leads/store';
import { reuseSince } from '@/lib/leads/dedupe';
import { verifyTurnstile } from '@/lib/turnstile/verify';
import { validateStepOne } from '@/lib/websites/checks';
import { isSelfSubmit } from '@/lib/websites/policy';
import { parseSources } from '@/lib/websites/sources';
import { issueStepToken } from '@/lib/websites/step-token';
import { liveSiteBySlug, type WebsiteRow } from '@/lib/websites/store-server';
import { notifyOperatorOfWebsiteLead } from '@/lib/websites/notify-server';
import { enqueueLeadDbPush } from '@/lib/leaddb/deliver';
import { linkLeadToPackAd } from '@/lib/ad-packs/attribution-server';
import { domainIsLiveFor } from '@/lib/domains/store-server';
import { siteDomain } from '@/lib/websites/urls';

/**
 * Step 1 of a customer website's form: POST /api/s/<slug>/lead.
 *
 * Public: no session, no account. The landlord gives a name, email, phone and
 * the consent tick; there is NO address yet. What this does, in this order:
 *
 *   1. the site must be LIVE (liveSiteBySlug), else 404
 *   2. Turnstile says a person submitted this, BEFORE the caps are counted
 *   3. countAttempt against the website's own funnel row (kind='website'):
 *      the per-IP window and the site's daily share. Step 1 ONLY: step 2 never
 *      counts, so a landlord who got past step 1 is never locked out of step 2
 *   4. validateStepOne (consent required, no disposable email)
 *   5. the lead is saved as a NEW lead (never 'queued': nothing here runs a
 *      report, spends or drains), address null. The same enquiry inside the
 *      hour is the same lead (the funnel's dedupe window), never a second one
 *   6. lead_sources (utm_*, fbclid, ad code, landing path) and the report row
 *      (awaiting_address, self-submit flag) are inserted once, on conflict do
 *      nothing: a resubmit changes nothing and reveals nothing
 *   7. the operator's "new landlord lead" email (once per lead)
 *
 * A lead saved here stays a New lead whether or not step 2 ever happens: no
 * later step is needed for it to exist, and nothing here depends on one.
 *
 * The answer is `{ ok: true, token }` and nothing else about the lead. The
 * token (src/lib/websites/step-token.ts) is issued ONLY while the report is
 * awaiting its address: a resubmit after the report has moved on gets
 * `token: null`, never a prior result, a state or a figure. The token is sent
 * in this body and read from step 2's body only: never a URL, cookie or log.
 *
 * Nothing here logs the body, the contact details or the token; log lines
 * carry a lead id and an error name at most.
 */

export const maxDuration = 30;

const JSON_HEADERS = { 'Cache-Control': 'no-store' } as const;

function reply(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: JSON_HEADERS });
}

const SAVE_FAILED = 'We could not save your details just now. Please try again shortly.';

/** Plain-object check for the attribution the page read from its own address. */
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The owner's account email and mobile, for the self-submit check. Null on any failure: not a self-submit. */
async function ownerContact(ownerId: string): Promise<{ email: string | null; phone: string | null }> {
  const { data } = await createAdminClient().from('profiles').select('email, mobile').eq('id', ownerId).maybeSingle();
  const row = data as { email?: string | null; mobile?: string | null } | null;
  return { email: row?.email ?? null, phone: row?.mobile ?? null };
}

/** The signed-in person on this request (a session cookie), if any, and whether they work for the site's owner. */
async function sessionFacts(site: WebsiteRow): Promise<{ sessionUserId: string | null; teamUserIds: string[] }> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    const id = data.user?.id ?? null;
    if (!id) return { sessionUserId: null, teamUserIds: [] };
    const team = await teamOf(id);
    return { sessionUserId: id, teamUserIds: team.ownerId === site.userId ? [id] : [] };
  } catch {
    return { sessionUserId: null, teamUserIds: [] };
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  // ── 1. A live site only. Preview, paused and unknown all read as missing. ──
  const site = await liveSiteBySlug(slug);
  if (!site) return new Response('Not found', { status: 404 });

  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || 'unknown';

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply({ ok: false, error: 'We could not read that submission. Please try again.' }, 400);
  }
  const b = asRecord(body) ?? {};

  // ── 1b. The honeypot (Batch 33): a field a person never sees. Filled means a bot: a quiet success, nothing saved. ──
  if (typeof b.hp === 'string' && b.hp.trim() !== '') return reply({ ok: true, token: null });

  // ── 2. Turnstile, before the caps are counted (see the funnel's analyse route for why). ──
  // Batch 33: skipped ONLY when the site's own domain is live, decided here from the database (Turnstile's free plan
  // cannot cover customer domains). The per-IP limit, the free-report caps and the honeypot still apply.
  const ownDomainLive = await domainIsLiveFor(site.id, siteDomain(site));
  if (!ownDomainLive) {
    const human = await verifyTurnstile(typeof b.turnstileToken === 'string' ? b.turnstileToken : null, ip);
    if (!human.allow) return reply({ ok: false, error: human.message }, 403);
  }

  // ── 3. Caps, against the website's own funnel row. Step 1 only. ──
  const admin = hasServiceRole() ? createAdminClient() : null;
  if (!admin) return reply({ ok: false, error: SAVE_FAILED }, 503);
  const { data: funnelRow } = await admin.from('funnels').select('daily_cap').eq('id', site.funnelId).eq('user_id', site.userId).eq('kind', 'website').maybeSingle();
  if (!funnelRow) return reply({ ok: false, error: SAVE_FAILED }, 503);
  const dailyCap = Number((funnelRow as { daily_cap?: unknown }).daily_cap) || 100;
  const verdict = await countAttempt(site.funnelId, ip, dailyCap);
  if (verdict !== 'ok') return reply({ ok: false, error: capMessage(verdict) }, verdict === 'unavailable' ? 503 : 429);

  // ── 4. Validate. Consent is required: without it nothing is written. ──
  const checked = validateStepOne({ name: b.name, email: b.email, phone: b.phone, consent: b.consent });
  if (!checked.ok) return reply({ ok: false, errors: checked.errors }, 400);
  const { name, email, phone } = checked.clean;

  // ── 5. The lead: the same enquiry inside the hour is the same lead. ──
  //
  // captureLead's own dedupe needs a postcode, and step 1 has none, so the
  // same window is applied here by email on this website's funnel.
  let leadId: string | null = null;
  const { data: prior, error: priorError } = await admin
    .from('leads')
    .select('id')
    .eq('funnel_id', site.funnelId)
    .eq('user_id', site.userId)
    .eq('email', email)
    .is('archived_at', null)
    .gte('created_at', reuseSince(new Date()))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (priorError) console.error('[website-lead] reuse check failed:', priorError.code ?? 'error');
  if (prior) leadId = (prior as { id: string }).id;

  if (!leadId) {
    const captured = await captureLead({
      userId: site.userId,
      funnelId: site.funnelId,
      contact: { name, email, phone, consentAt: new Date().toISOString() },
      property: { address: null, postcode: null, bedrooms: null },
      // A website lead is New from the moment it is saved. 'queued' would hand it to the drain, which runs reports.
      status: 'new',
    });
    if (!captured) return reply({ ok: false, error: SAVE_FAILED }, 500);
    leadId = captured.id;
  }

  // ── 6. Attribution and the report row, once each. ──
  const rawSources = asRecord(b.sources) ?? {};
  const sources = parseSources(Object.fromEntries(Object.entries(rawSources).filter(([, v]) => typeof v === 'string')) as Record<string, string>, b.landing);
  const { error: sourceError } = await admin.from('lead_sources').upsert({ lead_id: leadId, ...sources }, { onConflict: 'lead_id', ignoreDuplicates: true });
  if (sourceError) console.error(`[website-lead] sources not saved for lead ${leadId}:`, sourceError.code ?? 'error');

  const [owner, session] = await Promise.all([ownerContact(site.userId), sessionFacts(site)]);
  const selfSubmit = isSelfSubmit({
    leadEmail: email,
    leadPhone: phone,
    ownerEmail: owner.email,
    ownerPhone: owner.phone,
    siteEmail: site.settings.contactEmail,
    sitePhone: site.settings.contactPhone,
    sessionUserId: session.sessionUserId,
    ownerUserId: site.userId,
    teamUserIds: session.teamUserIds,
  });
  const { error: reportError } = await admin
    .from('website_reports')
    .upsert({ lead_id: leadId, website_id: site.id, state: 'awaiting_address', self_submit: selfSubmit }, { onConflict: 'lead_id', ignoreDuplicates: true });
  if (reportError) console.error(`[website-lead] report row not saved for lead ${leadId}:`, reportError.code ?? 'error');

  void enqueueLeadDbPush(leadId).catch(() => {}); // Batch 32: the operator's lead database gets it too (never throws, never waits)
  void linkLeadToPackAd(leadId).catch(() => {}); // Batch 38: record which pack ad brought it (never throws, never waits)

  // ── 7. The operator hears of the lead now, not only when a report finishes. Once per lead. ──
  await notifyOperatorOfWebsiteLead({ leadId, websiteId: site.id });

  // ── The answer: a token while the report is awaiting its address; nothing else about the lead. ──
  const { data: current } = await admin.from('website_reports').select('state').eq('lead_id', leadId).eq('website_id', site.id).maybeSingle();
  const awaiting = (current as { state?: string } | null)?.state === 'awaiting_address';
  if (!awaiting) return reply({ ok: true, token: null });
  const token = issueStepToken({ leadId, websiteId: site.id });
  if (!token) {
    // No signing key: fail closed. The lead is saved and the operator told; step 2 simply cannot start.
    console.error(`[website-lead] step 2 cannot start for lead ${leadId}: no signing key`);
    return reply({ ok: false, error: SAVE_FAILED }, 503);
  }
  return reply({ ok: true, token });
}
