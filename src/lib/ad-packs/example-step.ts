/**
 * Batch 55 step 5 (Phase 2, 55c A2): the example report step of the render worker (ad_pack_renders kind
 * 'example_report'). The generator queues it (its server action has 60 s; this runs in the cron worker, 300 s).
 *
 *   a  the pack must still be the row's version, on the lead database route, in preview or approved (else superseded)
 *   b  the example: an AnalysisInput for "Example property, <area>" at the main area's representative postcode
 *      (example-report.ts exampleInputFor), run as house spend through deps.example.runExample (the live wiring is
 *      reserveAnalysis + runAnalysis with billedUserId null; the tests inject a fake and never call the engine).
 *      When that fails or the area has no representative postcode: the newest finished analyser_reports row for the
 *      postcode area and bedroom count, stripped (deps.example.snapshotRow, example-report.ts strippedFromRow).
 *      NEVER saved to analyser_reports.
 *   c  exampleResultFor: the address reads "Example property, <area>", comparable titles and addresses are neutral
 *   d  the branded PDF (deps.example.renderPdf, ALWAYS with the customer's brand so no Stayful logo or plan page appears)
 *   e  the sandbox: poppler-utils, then ad-render/example_pages.py: pdftoppm -r 144, every £ word blurred from its exact
 *      box (pdftotext -bbox-layout), "Example report" stamped on every page, the loupe's stops from the headings
 *   f  the pages go to the private bucket under the version (example/page-N.png); the row is done with ExampleReady
 *   g  then: the phone (5b) and loupe (17) renders are queued, and the 3a carousel is drawn (deps.example.renderCarousel)
 *
 * FAILURE never blocks the pack (55c section 8). After the last try (or at once for a code no retry can fix) the
 * fallback look is made: the notice video is queued for 5b (notice.py, with the lead database script), 3a and 17 keep
 * their type-only cards, the ads' format becomes FALLBACK_FORMAT, and the code stays on the row and on the run row.
 *
 * Cost: what the run really cost (raw pence) plus the sandbox, on the row, the pack and ad_pack_runs (settle), so the
 * month's cap sees it. Logs carry a pack id and a code, never an address, a figure or a body.
 *
 * Pure: no network, no database, no server-only (everything reaches the world through deps).
 */
import type { AnalysisInput } from '../analysis/input.ts';
import type { AnalysisResult } from '../types.ts';
import { ANGLES, type Angle } from './codes.ts';
import { FALLBACK_FORMAT, conceptFor, type AdFormat } from './concepts.ts';
import { EXAMPLE_MASK, EXAMPLE_PAGES, examplePagePath, exampleInputFor, exampleResultFor, hasExampleFigures, parsePagesJson, postcodeAreaOf, strippedFromRow } from './example-report.ts';
import { DEFAULT_BRAND_COLOUR, MIN_SANDBOX_SECONDS, ROUTE_MAX_SECONDS, ROUTE_RESERVE_SECONDS, RenderFail, VENV, attemptPence, fetchAsset, normaliseColour, settle, wholePence, type RenderDeps, type RenderLine, type SandboxLike, type SandboxRun } from './render-core.ts';
import type { ExampleReady, RenderRow, RenderSettings } from './render-store.ts';
import { StoreError, type AdFileRef, type PackAdRow, type PackRow, type VideoBrand } from './store-types.ts';
import { isVoiceKey } from './voices.ts';

/** The files of ad-render/ the example step needs in its sandbox. */
export const EXAMPLE_RENDERER_FILES = ['example_pages.py', 'theme.py', 'requirements.txt', 'fonts/Archivo-SemiBold.ttf', 'fonts/Archivo-Medium.ttf', 'fonts/Anton-Regular.ttf', 'fonts/OFL.txt'] as const;
export const EXAMPLE_JOB_PATH = 'job.json';
export const EXAMPLE_PDF_PATH = 'example.pdf';
export const EXAMPLE_OUT = 'out/pages';
export const MAX_PAGE_BYTES = 8 * 1024 * 1024;
/** Codes a retry cannot fix: the fallback is made at once. */
const FINAL_EXAMPLE_CODES = new Set(['no_example', 'example_failed', 'example_no_figures', 'example_thin', 'superseded', 'bad_brief']);

/** The made-safe example result of a version, kept so a retry of the pictures never pays for the report again. */
export function exampleResultPath(ownerId: string, packId: string, version: number): string {
  return `${ownerId}/${packId}/v${version}/example/result.json`;
}

export type ExampleBrand = { company: string; colour: string; logo: Uint8Array | null };

export type CarouselImage = { name: string; width: number; height: number; png: Uint8Array };

export type ExampleDeps = {
  /** Run the report engine for the example input as house spend (billedUserId null). Throws on failure. */
  runExample: (input: AnalysisInput) => Promise<{ result: AnalysisResult; costPence: number }>;
  /** The newest finished analyser_reports row for the postcode area and bedroom count (only raw_response), or null. */
  snapshotRow: (postcodeArea: string, bedrooms: number) => Promise<{ raw_response: unknown } | null>;
  /** The branded report PDF (the customer's brand, never the default one). */
  renderPdf: (result: AnalysisResult, brand: ExampleBrand) => Promise<Uint8Array>;
  /** The 3a carousel from the stored pages (images.tsx, lead database route). Optional: left out, 3a keeps its fallback cards. */
  /**
   * The two phone frames of the 5b video (the calculator, then the form filled with the example), drawn with Satori from
   * the customer's calculator design (ld-images.tsx). Optional: left out, the phone video cannot be made (fallback).
   */
  renderPhoneFrames?: (a: { company: string; brandColour: string | null; logoRef: string | null; areaLabel: string; bedrooms: number | null }) => Promise<Uint8Array[]>;
  /** The picture measure of a PNG (sharp in the live wiring): 64-bin histogram and 32x32 grey thumbnail. */
  measurePng?: (png: Uint8Array) => Promise<{ hist: number[]; thumb: number[] }>;
  renderCarousel?: (a: { pages: { png: Uint8Array; width: number; height: number }[]; captions: string[]; brand: { company: string; brandColour: string; logoUrl: string | null }; base: 'cream' | 'white' }) => Promise<CarouselImage[]>;
};

type Spend = { reportPence: number; sandboxSeconds: number; sandboxId: string | null; startedMs: number };

const isPng = (b: Uint8Array | null): b is Uint8Array => !!b && b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** The example's figures: a fresh run, else a stripped finished report. Throws RenderFail with a code. */
async function exampleFigures(ex: ExampleDeps, pack: PackRow, brand: VideoBrand, spend: Spend): Promise<{ result: AnalysisResult; source: 'run' | 'snapshot' }> {
  const bedrooms = brand.bedrooms ?? pack.bedrooms ?? 2;
  const input = exampleInputFor({ areaKey: pack.areaKey ?? '', areaLabel: brand.areaLabel, bedrooms });
  if (input) {
    try {
      const run = await ex.runExample(input);
      spend.reportPence += Math.max(0, Number(run.costPence) || 0);
      if (hasExampleFigures(run.result)) return { result: run.result, source: 'run' };
    } catch {
      // fall through to the snapshot
    }
  }
  let row: { raw_response: unknown } | null = null;
  try {
    row = await ex.snapshotRow(postcodeAreaOf(pack.areaKey ?? ''), bedrooms);
  } catch {
    row = null;
  }
  const snap = strippedFromRow(row);
  if (!snap) throw new RenderFail(input ? 'example_failed' : 'no_example');
  if (!hasExampleFigures(snap)) throw new RenderFail('example_no_figures');
  return { result: snap, source: 'snapshot' };
}

async function runIn(sandbox: SandboxLike, cmd: { cmd: string; args: string[]; sudo?: boolean; env?: Record<string, string> }, timeoutMs: number, fail: string): Promise<SandboxRun> {
  let res: SandboxRun;
  try {
    res = await sandbox.run({ ...cmd, timeoutMs });
  } catch {
    throw new RenderFail('sandbox_failed');
  }
  if (res.timedOut) throw new RenderFail('timeout');
  if (res.exitCode !== 0) {
    const m = /^ERR (pages_failed|no_target|bad_job)\s*$/m.exec(res.stderr ?? '');
    throw new RenderFail(m ? 'pages_failed' : fail);
  }
  return res;
}

/** a to f. Returns the done files. */
async function makeExample(deps: RenderDeps, ex: ExampleDeps, row: RenderRow, pack: PackRow, settings: RenderSettings, spend: Spend): Promise<ExampleReady> {
  const ads = await deps.packs.listAds(pack.ownerId, pack.id);
  const ad5b = ads.find((a) => a.angle === '5b' && a.version === row.version);
  const brand = ad5b?.texts.brand;
  if (!brand || !brand.company.trim()) throw new RenderFail('bad_brief');

  // A retry (the pictures failed) reuses the made-safe result the first try kept: the report is paid for once.
  const cachePath = exampleResultPath(pack.ownerId, pack.id, row.version);
  let safe: AnalysisResult | null = null;
  let source: 'run' | 'snapshot' = 'run';
  try {
    const cached = await deps.storage.get(cachePath);
    if (cached) {
      const j = JSON.parse(new TextDecoder().decode(cached)) as { source?: string; result?: unknown };
      const r = strippedFromRow({ raw_response: j.result });
      if (r && hasExampleFigures(r)) {
        safe = exampleResultFor(r, brand.areaLabel);
        source = j.source === 'snapshot' ? 'snapshot' : 'run';
      }
    }
  } catch {
    safe = null;
  }
  if (!safe) {
    const got = await exampleFigures(ex, pack, brand, spend);
    safe = exampleResultFor(got.result, brand.areaLabel);
    source = got.source;
    try {
      await deps.storage.put(cachePath, new TextEncoder().encode(JSON.stringify({ source, result: safe })), 'application/json');
    } catch {
      (deps.log ?? (() => {}))('example_cache_failed', { packId: pack.id, code: 'upload_failed' });
    }
  }
  let logo: Uint8Array | null = null;
  if (brand.logoRef) logo = (await fetchAsset(deps, brand.logoRef, 'assets/logo'))?.content ?? null;
  let pdf: Uint8Array;
  try {
    pdf = await ex.renderPdf(safe, { company: brand.company, colour: normaliseColour(brand.colour), logo });
  } catch {
    throw new RenderFail('pages_failed');
  }
  if (!pdf || pdf.byteLength < 8) throw new RenderFail('pages_failed');

  const job = {
    pdf: EXAMPLE_PDF_PATH,
    out_dir: EXAMPLE_OUT,
    first: EXAMPLE_PAGES.first,
    last: EXAMPLE_PAGES.last,
    dpi: EXAMPLE_PAGES.dpi,
    stamp: EXAMPLE_MASK.stamp,
    pound: [...EXAMPLE_MASK.pound],
    targets: EXAMPLE_MASK.targets.map((t) => ({ id: t.id, headings: [...t.headings] })),
    brand_colour: normaliseColour(brand.colour ?? DEFAULT_BRAND_COLOUR),
  };
  const files = await deps.rendererFiles(EXAMPLE_RENDERER_FILES);

  // The route has ROUTE_MAX_SECONDS in all: what the report run took comes off the sandbox's budget. Too little left and
  // the row goes back (timeout, retried): the kept result means the next try starts at the pictures.
  const started = deps.now().getTime();
  const budget = Math.min(settings.maxSeconds, Math.floor(ROUTE_MAX_SECONDS - ROUTE_RESERVE_SECONDS - (started - spend.startedMs) / 1000));
  if (budget < MIN_SANDBOX_SECONDS) throw new RenderFail('timeout');
  const deadline = started + budget * 1000;
  const left = () => Math.max(1_000, deadline - deps.now().getTime());
  let sandbox: SandboxLike | null = null;
  const pngs: { name: string; bytes: Uint8Array; width: number; height: number }[] = [];
  let parsed: ReturnType<typeof parsePagesJson> = null;
  try {
    try {
      sandbox = await deps.sandbox({ vcpus: settings.vcpus, timeoutMs: budget * 1000 });
    } catch {
      throw new RenderFail('sandbox_failed');
    }
    spend.sandboxId = sandbox.id;
    try {
      await sandbox.writeFiles([...files, { path: EXAMPLE_JOB_PATH, content: new TextEncoder().encode(JSON.stringify(job)) }, { path: EXAMPLE_PDF_PATH, content: pdf }]);
    } catch {
      throw new RenderFail('sandbox_failed');
    }
    // poppler-utils gives pdftoppm (the pages as pictures) and pdftotext (the box of every word).
    await runIn(sandbox, { cmd: 'apt-get', args: ['update', '-qq'], sudo: true }, Math.min(90_000, left()), 'sandbox_failed');
    await runIn(sandbox, { cmd: 'apt-get', args: ['install', '-y', '-qq', '--no-install-recommends', 'poppler-utils'], sudo: true, env: { DEBIAN_FRONTEND: 'noninteractive' } }, Math.min(150_000, left()), 'pages_failed');
    await runIn(sandbox, { cmd: 'python3', args: ['-m', 'venv', VENV] }, Math.min(60_000, left()), 'sandbox_failed');
    await runIn(sandbox, { cmd: `${VENV}/bin/pip`, args: ['install', '--quiet', '--disable-pip-version-check', '-r', 'ad-render/requirements.txt'] }, Math.min(120_000, left()), 'sandbox_failed');
    // The job sits next to the PDF at the top of the folder; the script is found under ad-render/.
    await runIn(sandbox, { cmd: `${VENV}/bin/python`, args: ['ad-render/example_pages.py', '--job', EXAMPLE_JOB_PATH] }, left(), 'pages_failed');
    parsed = parsePagesJson(await sandbox.readFile(`${EXAMPLE_OUT}/pages.json`).catch(() => null));
    if (!parsed || parsed.pages.length === 0) throw new RenderFail('pages_failed');
    // Every page must say "Example report" (55c rule 4): a page the script did not stamp is not used.
    if (parsed.pages.some((p) => !p.stamped)) throw new RenderFail('pages_failed');
    for (const p of parsed.pages) {
      const bytes = await sandbox.readFile(`${EXAMPLE_OUT}/${p.file}`).catch(() => null);
      if (!isPng(bytes) || bytes.byteLength > MAX_PAGE_BYTES) throw new RenderFail('pages_failed');
      pngs.push({ name: p.file, bytes, width: p.width, height: p.height });
    }
  } finally {
    if (sandbox) {
      try {
        await sandbox.stop();
      } catch {
        (deps.log ?? (() => {}))('sandbox_stop_failed', { packId: pack.id, code: 'sandbox_failed' });
      }
      spend.sandboxSeconds = Math.max(0, (deps.now().getTime() - started) / 1000);
    }
  }

  const pages: AdFileRef[] = [];
  for (const [i, p] of pngs.entries()) {
    const path = examplePagePath(pack.ownerId, pack.id, row.version, i + 1);
    let up: { ok: boolean };
    try {
      up = await deps.storage.put(path, p.bytes, 'image/png');
    } catch {
      throw new RenderFail('upload_failed');
    }
    if (!up.ok) throw new RenderFail('upload_failed');
    pages.push({ name: `example-page-${i + 1}.png`, path, width: p.width, height: p.height, contentType: 'image/png', bytes: p.bytes.byteLength });
  }
  const masked = parsed ? parsed.pages.reduce((n, p) => n + p.masked, 0) : 0;
  return { status: 'example', pages, targets: parsed?.targets ?? [], masked, source };
}

async function setFormat(deps: RenderDeps, pack: PackRow, ad: PackAdRow, format: AdFormat): Promise<void> {
  try {
    if (deps.packs.setAdFormat) await deps.packs.setAdFormat(pack.ownerId, ad.id, format);
  } catch {
    (deps.log ?? (() => {}))('example_format_failed', { packId: pack.id, code: 'store_failed' });
  }
}

/** g: the success path. The videos are queued; the carousel is drawn when the renderer is wired. Never throws. */
async function afterExample(deps: RenderDeps, row: RenderRow, pack: PackRow, ready: ExampleReady): Promise<void> {
  const log = deps.log ?? (() => {});
  const ads = (await deps.packs.listAds(pack.ownerId, pack.id).catch(() => [] as PackAdRow[])).filter((a) => a.version === row.version);
  for (const kind of ['phone', 'loupe'] as const) {
    try {
      const r = await deps.renders.enqueue(pack.id, row.version, row.voiceKey, kind);
      const ad = ads.find((a) => a.angle === (kind === 'phone' ? '5b' : '17'));
      if (ad) await deps.packs.setAdVideo(pack.ownerId, ad.id, r.row.state === 'done' && r.row.files ? r.row.files : { status: 'queued' });
    } catch {
      log('example_enqueue_failed', { packId: pack.id, code: kind });
    }
  }
  const ex = deps.example;
  const ad3a = ads.find((a) => a.angle === '3a');
  if (!ex?.renderCarousel || !ad3a || !ad3a.texts.ld) return;
  try {
    const pages: { png: Uint8Array; width: number; height: number }[] = [];
    for (const p of ready.pages.slice(0, 3)) {
      const bytes = await deps.storage.get(p.path);
      if (!isPng(bytes)) throw new RenderFail('missing_asset');
      pages.push({ png: bytes, width: p.width, height: p.height });
    }
    const brand = ads.find((a) => a.angle === '5b')?.texts.brand;
    const images = await ex.renderCarousel({
      pages,
      captions: ad3a.texts.ld.screenLines,
      brand: { company: brand?.company ?? '', brandColour: normaliseColour(brand?.colour ?? null), logoUrl: brand?.logoRef ?? null },
      base: ad3a.texts.ld.look.base,
    });
    const refs: AdFileRef[] = [];
    for (const img of images) {
      const path = `${pack.ownerId}/${pack.id}/v${row.version}/${img.name}`;
      const up = await deps.storage.put(path, img.png, 'image/png');
      if (!up.ok) throw new RenderFail('upload_failed');
      refs.push({ name: img.name, path, width: img.width, height: img.height, contentType: 'image/png', bytes: img.png.byteLength });
    }
    if (refs.length > 0) await deps.renders.setAdFiles(pack.ownerId, ad3a.id, { images: refs, video: null });
  } catch (e) {
    // The carousel failing leaves 3a on its type-only cards, recorded as such.
    log('carousel_failed', { packId: pack.id, code: e instanceof RenderFail ? e.code : 'render_failed' });
    await setFormat(deps, pack, ad3a, FALLBACK_FORMAT['3a']);
  }
}

/** The fallback look (55c section 8). Never throws. */
export async function fallBackFromExample(deps: RenderDeps, pack: PackRow, version: number, voiceKey: string, code: string): Promise<void> {
  const log = deps.log ?? (() => {});
  log('example_fallback', { packId: pack.id, code });
  let ads: PackAdRow[] = [];
  try {
    ads = (await deps.packs.listAds(pack.ownerId, pack.id)).filter((a) => a.version === version);
  } catch {
    ads = [];
  }
  for (const angle of ANGLES as readonly Angle[]) {
    const ad = ads.find((a) => a.angle === angle);
    if (ad && conceptFor(angle).format !== FALLBACK_FORMAT[angle]) await setFormat(deps, pack, ad, FALLBACK_FORMAT[angle]);
  }
  if (!isVoiceKey(voiceKey)) return;
  try {
    const r = await deps.renders.enqueue(pack.id, version, voiceKey);
    const ad = ads.find((a) => a.angle === '5b');
    if (ad && r.inserted) await deps.packs.setAdVideo(pack.ownerId, ad.id, { status: 'queued' });
  } catch {
    log('example_fallback_enqueue_failed', { packId: pack.id, code: 'store_failed' });
  }
}

/** One claimed example_report row, start to finish. Never throws. */
export async function runExampleRow(deps: RenderDeps, row: RenderRow, settings: RenderSettings): Promise<RenderLine> {
  const log = deps.log ?? (() => {});
  const spend: Spend = { reportPence: 0, sandboxSeconds: 0, sandboxId: null, startedMs: deps.now().getTime() };
  let pack: PackRow | null = null;
  let ready: ExampleReady | null = null;
  let code = 'example_failed';
  try {
    pack = await deps.renders.getPack(row.packId);
    if (!pack || pack.version !== row.version || pack.route !== 'leaddb' || (pack.status !== 'preview' && pack.status !== 'approved')) throw new RenderFail('superseded');
    if (!deps.example) throw new RenderFail('no_example');
    ready = await makeExample(deps, deps.example, row, pack, settings, spend);
  } catch (e) {
    code = e instanceof RenderFail ? e.code : e instanceof StoreError ? 'store_failed' : 'example_failed';
  }

  let cpuSecondPence = 0;
  try {
    cpuSecondPence = await deps.sandboxCpuSecondPence();
  } catch {
    cpuSecondPence = 0;
  }
  const attemptCost = wholePence(attemptPence({ vcpus: settings.vcpus, seconds: spend.sandboxSeconds, cpuSecondPence, voicePence: spend.reportPence }));
  const total = row.costPence + attemptCost;
  const finishedAt = deps.now().toISOString();
  const line = (outcome: RenderLine['outcome'], c?: string): RenderLine => ({ renderId: row.id, packId: row.packId, version: row.version, outcome, ...(c ? { code: c } : {}), seconds: Math.round(spend.sandboxSeconds), costPence: attemptCost });

  let result: RenderLine;
  try {
    if (ready && pack) {
      const ok = await deps.renders.complete(row.id, row.attempts, { costPence: total, sandboxId: spend.sandboxId, files: ready, finishedAt });
      result = ok ? line('done') : line('lost');
      log(ok ? 'example_done' : 'example_lost', { packId: row.packId, code: ok ? ready.source : 'lost' });
      if (ok) await afterExample(deps, row, pack, ready);
    } else {
      const retry = !FINAL_EXAMPLE_CODES.has(code) && row.attempts < settings.maxAttempts;
      const ok = await deps.renders.release(row.id, row.attempts, { state: retry ? 'queued' : 'failed', errorCode: code, costPence: total, sandboxId: spend.sandboxId, finishedAt: retry ? null : finishedAt });
      result = ok ? line(retry ? 'queued' : 'failed', code) : line('lost', code);
      log(retry ? 'example_retry' : 'example_failed', { packId: row.packId, code });
      if (ok && !retry && pack && code !== 'superseded') await fallBackFromExample(deps, pack, row.version, row.voiceKey, code);
    }
  } catch {
    result = line('lost', 'store_failed');
    log('example_finish_failed', { packId: row.packId, code: 'store_failed' });
  }
  if (attemptCost > 0 && pack) await settle(deps, pack, attemptCost, ready !== null, ready ? undefined : code, row.version, spend.sandboxSeconds, 'example_report');
  return result;
}

