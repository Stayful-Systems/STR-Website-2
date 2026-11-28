import 'server-only';

import { createAdminClient } from '../supabase/admin';
import { reserveAnalysis, runAnalysis } from '../analysis/run';
import { renderReportPdf } from '../pdf/render';
import { pdfBrand } from '../pdf/theme';
import { sniffPhoto } from './photos.ts';
import type { ExampleDeps } from './example-step.ts';
import { adPackFetchImage } from './files-server';
import { measurePng, renderCarousel, renderPhoneFrames } from './ld-images';

/**
 * Batch 55 step 5 (Phase 2, 55c A2): the live wiring of the example report step (example-step.ts).
 *
 *   runExample   the report engine for "Example property, <area>" as HOUSE SPEND (billedUserId null: logged, never
 *                charged). The result is NEVER saved to analyser_reports (runAnalysis does not save; this never calls
 *                a save). The raw pence it cost is returned for ad_pack_runs.
 *   snapshotRow  the newest finished analyser_reports row for the postcode area and bedroom count: ONLY raw_response is
 *                selected (never the address, lead_email, filename or notes).
 *   renderPdf    the branded report, ALWAYS with the customer's brand (a report with no brand gets Stayful's logo and plan
 *                page: StayfulReport.tsx), with no booking link and no reply-to (nothing to invent on an example).
 *
 * Logs carry a code at most.
 */
export function createLiveExampleDeps(): ExampleDeps {
  return {
    async runExample(input) {
      const opts = { billedUserId: null, admin: true } as const;
      const prepared = await reserveAnalysis(input, opts);
      const run = await runAnalysis(prepared, input, opts);
      return { result: run.result, costPence: Math.ceil(Math.max(0, run.spend.basePence)) };
    },
    async snapshotRow(postcodeArea, bedrooms) {
      if (!/^[A-Z]{1,2}$/.test(postcodeArea) || !Number.isInteger(bedrooms)) return null;
      const { data, error } = await createAdminClient()
        .from('analyser_reports')
        .select('raw_response')
        .eq('postcode_area', postcodeArea)
        .eq('bedrooms', bedrooms)
        .eq('extraction_status', 'ok')
        .not('raw_response', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        console.error('[ad-packs] example snapshot read failed:', error.code ?? 'error');
        return null;
      }
      return (data as { raw_response: unknown } | null) ?? null;
    },
    // The 3a carousel and the 5b phone frames (ld-images.tsx), and the picture measure.
    renderCarousel: (a) => renderCarousel({ ...a, fetchImage: adPackFetchImage }),
    renderPhoneFrames: (a) => renderPhoneFrames({ company: a.company, brandColour: a.brandColour, logoUrl: a.logoRef, areaLabel: a.areaLabel, bedrooms: a.bedrooms, fetchImage: adPackFetchImage }),
    measurePng,
    async renderPdf(result, brand) {
      const kind = brand.logo ? sniffPhoto(brand.logo) : null;
      const logoDataUri = brand.logo && kind ? `data:image/${kind === 'png' ? 'png' : 'jpeg'};base64,${Buffer.from(brand.logo).toString('base64')}` : undefined;
      const buf = await renderReportPdf(result, {
        brand: pdfBrand({ companyName: brand.company, contactLine: brand.company, primary: brand.colour, ...(logoDataUri ? { logoDataUri } : {}) }),
      });
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
  };
}
