import { authoriseInternal, internalSecretsConfigured } from '@/lib/internal-auth';
import { hasServiceRole } from '@/lib/supabase/admin';
import { runRenderQueue } from '@/lib/ad-packs/render-server';

/**
 * Renders the ad pack's notice video (Batch 38b), every five minutes.
 *
 * A render is never made inside a request. The pack is already stored and shown
 * (the video slot says "coming") when its render is queued; this worker claims
 * the oldest queued render, makes the voiceover (reusing a stored one on a
 * retry), renders the video in a Vercel Sandbox (Python + ffmpeg), uploads the
 * files and fills the 5b ad's video slot. One render per run: a render takes
 * about a minute and a half, and the function has five minutes.
 *
 * Same auth as every other internal route: Vercel Cron's bearer or the shared
 * header; 404 when no secret is configured. `?dry=1` lists what would run
 * (counts, pack ids, versions, states) and claims, calls and writes nothing.
 *
 * The response and the logs carry codes, counts and seconds only: never a
 * script, a brand text, an address or the sandbox's own output.
 */

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!internalSecretsConfigured()) return new Response('Not found', { status: 404 });
  if (!authoriseInternal(request)) return new Response('Unauthorised', { status: 401 });
  if (!hasServiceRole()) return Response.json({ error: 'service role not configured' }, { status: 503 });

  const dry = new URL(request.url).searchParams.get('dry') === '1';
  const started = Date.now();
  try {
    const report = await runRenderQueue({ dry, limit: 1 });
    return Response.json({ ...report, ms: Date.now() - started });
  } catch (err) {
    console.error('[ad-packs] render run failed:', err instanceof Error ? err.name : 'error');
    return Response.json({ error: 'run failed' }, { status: 500 });
  }
}

export const POST = GET;
