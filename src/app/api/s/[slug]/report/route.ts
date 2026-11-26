import { createAdminClient, hasServiceRole } from '@/lib/supabase/admin';
import { parseAnalysisInput } from '@/lib/analysis/input';
import { postcodeAreaOf } from '@/lib/listing/normalise';
import { currentReportState, runWebsiteReport, type WebsiteReportState } from '@/lib/websites/report-server';
import { readStepToken } from '@/lib/websites/step-token';
import { liveSiteBySlug } from '@/lib/websites/store-server';
import { calculatorStopped } from '@/lib/websites/calculator-server';

/**
 * Step 2 of a customer website's form: POST /api/s/<slug>/report.
 *
 * Body: { token, address, postcode, bedrooms, guests, propertyType?, bathrooms?,
 * parking?, outdoorSpace? }. The token is the one step 1 answered with, read
 * from this body only (never a URL, cookie or log).
 *
 * What this does, in this order:
 *
 *   1. the site must be LIVE, else 404
 *   2. the token must verify (signature, 30 minutes, THIS website); any failure
 *      is the same generic refusal, so nothing says why
 *   3. the report row must exist for that lead and website, else the same refusal
 *   4. only while the report is awaiting_address: the address is saved to the
 *      lead (leads.address / postcode / bedrooms and leads.input, as the funnel
 *      does; first writer wins) and runWebsiteReport runs it
 *   5. any other state (a second call, a double click, a report already held,
 *      running or done): the CURRENT state comes back. The report is never run
 *      twice, and nothing beyond the landlord's outcome is ever revealed
 *
 * This route does NOT count an attempt against the funnel's caps. Step 1 did;
 * a landlord who got through step 1 must never be turned away at step 2 by a
 * limit they have already paid for with their one submission.
 *
 * The answer is a stream of progress TEXT only: { stage, progress, message }
 * events with no address, no figures and no contact details, then one final
 * event { stage: 'complete', progress: 100, outcome, message, summary } where
 * outcome is
 *   summary | summary_caveat   summary holds the headline figures (summary.ts)
 *   held                       the 24-hour message
 *   will_contact               "<Company> will be in touch"
 * and summary is null unless outcome is a summary one. The AnalysisResult is
 * never in a response, and the address is never echoed.
 *
 * Nothing here logs the body, the address, the token or an email; log lines
 * carry a lead id and an error name at most.
 */

export const maxDuration = 60;

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

function sse(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** A one-event stream, for answers that need no work (and for every refusal). */
function sseOnce(data: Record<string, unknown>, status = 200): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse(data)));
        controller.close();
      },
    }),
    { status, headers: SSE_HEADERS },
  );
}

const HELD_MESSAGE = 'Thank you. We are very busy at the moment, so your income estimate will reach you within 24 hours.';
const EXPIRED_MESSAGE = 'This form has expired. Please start again.';
const SAVE_FAILED = 'We could not start your estimate just now. Please try again shortly.';

/** The landlord's outcome as the final event. The state's own fields, nothing else. */
function finalEvent(state: WebsiteReportState, companyName: string): Record<string, unknown> {
  const shown = state.outcome === 'summary' || state.outcome === 'summary_caveat';
  const message =
    state.outcome === 'held'
      ? HELD_MESSAGE
      : shown
        ? 'Your estimate is ready.'
        : `${companyName.trim() || 'We'} will be in touch.`;
  return { stage: 'complete', progress: 100, outcome: state.outcome, message, summary: shown ? state.summary : null };
}

/**
 * The only fields a landlord may set. Everything else parseAnalysisInput reads
 * (fromDeal, checkedListingId, sourceListing, prices, the enhanced switch) is
 * left out, so the public form cannot reach a deal's report or the PMI second
 * opinion. The email is the lead's own, from step 1.
 */
function addressBody(b: Record<string, unknown>, email: string | null): Record<string, unknown> {
  return {
    address: b.address,
    postcode: b.postcode,
    bedrooms: b.bedrooms,
    guests: b.guests,
    propertyType: b.propertyType,
    bathrooms: b.bathrooms,
    parking: b.parking,
    outdoorSpace: b.outdoorSpace,
    email,
  };
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  // ── 1. A live site only. ──
  const site = await liveSiteBySlug(slug);
  if (!site) return new Response('Not found', { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return sseOnce({ stage: 'error', progress: 0, message: 'We could not read that submission. Please try again.' }, 400);
  }
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;

  // ── 2. The token: this website, unexpired, signed. One answer for every failure. ──
  const claims = readStepToken(b.token);
  if (!claims || claims.websiteId !== site.id) {
    return sseOnce({ stage: 'error', progress: 0, message: EXPIRED_MESSAGE }, 403);
  }
  const leadId = claims.leadId;
  if (!hasServiceRole()) return sseOnce({ stage: 'error', progress: 0, message: SAVE_FAILED }, 503);

  // ── 3. The report row, for this lead and this website. ──
  const current = await currentReportState(leadId);
  const admin = createAdminClient();
  const { data: row } = await admin.from('website_reports').select('state, website_id').eq('lead_id', leadId).maybeSingle();
  const rowState = (row as { state?: string; website_id?: string } | null);
  if (!current || !rowState || rowState.website_id !== site.id) {
    return sseOnce({ stage: 'error', progress: 0, message: EXPIRED_MESSAGE }, 403);
  }

  // ── 5. Not awaiting its address: the current state, never a second run. ──
  if (current.state !== 'awaiting_address') return sseOnce(finalEvent(current, site.settings.companyName));

  // Batch 55: a calculator site with a stopped owner STARTS no new report. Only a report still awaiting its address gets here, so
  // one that is already running or done is answered above (its state, read only) and is never cut off.
  if (await calculatorStopped(site)) return new Response('Not found', { status: 404 });

  // ── 4. Awaiting its address: validate it, save it to the lead, run the report. ──
  const { data: lead } = await admin.from('leads').select('email').eq('id', leadId).eq('user_id', site.userId).eq('funnel_id', site.funnelId).maybeSingle();
  if (!lead) return sseOnce({ stage: 'error', progress: 0, message: EXPIRED_MESSAGE }, 403);
  const parsed = parseAnalysisInput(addressBody(b, (lead as { email?: string | null }).email ?? null));
  if (!parsed.ok) return sseOnce({ stage: 'error', progress: 0, message: parsed.error }, 400);
  const input = { ...parsed.input, enhancedRequested: false };

  // First writer wins: a second call racing this one never overwrites the address the run is using.
  const { error: saveError } = await admin
    .from('leads')
    .update({
      address: input.property.address,
      postcode: input.property.postcode,
      postcode_area: postcodeAreaOf(input.property.postcode),
      bedrooms: input.property.bedrooms,
      input,
    })
    .eq('id', leadId)
    .eq('user_id', site.userId)
    .eq('funnel_id', site.funnelId)
    .is('address', null);
  if (saveError) {
    console.error(`[website-report] step 2 not saved for lead ${leadId}:`, saveError.code ?? 'error');
    return sseOnce({ stage: 'error', progress: 0, message: SAVE_FAILED }, 500);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        try {
          controller.enqueue(new TextEncoder().encode(sse(data)));
        } catch {
          // The browser went away. The run carries on and the landlord's email carries the result.
        }
      };
      try {
        const state = await runWebsiteReport(leadId, {
          // Progress text only: stage, percentage and the fixed message.
          onProgress: (e) => send({ stage: String(e.stage), progress: Number(e.progress) || 0, message: String(e.message) }),
        });
        if (state) send(finalEvent(state, site.settings.companyName));
        else send({ stage: 'error', progress: 0, message: SAVE_FAILED });
      } catch (err) {
        // An error name only: an error's text may carry what a provider was asked.
        console.error(`[website-report] run failed for lead ${leadId}:`, err instanceof Error ? err.name : 'error');
        // The lead is saved and the cron retakes the lease: the landlord is told what is true.
        send({ stage: 'complete', progress: 100, outcome: 'will_contact', message: `${site.settings.companyName.trim() || 'We'} will be in touch.`, summary: null });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
