import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_SHEET_SETTINGS } from './settings.ts';
import type { SheetSettings } from './settings.ts';
import { AD_UNKNOWN_LABEL, NOT_ENOUGH_TITLE, OUTCOME_NOTE_TITLE, buildRankingView, readRanking } from './ranking.ts';
import type { RankAdRef, RankLead, RankLink, RankingStore } from './ranking.ts';

const A = '3f9a2c11-1111-4111-8111-111111111111';
const B = '3f9a2c22-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-21T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const adsA: RankAdRef[] = [
  { id: 'ad-a1', ownerId: A, code: 'SI-AAA-5b-1', angle: '5b' },
  { id: 'ad-a2', ownerId: A, code: 'SI-AAA-3a-1', angle: '3a' },
  { id: 'ad-a3', ownerId: A, code: 'SI-AAA-17-1', angle: '17' },
];
const adsB: RankAdRef[] = [{ id: 'ad-b1', ownerId: B, code: 'SI-BBB-5b-1', angle: '5b' }];

type Spec = { owner?: string; ad?: string | null; stage?: string; meeting?: boolean; age?: number; archived?: boolean; match?: string };

function world() {
  const leads: RankLead[] = [];
  const links: RankLink[] = [];
  let n = 0;
  return {
    leads,
    links,
    add(count: number, spec: Spec = {}) {
      for (let i = 0; i < count; i++) {
        const id = `lead-${++n}`;
        const owner = spec.owner ?? A;
        leads.push({ id, ownerId: owner, stage: spec.stage ?? 'new', meetingReachedAt: spec.meeting ? ago(1) : null, createdAt: ago(spec.age ?? 1), archived: spec.archived ?? false });
        if (spec.ad !== undefined) links.push({ leadId: id, ownerId: owner, packAdId: spec.ad, match: spec.match ?? (spec.ad ? 'code' : 'none'), adCodeSeen: null });
      }
    },
  };
}

function view(w: ReturnType<typeof world>, settings: Partial<SheetSettings> = {}, ads = adsA) {
  return buildRankingView({ ownerId: A, leads: w.leads, links: w.links, ads, settings: { ...DEFAULT_SHEET_SETTINGS, ...settings }, now: NOW });
}

test('an ad below the minimum is not ranked: it is listed under Not enough data yet', () => {
  const w = world();
  w.add(4, { ad: 'ad-a1', stage: 'signed', meeting: true });
  w.add(5, { ad: 'ad-a2' });
  const v = view(w);
  assert.deepEqual(v.ranked.map((r) => r.adId), ['ad-a2']);
  assert.equal(v.ranked[0].rank, 1);
  const low = v.notEnough.find((r) => r.adId === 'ad-a1');
  assert.ok(low);
  assert.equal('rank' in low, false);
  assert.equal(NOT_ENOUGH_TITLE, 'Not enough data yet');
  // An ad with no leads at all is listed there too, never ranked.
  assert.ok(v.notEnough.some((r) => r.adId === 'ad-a3' && r.leads === 0));
  assert.match(v.rankingNote, /5 or more leads/);
});

test('the minimum comes from the settings (not a typed figure)', () => {
  const w = world();
  w.add(2, { ad: 'ad-a1' });
  assert.equal(view(w, { minLeads: 2 }).ranked.length, 1);
  assert.equal(view(w, { minLeads: 3 }).ranked.length, 0);
  assert.match(view(w, { minLeads: 3 }).rankingNote, /3 or more leads/);
});

test('untagged leads count in the totals and never in the ranking', () => {
  const w = world();
  w.add(5, { ad: 'ad-a1', meeting: true });
  w.add(3, { ad: null, match: 'none', stage: 'signed', meeting: true }); // link row, no ad
  w.add(2, { ad: 'ad-zzz', match: 'foreign_code', stage: 'signed' }); // another operator's code
  w.add(4, {}); // no link row at all
  const v = view(w);
  assert.deepEqual(v.totals, { leads: 14, meetings: 8, signed: 5 });
  assert.deepEqual({ leads: v.untagged.leads, meetings: v.untagged.meetings, signed: v.untagged.signed }, { leads: 9, meetings: 3, signed: 5 });
  assert.equal(v.untagged.label, AD_UNKNOWN_LABEL);
  assert.equal(AD_UNKNOWN_LABEL, 'Ad unknown');
  assert.deepEqual(v.ranked.map((r) => r.adId), ['ad-a1']);
  assert.equal(v.ranked[0].leads, 5);
  assert.ok(![...v.ranked, ...v.notEnough].some((r) => r.adId === 'ad-zzz'));
  assert.equal(v.empty, false);
});

test('no tagged leads is a plain empty state', () => {
  const w = world();
  w.add(3, {});
  const v = view(w);
  assert.equal(v.empty, true);
  assert.equal(v.ranked.length, 0);
  assert.equal(view(world()).empty, true);
});

test('ranked by signed, then meetings, then leads', () => {
  const w = world();
  // ad-a1: 0 signed, 5 meetings, 5 leads. ad-a2: 1 signed, 1 meeting, 5 leads. ad-a3: 1 signed, 3 meetings, 6 leads.
  w.add(5, { ad: 'ad-a1', meeting: true });
  w.add(1, { ad: 'ad-a2', stage: 'signed', meeting: true });
  w.add(4, { ad: 'ad-a2' });
  w.add(1, { ad: 'ad-a3', stage: 'signed', meeting: true });
  w.add(2, { ad: 'ad-a3', meeting: true });
  w.add(3, { ad: 'ad-a3' });
  const v = view(w);
  assert.deepEqual(v.ranked.map((r) => [r.rank, r.adId]), [[1, 'ad-a3'], [2, 'ad-a2'], [3, 'ad-a1']]);

  // Same signed and meetings: more leads first.
  const w2 = world();
  w2.add(5, { ad: 'ad-a1' });
  w2.add(7, { ad: 'ad-a2' });
  assert.deepEqual(view(w2).ranked.map((r) => r.adId), ['ad-a2', 'ad-a1']);

  // A full tie falls back to the label: stable whatever the lead order.
  const w3 = world();
  w3.add(5, { ad: 'ad-a2' });
  w3.add(5, { ad: 'ad-a1' });
  // Labels: SI-AAA-3a-1 sorts before SI-AAA-5b-1.
  assert.deepEqual(view(w3).ranked.map((r) => r.adId), ['ad-a2', 'ad-a1']);
});

test('a lead that moved to Lost still counts as a meeting once it reached one, but not as signed', () => {
  const w = world();
  w.add(5, { ad: 'ad-a1', stage: 'lost', meeting: true });
  const r = view(w).ranked[0];
  assert.equal(r.meetings, 5);
  assert.equal(r.signed, 0);
});

test('archived leads are never counted', () => {
  const w = world();
  w.add(5, { ad: 'ad-a1' });
  w.add(5, { ad: 'ad-a1', archived: true, stage: 'signed' });
  const v = view(w);
  assert.equal(v.totals.leads, 5);
  assert.equal(v.ranked[0].leads, 5);
  assert.equal(v.ranked[0].signed, 0);
});

test('an ad this screen no longer lists is labelled by the code the lead carried', () => {
  const w = world();
  w.add(5, { ad: 'ad-old' });
  for (const l of w.links) l.adCodeSeen = 'SI-AAA-5b-0';
  const v = view(w);
  assert.equal(v.ranked[0].label, 'SI-AAA-5b-0');
});

test('ad labels are the pack own code and angle, never a figure', () => {
  const w = world();
  w.add(5, { ad: 'ad-a1' });
  const label = view(w).ranked[0].label;
  assert.match(label, /^SI-AAA-5b-1 · /);
  assert.ok(!/\d+%|£/.test(label));
});

// ── The outcomes note ──
function oldLeads(old: number, pastNew: number, extra: Spec = {}) {
  const w = world();
  w.add(pastNew, { ad: 'ad-a1', stage: 'contacted', age: 30, ...extra });
  w.add(old - pastNew, { ad: 'ad-a1', stage: 'new', age: 30, ...extra });
  return w;
}

test('the note shows under 50% of old leads past New, and not at or over 50%', () => {
  assert.equal(view(oldLeads(10, 4)).outcomeNote?.title, OUTCOME_NOTE_TITLE);
  assert.equal(OUTCOME_NOTE_TITLE, "Outcomes aren't being marked");
  assert.equal(view(oldLeads(10, 5)).outcomeNote, null); // exactly 50%
  assert.equal(view(oldLeads(10, 6)).outcomeNote, null);
  assert.equal(view(oldLeads(3, 1)).outcomeNote?.title, OUTCOME_NOTE_TITLE); // 33%
  assert.equal(view(oldLeads(3, 2)).outcomeNote, null); // 67%
  assert.equal(view(oldLeads(7, 3)).outcomeNote?.title, OUTCOME_NOTE_TITLE); // 3/7 under, 4/7 over
  assert.equal(view(oldLeads(7, 4)).outcomeNote, null);
  const note = view(oldLeads(10, 0)).outcomeNote;
  assert.equal(note?.href, '/leads');
  // The words use the settings, not typed figures.
  assert.match(note!.text, /Fewer than 50% of your leads older than 14 days/);
  assert.match(view(oldLeads(10, 0), { outcomePct: 80, outcomeAgeDays: 20 }).outcomeNote!.text, /Fewer than 80% .* older than 20 days/);
});

test('the note is absent when no lead is older than the age, with exact day boundaries', () => {
  const young = world();
  young.add(6, { ad: 'ad-a1', age: 13 });
  assert.equal(view(young).outcomeNote, null);
  const edge = world();
  edge.add(6, { ad: 'ad-a1', age: 14 }); // exactly 14 days old is not older than 14 days
  assert.equal(view(edge).outcomeNote, null);
  const over = world();
  over.add(6, { ad: 'ad-a1', age: 14.01 });
  assert.equal(view(over).outcomeNote?.title, OUTCOME_NOTE_TITLE);
  assert.equal(view(world()).outcomeNote, null);
});

test('young leads and archived leads are left out of the outcomes check; untagged old leads count', () => {
  const w = oldLeads(10, 5); // exactly 50%: no note
  w.add(20, { ad: 'ad-a1', age: 2 }); // young New leads do not tip it
  w.add(20, { ad: 'ad-a1', age: 40, archived: true }); // archived do not tip it
  assert.equal(view(w).outcomeNote, null);
  const u = world();
  u.add(4, { stage: 'new', age: 30 }); // untagged, old, New
  assert.equal(view(u).outcomeNote?.title, OUTCOME_NOTE_TITLE);
});

// ── Two owners ──
function twoOwners() {
  const w = world();
  w.add(6, { owner: A, ad: 'ad-a1', stage: 'signed', meeting: true });
  w.add(9, { owner: B, ad: 'ad-b1', stage: 'signed', meeting: true });
  w.add(3, { owner: B });
  // A link row carrying B's id against A's ad id (corrupt data) must not make B's lead appear for A.
  w.links.push({ leadId: 'lead-7', ownerId: A, packAdId: 'ad-a1', match: 'code', adCodeSeen: null });
  return w;
}

test('an operator never sees another operator\'s leads or ads (store that scopes by owner)', async () => {
  const w = twoOwners();
  const asked: string[] = [];
  const store: RankingStore = {
    async leads(ownerId) { asked.push(ownerId); return w.leads.filter((l) => l.ownerId === ownerId); },
    async links(ownerId) { return w.links.filter((k) => k.ownerId === ownerId); },
    async settings() { return DEFAULT_SHEET_SETTINGS; },
  };
  const a = await readRanking(store, A, [...adsA, ...adsB], NOW);
  assert.deepEqual(asked, [A]);
  assert.deepEqual(a.totals, { leads: 6, meetings: 6, signed: 6 });
  assert.deepEqual(a.ranked.map((r) => r.adId), ['ad-a1']);
  assert.ok(![...a.ranked, ...a.notEnough].some((r) => r.adId === 'ad-b1'));
  const b = await readRanking(store, B, [...adsA, ...adsB], NOW);
  assert.deepEqual(b.totals, { leads: 12, meetings: 9, signed: 9 });
  assert.deepEqual(b.ranked.map((r) => r.adId), ['ad-b1']);
  assert.ok(![...b.ranked, ...b.notEnough].some((r) => r.adId.startsWith('ad-a')));
});

test('even a store that returns everyone\'s rows cannot show another operator\'s data', async () => {
  const w = twoOwners();
  const leaky: RankingStore = {
    async leads() { return w.leads; },
    async links() { return w.links; },
    async settings() { return DEFAULT_SHEET_SETTINGS; },
  };
  const a = await readRanking(leaky, A, [...adsA, ...adsB], NOW);
  assert.deepEqual(a.totals, { leads: 6, meetings: 6, signed: 6 });
  assert.deepEqual([...a.ranked, ...a.notEnough].map((r) => r.adId).sort(), ['ad-a1', 'ad-a2', 'ad-a3']);
  assert.equal(a.untagged.leads, 0);
});

test('ranking-server: owner scoped, reads only leads and ad_pack_lead_links (plus the settings), writes nothing, logs no lead', () => {
  const src = readFileSync('src/lib/ad-sheets/ranking-server.ts', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(src, /^import 'server-only';/);
  const tables = [...code.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(tables)], ['ad_pack_lead_links', 'billing_settings', 'leads']);
  assert.match(code, /\.from\('leads'\)[\s\S]*?\.eq\('user_id', ownerId\)[\s\S]*?\.is\('archived_at', null\)/);
  assert.match(code, /\.from\('ad_pack_lead_links'\)[\s\S]*?\.eq\('owner_id', ownerId\)/);
  assert.ok(!/\.(insert|update|upsert|delete)\(/.test(code));
  assert.ok(!/console\.\w+\([^)]*(email|address|name|phone|body)/i.test(code));
  // The engine stays free of server-only and of the database.
  const engine = readFileSync('src/lib/ad-sheets/ranking.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/server-only|supabase/.test(engine));
});

test('Your ads shows no spend, cost per lead or benchmark', () => {
  const ui = readFileSync('src/app/leads/ads/YourAds.tsx', 'utf8').toLowerCase();
  const eng = readFileSync('src/lib/ad-sheets/ranking.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').toLowerCase();
  for (const word of ['cost per', 'cpl', 'spend', 'benchmark', 'stayful']) {
    assert.ok(!ui.replace(/\/\*[\s\S]*?\*\//g, '').includes(word), `ui: ${word}`);
    assert.ok(!eng.includes(word), `engine: ${word}`);
  }
  assert.match(readFileSync('src/app/leads/ads/YourAds.tsx', 'utf8'), /logActivity\(ownerId, "ad_ranking_viewed"/);
});
