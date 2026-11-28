import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, type Harness } from './test-store.ts';
import { runRenderQueue, type RenderDeps } from './render-core.ts';
import { DEFAULT_RENDER_SETTINGS, kindOf, type RenderRow } from './render-store.ts';
import { FakeSandboxes, FakeStorage } from './render-test-store.ts';
import { EXAMPLE_JOB_PATH, EXAMPLE_OUT, type ExampleDeps } from './example-step.ts';
import { EXAMPLE_MASK, exampleAddress, exampleInputFor, exampleResultFor, postcodeAreaOf, stringsIn, strippedFromRow } from './example-report.ts';
import { sampleAnalysis } from '../pdf/__fixtures__/sample.ts';
import type { AnalysisInput } from '../analysis/input.ts';
import type { AnalysisResult } from '../types.ts';
import type { AdPackStore, PackAdRow } from './store-types.ts';

/** Batch 55 step 5 (Phase 2, 55c A2): the example report step on fakes. The report engine is never called. */

const OWNER = '3f9a2c11-1111-4111-8111-111111111111';
const APP_HOST = 'stay' + 'ful.co.uk';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PAGES_JSON = (stamped = true) =>
  new TextEncoder().encode(
    JSON.stringify({
      pages: [1, 2, 3, 4].map((i) => ({ file: `page-${i}.png`, width: 1190, height: 1684, masked: i === 4 ? 0 : 5, stamped })),
      targets: [
        { page: 2, x: 0.04, y: 0.5, w: 0.92, h: 0.22 },
        { page: 2, x: 0.04, y: 0.1, w: 0.92, h: 0.22 },
        { page: 3, x: 0.04, y: 0.3, w: 0.92, h: 0.22 },
      ],
    }),
  );

type Rig = { h: Harness; deps: RenderDeps; storage: FakeStorage; sandboxes: FakeSandboxes; runs: AnalysisInput[]; pdfs: { result: AnalysisResult; company: string }[]; snapshots: string[]; packId: string };

async function rig(o: { run?: 'ok' | 'throw' | 'thin'; snapshot?: 'ok' | 'none'; pages?: 'ok' | 'unstamped' | 'crash'; areaKey?: string; example?: boolean } = {}): Promise<Rig> {
  const h = harness({ exampleReports: true });
  if (o.areaKey) h.area.result = { ...(h.area.result as Exclude<typeof h.area.result, { error: string }>), areaKey: o.areaKey, areaLabel: 'Somewhere' };
  const made = await h.engine.generatePack({
    ownerId: OWNER,
    by: 'operator',
    input: { areaKey: o.areaKey ?? 'NG7', photos: [], brand: { company: 'Brightstone Stays', logoUrl: 'https://cdn.example.test/logo.png', brandColour: '#1F6F5C', feePct: 12, areas: ['Nottingham'], photoUrl: null }, domain: APP_HOST, route: 'leaddb', sitePath: 'brightstone-calc', websiteId: '00000000-0000-4000-8000-0000000000aa' },
  });
  assert.ok(made.ok && !made.dry, JSON.stringify(made));
  const packId = (made as { packId: string }).packId;
  const advance = (ms: number) => (h.now = new Date(h.now.getTime() + ms));
  const sandboxes = new FakeSandboxes(advance);
  sandboxes.opts.outputs = {
    [`${EXAMPLE_OUT}/pages.json`]: PAGES_JSON(o.pages !== 'unstamped'),
    ...Object.fromEntries([1, 2, 3, 4].map((i) => [`${EXAMPLE_OUT}/page-${i}.png`, PNG])),
  };
  sandboxes.opts.onRun = (cmd) => {
    advance(5_000);
    if (o.pages === 'crash' && cmd.args[0] === 'ad-render/example_pages.py') return { exitCode: 2, stderr: 'ERR pages_failed\n', timedOut: false };
    return { exitCode: 0, stderr: '', timedOut: false };
  };
  const storage = new FakeStorage();
  const runs: AnalysisInput[] = [];
  const pdfs: Rig['pdfs'] = [];
  const snapshots: string[] = [];
  const example: ExampleDeps = {
    runExample: async (input) => {
      runs.push(input);
      if (o.run === 'throw') throw new Error('engine down: 22 Princess Road West');
      const result = sampleAnalysis();
      if (o.run === 'thin') result.shortLet.comparables = [];
      return { result, costPence: 64 };
    },
    snapshotRow: async (area, beds) => {
      snapshots.push(`${area}:${beds}`);
      return o.snapshot === 'ok' ? { raw_response: sampleAnalysis() } : null;
    },
    renderPdf: async (result, brand) => {
      pdfs.push({ result, company: brand.company });
      return new TextEncoder().encode('%PDF-1.4 example');
    },
  };
  const deps: RenderDeps = {
    packs: h.store as AdPackStore,
    renders: h.renders,
    sandbox: sandboxes.factory,
    synth: async () => ({ ok: false, code: 'failed' }),
    storage,
    fetchImage: async () => ({ bytes: PNG, contentType: null }),
    rendererFiles: async (list) => (list ?? []).map((p) => ({ path: `ad-render/${p}`, content: new TextEncoder().encode('#') })),
    sandboxCpuSecondPence: async () => 0.00280889,
    renderSettings: async () => ({ ...DEFAULT_RENDER_SETTINGS }),
    now: () => h.now,
    ...(o.example === false ? {} : { example }),
  };
  return { h, deps, storage, sandboxes, runs, pdfs, snapshots, packId };
}

const rows = (r: Rig): RenderRow[] => [...r.h.renders.rows.values()];
const ads = (r: Rig): PackAdRow[] => [...r.h.store.ads.values()];

test('a lead database pack queues its example report, not the notice video; the Academy still queues the notice video', async () => {
  const r = await rig();
  assert.deepEqual(rows(r).map(kindOf), ['example_report']);
  const academy = harness({ exampleReports: true });
  const a = await academy.engine.generatePack({ ownerId: OWNER, by: 'operator', input: { areaKey: 'NG7', photos: [], brand: { company: 'Brightstone Stays', logoUrl: 'https://cdn.example.test/logo.png', brandColour: '#1F6F5C', feePct: 12, areas: [], photoUrl: null }, domain: 'brightstone.co.uk' } });
  assert.ok(a.ok);
  assert.deepEqual([...academy.renders.rows.values()].map(kindOf), ['notice']);
});

test('the example run: "Example property, <area>" at the representative postcode, house spend, then masked pages stored, the videos queued', async () => {
  const r = await rig();
  const report = await runRenderQueue(r.deps);
  assert.equal(report.results[0].outcome, 'done', JSON.stringify(report.results));
  assert.equal(r.runs.length, 1);
  assert.match(r.runs[0].property.address, /^Example property, .*Nottingham$/);
  assert.equal(r.runs[0].property.postcode, 'NG1 5DT');
  assert.equal(r.runs[0].email, null);
  // The PDF is drawn in the customer's brand, from the made-safe result.
  assert.equal(r.pdfs[0].company, 'Brightstone Stays');
  assert.equal(r.pdfs[0].result.property.address, r.runs[0].property.address);
  // The job asks for the £ blur, the stamp and the three loupe stops.
  const job = JSON.parse(new TextDecoder().decode(r.sandboxes.created[0].sandbox.files.get(EXAMPLE_JOB_PATH)!));
  assert.deepEqual(job.pound, ['£']);
  assert.equal(job.stamp, 'Example report');
  assert.equal(job.dpi, 144);
  assert.deepEqual(job.targets.map((t: { id: string }) => t.id), ['comparables', 'occupancy', 'demand']);
  // poppler-utils is installed in the sandbox; pdftoppm runs there, never in the request.
  assert.ok(r.sandboxes.created[0].sandbox.commands.some((c) => c.args.includes('poppler-utils')));
  // The pages are in the private bucket under the version; the row holds them.
  const done = rows(r).find((x) => kindOf(x) === 'example_report')!;
  assert.equal(done.state, 'done');
  assert.equal(done.example?.pages.length, 4);
  assert.ok(done.example!.pages.every((p) => p.path.startsWith(`${OWNER}/${r.packId}/v1/example/page-`)));
  assert.equal(done.example!.source, 'run');
  assert.equal(done.example!.targets.length, 3);
  // Then the two new videos are queued, and their slots say so.
  assert.deepEqual(rows(r).map(kindOf).sort(), ['example_report', 'loupe', 'phone']);
  assert.equal(ads(r).find((a) => a.angle === '17')!.files.video?.status, 'queued');
  // The cost is on ad_pack_runs (the month's cap reads it), and it stays under the ceiling.
  const runRows = await r.h.store.listRuns(OWNER, r.packId);
  const exRun = runRows.find((x) => (x.result as { renderKind?: string } | null)?.renderKind === 'example_report');
  assert.ok(exRun && exRun.costPence >= 64);
  const pack = await r.h.store.getPack(OWNER);
  assert.ok(pack!.costPence <= r.h.store.settings.maxRawPence, `${pack!.costPence}`);
});

test('a failed run falls back to a stripped finished report for the postcode area and bedrooms', async () => {
  const r = await rig({ run: 'throw', snapshot: 'ok' });
  const report = await runRenderQueue(r.deps);
  assert.equal(report.results[0].outcome, 'done');
  assert.deepEqual(r.snapshots, ['NG:3']);
  assert.equal(rows(r).find((x) => kindOf(x) === 'example_report')!.example!.source, 'snapshot');
  assert.match(r.pdfs[0].result.property.address, /^Example property, .*Nottingham$/);
});

test('a crashed example report falls back to the old look, records why, and never blocks the pack', async () => {
  const r = await rig({ run: 'throw', snapshot: 'none' });
  const report = await runRenderQueue(r.deps);
  assert.equal(report.results[0].outcome, 'failed');
  assert.equal(report.results[0].code, 'example_failed');
  const ex = rows(r).find((x) => kindOf(x) === 'example_report')!;
  assert.equal(ex.errorCode, 'example_failed');
  // The notice video is queued for 5b, and the formats are the fallback ones.
  assert.ok(rows(r).some((x) => kindOf(x) === 'notice' && x.state === 'queued'));
  assert.deepEqual(ads(r).map((a) => [a.angle, a.format]).sort(), [['17', 'type_cards'], ['3a', 'type_cards'], ['5b', 'notice_video']]);
  assert.equal(ads(r).find((a) => a.angle === '5b')!.files.video?.status, 'queued');
  // 3a and 17 keep their type-only cards; the pack stays in preview.
  assert.ok(ads(r).find((a) => a.angle === '3a')!.files.images.length > 0);
  assert.equal((await r.h.store.getPack(OWNER))!.status, 'preview');
});

test('thin data, no figures and no example deps are final at once (no retry), with their own codes', async () => {
  const thin = await rig({ run: 'thin', snapshot: 'none' });
  assert.equal((await runRenderQueue(thin.deps)).results[0].code, 'example_failed');
  const none = await rig({ example: false });
  const res = await runRenderQueue(none.deps);
  assert.equal(res.results[0].code, 'no_example');
  assert.equal(res.results[0].outcome, 'failed');
});

test('pages the sandbox could not make, or did not stamp, are never used: the row is tried again, then falls back', async () => {
  const r = await rig({ pages: 'unstamped' });
  const first = await runRenderQueue(r.deps);
  assert.equal(first.results[0].outcome, 'queued');
  assert.equal(first.results[0].code, 'pages_failed');
  const c = await rig({ pages: 'crash' });
  for (let i = 0; i < DEFAULT_RENDER_SETTINGS.maxAttempts; i++) await runRenderQueue(c.deps);
  // The report itself was paid for once: the retries reused the kept result.
  assert.equal(c.runs.length, 1);
  const ex = rows(c).find((x) => kindOf(x) === 'example_report')!;
  assert.equal(ex.state, 'failed');
  assert.equal(ex.errorCode, 'pages_failed');
  assert.ok(rows(c).some((x) => kindOf(x) === 'notice'));
});

// ── The pure parts ──

test('the example input and the made-safe result: no real address, title or email survives', () => {
  const input = exampleInputFor({ areaKey: 'LE1', areaLabel: 'Leicester', bedrooms: 3 })!;
  assert.equal(input.property.address, exampleAddress('Leicester'));
  assert.equal(input.property.postcode, 'LE1 5DR');
  assert.equal(input.property.bedrooms, 3);
  assert.equal(input.enhancedRequested, false);
  assert.equal(exampleInputFor({ areaKey: 'ZZ9', areaLabel: 'Nowhere', bedrooms: 2 }), null);
  assert.equal(postcodeAreaOf('ng7'), 'NG');
  const real = sampleAnalysis();
  const safe = exampleResultFor(real, 'Leicester');
  const all = stringsIn(safe).join(' | ');
  assert.ok(!/Princess Road|Regent Street/.test(all), 'no real street');
  for (const c of real.shortLet.comparables) if (c.title) assert.ok(!all.includes(c.title), `title kept: ${c.title}`);
  assert.equal(safe.property.address, 'Example property, Leicester');
  assert.ok(safe.shortLet.comparables.every((c, i) => c.title === `Nearby listing ${i + 1}` && c.url === ''));
  // The figures are the same.
  assert.equal(safe.shortLet.annualRevenue, real.shortLet.annualRevenue);
  assert.deepEqual(safe.financials, real.financials);
  // A stored row gives only its result, never its own address or email.
  const stripped = strippedFromRow({ raw_response: real, bedrooms: 2 } as never)!;
  assert.ok(stripped && !('lead_email' in stripped));
  assert.equal(strippedFromRow({ raw_response: { nope: true } }), null);
});

test('the mask asks for every £ figure and the stamp, never the occupancy or the section names', () => {
  assert.deepEqual([...EXAMPLE_MASK.pound], ['£']);
  assert.equal(EXAMPLE_MASK.stamp, 'Example report');
  for (const t of EXAMPLE_MASK.targets) for (const h of t.headings) assert.ok(!h.includes('£'));
});
