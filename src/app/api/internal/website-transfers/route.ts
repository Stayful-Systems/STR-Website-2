import { authoriseInternal, internalSecretsConfigured } from '@/lib/internal-auth';
import { hasServiceRole } from '@/lib/supabase/admin';
import { runDomainStep, runEmailStep, runExportStep, runOverlapStep, runPollStep, runStuckStep, type StepName, type SweepOpts, type SweepResult } from '@/lib/websites/transfer-server';

// ─── Customer website transfers (Batch 37, Phase 7) ────────────────────
// Vercel cron (vercel.json: every ten minutes, minute 6). The engine and every
// rule are in src/lib/websites/transfer-run.ts (injected deps) and
// transfer-server.ts (the live wiring); this route only runs the six steps in
// order within a time budget:
//   1 build one pending export    2 email the exports that are ready
//   3 request the pending domains 4 poll the requested ones
//   5 alert the stuck ones (once) 6 end the overlaps that are due
// A step that finds nothing due is cheap. One transfer failing never stops the
// rest (each step catches per row). No new row is started after the budget.
//
//   ?dry=1   lists what each step would take (transfer ids and step names only);
//            writes nothing, sends nothing, calls no registrar
//
//   curl -H "x-internal-secret: $INTERNAL_API_SECRET" "https://<host>/api/internal/website-transfers?dry=1"
//
// The response and the logs carry ids and codes only: never an address, an
// email, a transfer code, a form body or a zip link.

export const runtime = 'nodejs';
export const maxDuration = 60;

/** No new step or row is started after this long into the run (maxDuration is 60 s). */
const BUDGET_MS = 40_000;

const STEPS: ReadonlyArray<readonly [StepName, (opts: SweepOpts) => Promise<SweepResult>]> = [
  ['export', runExportStep],
  ['email', runEmailStep],
  ['domain', runDomainStep],
  ['poll', runPollStep],
  ['stuck', runStuckStep],
  ['overlap', runOverlapStep],
];

export async function GET(request: Request) {
  if (!internalSecretsConfigured()) return Response.json({ error: 'Not found' }, { status: 404 });
  if (!authoriseInternal(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasServiceRole()) return Response.json({ error: 'Storage not configured' }, { status: 503 });

  const dry = new URL(request.url).searchParams.get('dry') === '1';
  const started = Date.now();
  const until = started + BUDGET_MS;
  const steps: Array<SweepResult | { step: StepName; skipped: 'out_of_time' }> = [];
  try {
    for (const [step, run] of STEPS) {
      if (Date.now() > until) {
        steps.push({ step, skipped: 'out_of_time' });
        continue;
      }
      steps.push(await run({ dryRun: dry, until }));
    }
    return Response.json({ dry, steps, ms: Date.now() - started });
  } catch (err) {
    console.error('[website-transfers] run failed:', err instanceof Error ? err.name : 'error');
    return Response.json({ error: 'Run failed' }, { status: 500 });
  }
}
