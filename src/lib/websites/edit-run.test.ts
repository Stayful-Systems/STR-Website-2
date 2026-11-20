import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEBSITE_VERSIONS_KEPT } from './edit-rules.ts';
import {
  createEditRun,
  pendingKeys,
  type Allowance,
  type CopyOutcome,
  type EditDeps,
  type EditDraft,
  type EditSite,
  type PublishRpc,
  type VersionRow,
} from './edit-run.ts';
import type { SiteCopy, SiteSettings } from './page-model.ts';
import { SAMPLE_COPY, SAMPLE_SETTINGS } from './sample-site.ts';

const OLD_LOGO = 'https://files.test/old-logo.png';
const NEW_LOGO = 'https://files.test/new-logo.png';

const html = (form: boolean) => `<html><body><h1>Welcome</h1>${form ? '<form><input name="email"><input type="checkbox"></form>' : ''}</body></html>`;

/** An in-memory site, its draft, versions, allowance and files, behind the run's injected deps. */
class World {
  site: EditSite = { id: 'site-1', slug: 'northern-lets', domain: null, status: 'live', settings: { ...SAMPLE_SETTINGS, logoUrl: OLD_LOGO }, pages: SAMPLE_COPY, switchedOff: false };
  draft: EditDraft | null = null;
  versions: VersionRow[] = [];
  allowance: Allowance = { month: null, used: 0 };
  files = new Set<string>([OLD_LOGO]);
  deleted: string[] = [];
  copyCalls: { pages: string[]; areas: string[] }[] = [];
  copyFails = false;
  activity: { kind: string; dedupeKey: string; extras: Record<string, unknown> }[] = [];
  fetched: string[] = [];
  failPath: string | null = null;
  now = new Date('2026-11-20T10:00:00Z');
  nextVersion = 0;
  uploads = 0;

  deps(): EditDeps {
    return {
      site: async () => ({ ...this.site }),
      now: () => this.now,
      readDraft: async () => (this.draft ? structuredClone(this.draft) : null),
      writeDraft: async (d) => {
        this.draft = structuredClone(d);
        return true;
      },
      deleteDraft: async () => {
        this.draft = null;
        return true;
      },
      snapshot: async () => {
        if (this.versions.length === 0) this.versions.push(this.row(1, this.site.settings, this.site.pages, 'approved', null));
        return Math.max(...this.versions.map((v) => v.versionNo));
      },
      listVersions: async () => [...this.versions].sort((a, b) => b.versionNo - a.versionNo).map((v) => structuredClone(v)),
      publish: async (a): Promise<PublishRpc> => {
        const max = this.versions.length ? Math.max(...this.versions.map((v) => v.versionNo)) : null;
        if (a.base !== max) return { result: 'stale' };
        const no = (max ?? 0) + 1;
        const row = this.row(no, a.settings, a.pages, a.kind, a.restoredFrom);
        this.versions.push(row);
        this.site = { ...this.site, settings: a.settings, pages: a.pages };
        this.draft = null;
        const pruned = this.versions.sort((x, y) => y.versionNo - x.versionNo).splice(WEBSITE_VERSIONS_KEPT).map((v) => v.id);
        return { result: 'published', versionNo: no, versionId: row.id, pruned };
      },
      revert: async (a) => {
        this.site = { ...this.site, settings: a.previous.settings, pages: a.previous.pages };
        this.versions = this.versions.filter((v) => v.versionNo !== a.versionNo);
        this.draft = a.draft ? structuredClone(a.draft) : null;
        return true;
      },
      readAllowance: async () => ({ ...this.allowance }),
      takeAllowance: async (from, to) => {
        if (this.allowance.month !== from.month || this.allowance.used !== from.used) return false;
        this.allowance = { ...to };
        return true;
      },
      giveBackAllowance: async (taken, to) => {
        if (this.allowance.month === taken.month && this.allowance.used === taken.used) this.allowance = { ...to };
      },
      writeCopy: async ({ only }): Promise<CopyOutcome> => {
        this.copyCalls.push({ pages: only.pages, areas: only.areas });
        if (this.copyFails) return { ok: false, message: 'The copy could not be written. Please try again.' };
        const copy: SiteCopy = structuredClone(only.base);
        if (only.pages.includes('about')) copy.about = { headline: 'About us', body: 'We are a small local team.' };
        if (only.pages.includes('home')) copy.home = { ...copy.home, intro: 'We manage short lets for owners.' };
        for (const name of only.areas) {
          const i = copy.areas.findIndex((a) => a.area.toLowerCase() === name.toLowerCase());
          if (i >= 0) copy.areas[i] = { ...copy.areas[i], headline: `Short-let management in ${copy.areas[i].area}`, body: `${copy.areas[i].area} has steady demand from visitors.` };
        }
        return { ok: true, copy };
      },
      uploadImage: async () => {
        this.uploads++;
        const url = this.uploads === 1 ? NEW_LOGO : `https://files.test/logo-${this.uploads}.png`;
        this.files.add(url);
        return { ok: true, url };
      },
      deleteFile: async (url) => {
        this.deleted.push(url);
        this.files.delete(url);
      },
      fetchPage: async (url) => {
        this.fetched.push(url);
        const path = url.replace('https://app.example.test/s/northern-lets', '').replace(/^\//, '');
        if (this.failPath !== null && path === this.failPath) return { status: 404, text: async () => '' };
        return { status: 200, text: async () => html(path !== 'privacy') };
      },
      baseUrl: 'https://app.example.test',
      record: async (kind, opts) => {
        this.activity.push({ kind, dedupeKey: opts.dedupeKey, extras: opts.extras });
      },
    };
  }

  row(no: number, settings: SiteSettings, pages: SiteCopy | null, kind: VersionRow['kind'], restoredFrom: number | null): VersionRow {
    return { id: `ver-${++this.nextVersion}`, versionNo: no, settings: structuredClone(settings), pages: pages ? structuredClone(pages) : null, kind, restoredFrom, publishedAt: this.now.toISOString() };
  }
  run() {
    return createEditRun(this.deps());
  }
  /** One full edit: a fee change, published. */
  async publishFee(run: ReturnType<World['run']>, fee: number) {
    const s = await run.saveDraftFields({ managementFeePct: fee });
    assert.equal(s.ok, true);
    const p = await run.publish();
    assert.equal(p.ok, true, JSON.stringify(p));
  }
}

test('opening a draft snapshots the approved site as version 1, once, and copies live into the draft', async () => {
  const w = new World();
  const run = w.run();
  const a = await run.openDraft();
  assert.ok(a.ok);
  assert.equal(w.versions.length, 1);
  assert.equal(w.versions[0].kind, 'approved');
  assert.equal(w.versions[0].versionNo, 1);
  assert.equal(a.ok && a.draft.baseVersion, 1);
  assert.deepEqual(w.draft?.settings, w.site.settings);
  await run.openDraft();
  assert.equal(w.versions.length, 1, 'a second open does not snapshot again');
});

test('a fee-only edit calls the copy writer 0 times, rewrites nothing, and publishes as version 2', async () => {
  const w = new World();
  const run = w.run();
  const s = await run.saveDraftFields({ managementFeePct: 12 });
  assert.ok(s.ok);
  assert.deepEqual(s.ok && s.plan, { rewrite: [], drop: [] });
  assert.deepEqual(w.draft?.pendingPages, []);
  assert.equal(w.site.settings.managementFeePct, 15, 'the live site has not moved: the edit is in the draft');
  const p = await run.publish();
  assert.ok(p.ok);
  assert.equal(p.ok && p.versionNo, 2);
  assert.equal(w.copyCalls.length, 0);
  assert.equal(w.site.settings.managementFeePct, 12);
  assert.equal(w.draft, null);
  // Every public page was fetched before it counted as published.
  assert.ok(w.fetched.length >= 6);
  assert.ok(w.fetched.every((u) => u.startsWith('https://app.example.test/s/northern-lets')));
});

test('an edit never reaches the live site until Publish', async () => {
  const w = new World();
  const run = w.run();
  await run.saveDraftFields({ contactPhone: '0113 496 0999', companyName: 'Harbour Lets' });
  assert.equal(w.site.settings.contactPhone, SAMPLE_SETTINGS.contactPhone);
  assert.equal(w.site.settings.companyName, SAMPLE_SETTINGS.companyName);
  assert.equal(w.versions.length, 1);
});

test('a patch can only change the setup fields: never a logo, photo or anything else', async () => {
  const w = new World();
  const run = w.run();
  const patch = { logoUrl: 'https://evil.test/x.png', photoUrl: 'https://evil.test/y.png', status: 'paused', id: 'other', managementFeePct: 11 } as never;
  await run.saveDraftFields(patch);
  assert.equal(w.draft?.settings.logoUrl, OLD_LOGO);
  assert.equal(w.draft?.settings.photoUrl, null);
  assert.equal(w.draft?.settings.managementFeePct, 11);
  assert.equal((w.draft as unknown as Record<string, unknown>).status, undefined);
});

test('an edit re-runs the checks: placeholder text blocks Publish and nothing changes', async () => {
  const w = new World();
  const run = w.run();
  await run.openDraft();
  const bad: SiteCopy = { ...SAMPLE_COPY, fees: { ...SAMPLE_COPY.fees, headline: 'Our {{fee}} fee' } };
  const e = await run.editPage(bad);
  assert.ok(e.ok);
  assert.ok(e.ok && e.problems.length > 0, 'the problem is shown as soon as it is typed');
  assert.ok(e.ok && e.problems.some((p) => p.rule === 'placeholder' || /\{\{/.test(p.message) || p.rule === 'required' || p.field.includes('heading')));
  const p = await run.publish();
  assert.equal(p.ok, false);
  assert.equal(!p.ok && p.reason, 'checks');
  assert.ok(!p.ok && (p.problems?.length ?? 0) > 0);
  assert.equal(w.versions.length, 1, 'no version was made');
  assert.equal(w.site.pages?.fees.headline, SAMPLE_COPY.fees.headline, 'the live copy is untouched');
  assert.equal(w.fetched.length, 0, 'the status never moved, so no page was fetched');
});

test('an added area blocks Publish until its page is written, then until it is approved', async () => {
  const w = new World();
  const run = w.run();
  const s = await run.saveDraftFields({ areas: ['Leeds', 'Harrogate', 'York'] });
  assert.ok(s.ok);
  assert.deepEqual(pendingKeys(w.draft!.pendingPages), { toWrite: ['area:york'], toApprove: [] });
  assert.equal(w.draft?.pages.areas.find((a) => a.area === 'York')?.headline, '', 'the new block starts empty');
  assert.ok(s.ok && s.problems.length > 0, 'the checks already ask for it');

  const early = await run.publish();
  assert.equal(!early.ok && early.reason, 'pending');
  const notYet = await run.approvePage('area:york');
  assert.equal(!notYet.ok && notYet.reason, 'not_written');

  const r = await run.rewritePending();
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(w.copyCalls, [{ pages: ['area'], areas: ['york'] }], 'only the new area page is written');
  assert.deepEqual(pendingKeys(w.draft!.pendingPages), { toWrite: [], toApprove: ['area:york'] });
  assert.ok(r.ok && r.problems.length === 0);
  const still = await run.publish();
  assert.equal(!still.ok && still.reason, 'pending', 'written is not approved');

  assert.ok((await run.approvePage('area:york')).ok);
  const done = await run.publish();
  assert.ok(done.ok, JSON.stringify(done));
  assert.ok(w.site.pages?.areas.some((a) => a.area === 'York' && a.headline));
  assert.ok(w.fetched.some((u) => u.endsWith('/areas/york')), 'the new page was fetched');
});

test('the operator can write a rewritten page themselves: editing a pending page sends it to approval without a rewrite', async () => {
  const w = new World();
  const run = w.run();
  await run.saveDraftFields({ areas: ['Leeds', 'Harrogate', 'York'] });
  const mine: SiteCopy = { ...w.draft!.pages, areas: w.draft!.pages.areas.map((a) => (a.area === 'York' ? { area: 'York', headline: 'Lettings help in York', body: 'We know York well.' } : a)) };
  const e = await run.editPage(mine);
  assert.ok(e.ok);
  assert.deepEqual(pendingKeys(w.draft!.pendingPages), { toWrite: [], toApprove: ['area:york'] });
  assert.equal(w.copyCalls.length, 0);
  assert.equal(w.allowance.used, 0, 'no rewrite was spent');
  assert.ok((await run.approvePage('area:york')).ok);
  assert.ok((await run.publish()).ok);
});

test('a removed area drops its page and nothing is pending', async () => {
  const w = new World();
  const run = w.run();
  const s = await run.saveDraftFields({ areas: ['Harrogate'] });
  assert.ok(s.ok);
  assert.deepEqual(s.ok && s.plan.drop, ['Leeds']);
  assert.deepEqual(w.draft?.pendingPages, []);
  assert.deepEqual(w.draft?.pages.areas.map((a) => a.area), ['Harrogate']);
  assert.ok((await run.publish()).ok);
  assert.deepEqual(w.site.pages?.areas.map((a) => a.area), ['Harrogate']);
});

test('a changed company name rewrites only the pages that name the old one', async () => {
  const w = new World();
  const run = w.run();
  await run.saveDraftFields({ companyName: 'Harbour Lets' });
  assert.deepEqual(pendingKeys(w.draft!.pendingPages), { toWrite: ['about'], toApprove: [] });
  await run.rewritePending();
  assert.deepEqual(w.copyCalls, [{ pages: ['about'], areas: [] }]);
  await run.approvePage('about');
  assert.ok((await run.publish()).ok);
  assert.equal(w.site.settings.companyName, 'Harbour Lets');
});

test('publish with pages still pending is refused, and nothing changes', async () => {
  const w = new World();
  const run = w.run();
  await run.saveDraftFields({ aboutText: 'We started in 2015.' });
  const p = await run.publish();
  assert.equal(!p.ok && p.reason, 'pending');
  assert.equal(w.versions.length, 1);
  assert.equal(w.fetched.length, 0);
});

test('a stale base is refused: someone published since the draft was opened', async () => {
  const w = new World();
  const run = w.run();
  await run.saveDraftFields({ managementFeePct: 12 });
  // Another session publishes version 2 first.
  w.versions.push(w.row(2, { ...w.site.settings, managementFeePct: 10 }, w.site.pages, 'publish', null));
  w.site = { ...w.site, settings: { ...w.site.settings, managementFeePct: 10 } };
  const p = await run.publish();
  assert.equal(p.ok, false);
  assert.equal(!p.ok && p.reason, 'stale');
  assert.match(!p.ok ? p.message : '', /reload/i);
  assert.equal(w.site.settings.managementFeePct, 10, 'the other publish stands');
  assert.equal(w.versions.length, 2);
  assert.equal(w.activity.length, 0);
});

test('a failed page fetch puts the previous version back and keeps the draft', async () => {
  const w = new World();
  const run = w.run();
  await run.saveDraftFields({ managementFeePct: 12, contactPhone: '0113 496 0999' });
  const before = structuredClone(w.draft);
  const live = structuredClone(w.site);
  w.failPath = 'fees';
  const p = await run.publish();
  assert.equal(p.ok, false);
  assert.equal(!p.ok && p.reason, 'pages');
  assert.equal(!p.ok && p.rolledBack, true);
  assert.deepEqual(w.site.settings, live.settings, 'the live site is the previous version again');
  assert.deepEqual(w.site.pages, live.pages);
  assert.equal(w.versions.length, 1, 'the failed version is gone');
  assert.deepEqual(w.draft, before, 'the operator keeps their draft');
  assert.equal(w.activity.length, 0, 'nothing is recorded for a publish that did not stand');
  assert.deepEqual(w.deleted, []);
  // Fix and publish again: it takes version 2.
  w.failPath = null;
  const again = await run.publish();
  assert.ok(again.ok);
  assert.equal(again.ok && again.versionNo, 2);
});

test('restore makes version n+1 from an old version, through the same checks, and records one event', async () => {
  const w = new World();
  const run = w.run();
  await w.publishFee(run, 12);
  await w.publishFee(run, 9);
  assert.equal(w.versions.length, 3);
  const r = await run.restore(2);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.ok && r.versionNo, 4);
  assert.equal(w.site.settings.managementFeePct, 12);
  const v4 = w.versions.find((v) => v.versionNo === 4)!;
  assert.equal(v4.kind, 'restore');
  assert.equal(v4.restoredFrom, 2);
  assert.equal(w.versions.length, 4, 'history is kept: a restore adds a version');
  assert.equal(w.activity.at(-1)?.kind, 'funnel_edited');
  assert.equal(w.activity.at(-1)?.dedupeKey, `website_version:${v4.id}`);
  assert.deepEqual(w.activity.at(-1)?.extras, { website: true, version: 4 });
  // A restore that fails the page fetch puts the live site back and adds nothing.
  w.failPath = 'about';
  const live = structuredClone(w.site);
  const bad = await run.restore(1);
  assert.equal(!bad.ok && bad.reason, 'pages');
  assert.deepEqual(w.site.settings, live.settings);
  assert.equal(w.versions.length, 4);
});

test('restore looks the version up among this site\'s versions only, and only by a whole number', async () => {
  const w = new World();
  const run = w.run();
  await w.publishFee(run, 12);
  for (const bad of [99, 0, -1, 1.5, Number.NaN]) {
    const r = await run.restore(bad);
    assert.equal(r.ok, false, String(bad));
  }
  assert.equal(w.versions.length, 2);
  assert.equal((await run.restore(99)).ok, false);
  assert.equal(!(await run.restore(99)).ok && (await run.restore(99) as { reason: string }).reason, 'not_found');
});

test('each publish records funnel_edited once, with a per-version key and website:true', async () => {
  const w = new World();
  const run = w.run();
  await w.publishFee(run, 12);
  await w.publishFee(run, 13);
  assert.equal(w.activity.length, 2);
  assert.ok(w.activity.every((a) => a.kind === 'funnel_edited' && a.extras.website === true));
  assert.equal(new Set(w.activity.map((a) => a.dedupeKey)).size, 2);
});

test('the old logo file is not deleted on replace, and is deleted only once pruned out of all 10 versions', async () => {
  const w = new World();
  const run = w.run();
  const up = await run.uploadDraftImage('logo', new Uint8Array([1, 2, 3]));
  assert.ok(up.ok, JSON.stringify(up));
  assert.equal(w.draft?.settings.logoUrl, NEW_LOGO);
  assert.deepEqual(w.deleted, [], 'replacing in the draft deletes nothing: the live site still shows the old logo');
  assert.ok((await run.publish()).ok);
  assert.equal(w.site.settings.logoUrl, NEW_LOGO);
  assert.deepEqual(w.deleted, [], 'version 1 still shows the old logo, so a restore would still find it');
  assert.ok(w.files.has(OLD_LOGO));
  // Versions 3..10: the old logo is still in version 1.
  for (let fee = 20; fee < 28; fee++) await w.publishFee(run, fee);
  assert.equal(w.versions.length, 10);
  assert.ok(w.versions.some((v) => v.versionNo === 1));
  assert.deepEqual(w.deleted, []);
  // The next publish prunes version 1: now nothing refers to the old logo.
  await w.publishFee(run, 30);
  assert.equal(w.versions.length, 10);
  assert.ok(!w.versions.some((v) => v.versionNo === 1));
  assert.deepEqual(w.deleted, [OLD_LOGO]);
  assert.ok(w.files.has(NEW_LOGO), 'the logo still in use stays');
});

test('a file uploaded into a draft and replaced again, or discarded, is deleted (nothing refers to it)', async () => {
  const w = new World();
  const run = w.run();
  await run.uploadDraftImage('logo', new Uint8Array([1])); // NEW_LOGO, draft only
  await run.uploadDraftImage('logo', new Uint8Array([2])); // logo-2: the first is now unreferenced
  assert.deepEqual(w.deleted, [NEW_LOGO]);
  const d = await run.discardDraft();
  assert.ok(d.ok);
  assert.equal(w.draft, null);
  assert.deepEqual(w.deleted, [NEW_LOGO, 'https://files.test/logo-2.png']);
  assert.ok(w.files.has(OLD_LOGO), 'the live logo is never touched by a discard');
});

test('the monthly allowance stops the 11th rewrite and resets next month', async () => {
  const w = new World();
  const run = w.run();
  await run.openDraft();
  for (let i = 1; i <= 10; i++) {
    await run.saveDraftFields({ aboutText: `We started in ${2000 + i}.` });
    const r = await run.rewritePending();
    assert.ok(r.ok, `rewrite ${i}: ${JSON.stringify(r)}`);
    assert.equal(r.ok && r.left, 10 - i);
  }
  assert.equal(w.copyCalls.length, 10);
  await run.saveDraftFields({ aboutText: 'One more change.' });
  const eleventh = await run.rewritePending();
  assert.equal(eleventh.ok, false);
  assert.equal(!eleventh.ok && eleventh.reason, 'allowance');
  assert.equal(w.copyCalls.length, 10, 'the writer was not called for the 11th');
  assert.deepEqual(w.allowance, { month: '2026-11', used: 10 });
  // Next month the allowance starts again.
  w.now = new Date('2026-12-01T09:00:00Z');
  const next = await run.rewritePending();
  assert.ok(next.ok);
  assert.deepEqual(w.allowance, { month: '2026-12', used: 1 });
});

test('a failed rewrite gives the allowance back', async () => {
  const w = new World();
  const run = w.run();
  await run.saveDraftFields({ areas: ['Leeds', 'Harrogate', 'York'] });
  w.copyFails = true;
  const r = await run.rewritePending();
  assert.equal(!r.ok && r.reason, 'copy_failed');
  assert.deepEqual(w.allowance, { month: null, used: 0 }, 'given back, exactly as it was');
  assert.deepEqual(pendingKeys(w.draft!.pendingPages), { toWrite: ['area:york'], toApprove: [] }, 'still to write');
  w.copyFails = false;
  assert.ok((await run.rewritePending()).ok);
  assert.equal(w.allowance.used, 1);
});

test('two rewrites at once cannot both take the last allowance', async () => {
  const w = new World();
  w.allowance = { month: '2026-11', used: 9 };
  const run = w.run();
  await run.saveDraftFields({ areas: ['Leeds', 'Harrogate', 'York'] });
  const deps = w.deps();
  // The first read sees 9; before it can take, another edit takes the last one.
  const realRead = deps.readAllowance;
  let first = true;
  deps.readAllowance = async () => {
    const seen = await realRead();
    if (first) {
      first = false;
      w.allowance = { month: '2026-11', used: 10 };
    }
    return seen;
  };
  const racing = createEditRun(deps);
  const r = await racing.rewritePending();
  assert.equal(!r.ok && r.reason, 'allowance', 'the conditional update failed, the re-read saw 10');
  assert.equal(w.copyCalls.length, 0);
});

test('a site that is paused, switched off or not live cannot be edited, and says why', async () => {
  const w = new World();
  w.site = { ...w.site, status: 'paused' };
  const run = w.run();
  const a = await run.saveDraftFields({ managementFeePct: 12 });
  assert.equal(!a.ok && a.reason, 'paused');
  assert.equal(!a.ok && a.message, 'Your website is paused.');
  for (const call of [() => run.openDraft(), () => run.publish(), () => run.restore(1), () => run.rewritePending(), () => run.editPage({}), () => run.approvePage('about'), () => run.uploadDraftImage('logo', new Uint8Array([1])), () => run.discardDraft()]) {
    const r = await call();
    assert.equal(r.ok, false);
  }
  assert.equal(w.versions.length, 0, 'nothing was snapshotted for a paused site');
  assert.equal(w.draft, null);

  w.site = { ...w.site, status: 'paused', switchedOff: true };
  assert.equal(!(await run.openDraft()).ok && (await run.openDraft() as { reason: string }).reason, 'switched_off');
  w.site = { ...w.site, status: 'preview', switchedOff: false };
  assert.equal(!(await run.openDraft()).ok && (await run.openDraft() as { reason: string }).reason, 'not_live');
  w.site = { ...w.site, status: 'live', switchedOff: false };
  assert.ok((await run.openDraft()).ok);
});

test('publish and the rest need an open draft', async () => {
  const w = new World();
  const run = w.run();
  assert.equal(!(await run.publish()).ok && (await run.publish() as { reason: string }).reason, 'no_draft');
  assert.equal(!(await run.rewritePending()).ok && (await run.rewritePending() as { reason: string }).reason, 'no_draft');
  assert.equal((await run.approvePage('nonsense')).ok, false);
});

test('state() describes the site without opening a draft', async () => {
  const w = new World();
  const run = w.run();
  const s = await run.state();
  assert.ok(s.ok);
  assert.equal(s.ok && s.draft, null);
  assert.equal(s.ok && s.left, 10);
  assert.equal(w.versions.length, 0, 'reading the screen takes no snapshot');
  w.site = { ...w.site, status: 'paused' };
  const p = await run.state();
  assert.equal(p.ok && p.editable?.message, 'Your website is paused.');
});
