import { authoriseInternal, internalSecretsConfigured } from '@/lib/internal-auth';
import { hasServiceRole } from '@/lib/supabase/admin';
import { runAdSheetImport } from '@/lib/ad-sheets/import-server';
import { adSheetsEnabled, runQuietCheckLive } from '@/lib/ad-sheets/quiet-server';

/**
 * Hourly: reads operators' Facebook lead-form sheets and then checks for quiet
 * ones (Batch 35).
 *
 * Runs the import (src/lib/ad-sheets/import-server.ts) and then the quiet check
 * (one capped email to an operator whose sheet has had no new row for
 * ad_sheet_quiet_days). Does nothing at all while billing_settings
 * ad_sheets_enabled is off (the whole feature ships off) and skips everything
 * when the Google service account is not configured. The response is counts
 * and codes only: never a row's contents, an address or a lead.
 *
 * Same auth as every other internal route: Vercel Cron's bearer or the shared
 * header; 404 when no secret is configured. `?dry=1` lists what would be read
 * and who would be emailed, and writes, sends and stamps nothing.
 */

export const maxDuration = 60;

export async function GET(request: Request) {
  if (!internalSecretsConfigured()) return new Response('Not found', { status: 404 });
  if (!authoriseInternal(request)) return new Response('Unauthorised', { status: 401 });
  if (!hasServiceRole()) return Response.json({ error: 'service role not configured' }, { status: 503 });

  const dry = new URL(request.url).searchParams.get('dry') === '1';
  const started = Date.now();
  if (!(await adSheetsEnabled())) return Response.json({ code: 'disabled', dry, ms: Date.now() - started });

  const imported = await runAdSheetImport({ dry });
  if (imported.code === 'not_configured') return Response.json({ code: 'not_configured', dry, ms: Date.now() - started });

  const quiet = await runQuietCheckLive({ dry });
  return Response.json({ code: imported.code, import: imported, quiet, dry, ms: Date.now() - started });
}
