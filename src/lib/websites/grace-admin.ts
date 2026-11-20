/**
 * Batch 36 (Phase 8): what the admin website console (/admin/websites) reads
 * and does, with every effect injected so it runs under node --test.
 *
 *   loadConsole(source, graceFor)   READ ONLY: one row per site with its
 *                                   derived status, domain, leads, last login,
 *                                   last enquiry, warnings, switch-off and
 *                                   delete dates and open change requests.
 *                                   The switch-off and delete dates come from
 *                                   graceForSite (siteGraceView), never from
 *                                   the stored row, so a login that cancelled a
 *                                   switch-off shows here at once.
 *   planConsoleAction(kind, site)   the dry-run planner: what would change,
 *                                   which emails, what a deletion removes and
 *                                   keeps. Pure. Delete is only ever ok on a
 *                                   switched-off site.
 *   consoleRunner(deps)             dryRun / run for each action. A dry run has
 *                                   no write: it reads, plans and asks the
 *                                   engines' own dry-run flag. Run refuses
 *                                   whatever the plan refuses (so Delete on a
 *                                   site that is not switched off is refused
 *                                   here, not only hidden in the screen).
 *
 * The real wiring (the admin client, graceForSite, the status writer) is in
 * console-actions.ts and realConsoleSource below; the latter loads the admin
 * client only when it is used, so nothing here is server-only at import time.
 *
 * Logs carry ids and codes only: never an address, an email body, a request
 * text or a lead.
 */
import { addDays, ukDayOf, type UkDay } from './grace-rules.ts';
import { DELETION_KEEPS, DELETION_REMOVES } from './grace-run.ts';
import type { GraceSettings } from './grace-settings.ts';
import { planSiteStatus } from './invite-run.ts';

// ── The console's actions ──

export const CONSOLE_KINDS = ['pause', 'resume', 'switch_off', 'switch_on', 'export', 'delete'] as const;
export type ConsoleKind = (typeof CONSOLE_KINDS)[number];

export const isConsoleKind = (v: unknown): v is ConsoleKind => typeof v === 'string' && (CONSOLE_KINDS as readonly string[]).includes(v);

export const CONSOLE_LABEL: Record<ConsoleKind, string> = {
  pause: 'Pause',
  resume: 'Resume',
  switch_off: 'Switch off',
  switch_on: 'Switch back on',
  export: 'Export data',
  delete: 'Delete data',
};

// ── A site as the console shows it ──

export interface ConsoleSite {
  id: string;
  slug: string;
  /** The account owner. Read server-side from the site: never from a form. */
  ownerId: string;
  member: string;
  /** websites.status. */
  status: string;
  /** What the admin sees: live, paused, switched off, deleted, or the setup status. */
  display: string;
  switchedOff: boolean;
  deleted: boolean;
  domain: string | null;
  leads30: number;
  lastLogin: string | null;
  lastEnquiry: string | null;
  warningsSent: number;
  /** The pending switch-off day (once a warning went out), or the day it was switched off. */
  switchOffOn: string | null;
  deleteOn: string | null;
  reason: string | null;
  requestsNew: number;
  requestsOpen: number;
}

// ── The planner ──

export interface ConsolePlan {
  ok: boolean;
  /** What changes, one plain line each; the first line is the reason when not ok. */
  lines: string[];
  /** The emails this would send. */
  emails: string[];
  /** Deletion only: what goes and what stays. */
  removes?: string[];
  keeps?: string[];
  /** pause / resume: the status it moves to. */
  to?: 'paused' | 'live';
}

const no = (line: string): ConsolePlan => ({ ok: false, lines: [line], emails: [] });

export function planConsoleAction(kind: ConsoleKind, site: ConsoleSite, opts: { deleteAfterDays: number; today: UkDay }): ConsolePlan {
  const path = `/s/${site.slug}`;
  switch (kind) {
    case 'pause': {
      if (site.switchedOff || site.deleted) return no(`This site is ${site.display}. It cannot be paused.`);
      const p = planSiteStatus({ slug: site.slug, status: site.status }, 'pause');
      return { ok: p.ok, lines: p.lines, emails: [], to: 'paused' };
    }
    case 'resume': {
      if (site.deleted) return no('This site’s data has been deleted. It cannot be resumed.');
      if (site.switchedOff) return no('This site is switched off, not just paused. Use Switch back on.');
      const p = planSiteStatus({ slug: site.slug, status: site.status }, 'unpause');
      return { ok: p.ok, lines: p.lines, emails: [], to: 'live' };
    }
    case 'switch_off': {
      if (site.deleted) return no('This site’s data has been deleted. It is already off.');
      if (site.switchedOff) return no('This site is already switched off.');
      return {
        ok: true,
        lines: [
          `Status: ${site.status} → paused. ${path} shows the neutral “no longer available” page, with no form.`,
          'The web address stops renewing.',
          `The data is deleted on ${addDays(opts.today, opts.deleteAfterDays)} unless it is switched back on first.`,
          'Leads, reports, held reports, CRM and lead database deliveries carry on: only the status changes.',
        ],
        emails: ['One “switched off” email to the member, through the daily cap (it waits at most a day).'],
      };
    }
    case 'switch_on': {
      if (site.deleted) return no('This site’s data has been deleted. It cannot be switched back on.');
      if (!site.switchedOff) return no(`This site is ${site.display}, not switched off.`);
      return {
        ok: true,
        lines: [
          'Needs a live plan (when the plan gate is on) and no unpaid domain charge (when charging is on); otherwise it is refused and nothing changes.',
          'The site is checked again and every public page fetched; if one fails it goes back to paused.',
          'The web address may renew again, and the switch-off episode is cleared.',
        ],
        emails: [],
      };
    }
    case 'export':
      return { ok: true, lines: ['Returns the site’s settings, pages, versions, change request texts and file addresses as JSON. Nothing is changed or sent.'], emails: [] };
    case 'delete': {
      if (site.deleted) return no('This site’s data has already been deleted.');
      if (!site.switchedOff) return no('Delete is only allowed on a switched-off site.');
      return {
        ok: true,
        lines: ['The settings, pages and checks are emptied (the site row stays as a stub), and the files are removed. This cannot be undone.', 'Export the data first if the member may want it.'],
        emails: [],
        removes: [...DELETION_REMOVES],
        keeps: [...DELETION_KEEPS],
      };
    }
  }
}

// ── The loader (read only) ──

export interface SiteRowRaw {
  id: string;
  userId: string;
  funnelId: string;
  slug: string;
  status: string;
  domain: string | null;
}

export interface GraceRowRaw {
  websiteId: string;
  episodeStartedAt: string;
  cancelledAt: string | null;
}

/** The raw reads behind the console. Every method only reads. */
export interface ConsoleSource {
  sites(ids?: string[]): Promise<SiteRowRaw[]>;
  emails(userIds: string[]): Promise<Map<string, string | null>>;
  /** The newest last_seen_at of each owner and their team members. */
  lastSeen(ownerIds: string[]): Promise<Map<string, string | null>>;
  /** created_at of each lead on these funnels since `sinceIso` (nothing else about the lead). */
  recentLeads(funnelIds: string[], sinceIso: string): Promise<{ funnelId: string; createdAt: string }[]>;
  /** The newest lead's time for each funnel in the list (those with no lead in the window). */
  lastLead(funnelIds: string[]): Promise<Map<string, string | null>>;
  graceRows(websiteIds: string[]): Promise<GraceRowRaw[]>;
  /** website_grace_notices rows with status sent. */
  sentNotices(websiteIds: string[]): Promise<{ websiteId: string; episodeStartedAt: string }[]>;
  domains(websiteIds: string[]): Promise<Map<string, string>>;
  /** Per website: change requests that are new, and still open. */
  requestCounts(): Promise<Map<string, { new: number; open: number }>>;
}

/** The derived view for one site (graceForSite / siteGraceView): never the stored row. */
export interface GraceViewLite {
  pendingSwitchOff: string | null;
  reason: string | null;
  switchedOff: boolean;
  switchedOffAt: Date | null;
  deleteOn: string | null;
  deleted: boolean;
}

export type GraceFor = (websiteId: string) => Promise<GraceViewLite | null>;

const iso = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const newest = (a: string | null, b: string | null): string | null => (a && b ? (a >= b ? a : b) : (a ?? b));

export async function loadConsole(source: ConsoleSource, graceFor: GraceFor, opts: { now?: Date; ids?: string[] } = {}): Promise<ConsoleSite[]> {
  const now = opts.now ?? new Date();
  const sites = await source.sites(opts.ids);
  if (sites.length === 0) return [];
  const ids = sites.map((s) => s.id);
  const funnelIds = sites.map((s) => s.funnelId);
  const ownerIds = sites.map((s) => s.userId);
  const since = new Date(now.getTime() - 30 * 86400000).toISOString();

  const [emails, seen, recent, grace, sent, domains, requests] = await Promise.all([
    source.emails(ownerIds),
    source.lastSeen(ownerIds),
    source.recentLeads(funnelIds, since),
    source.graceRows(ids),
    source.sentNotices(ids),
    source.domains(ids),
    source.requestCounts(),
  ]);

  const leadCount = new Map<string, number>();
  const leadNewest = new Map<string, string>();
  for (const l of recent) {
    leadCount.set(l.funnelId, (leadCount.get(l.funnelId) ?? 0) + 1);
    const cur = leadNewest.get(l.funnelId);
    if (!cur || l.createdAt > cur) leadNewest.set(l.funnelId, l.createdAt);
  }
  const quiet = funnelIds.filter((f) => !leadNewest.has(f));
  const older = quiet.length > 0 ? await source.lastLead(quiet) : new Map<string, string | null>();

  const graceBySite = new Map(grace.map((g) => [g.websiteId, g]));
  const views = new Map<string, GraceViewLite | null>();
  // Only sites with a website_grace row have anything derived to show: the rest are plain.
  await Promise.all(
    grace.map(async (g) => {
      try {
        views.set(g.websiteId, await graceFor(g.websiteId));
      } catch {
        views.set(g.websiteId, null);
      }
    }),
  );

  return sites.map((s): ConsoleSite => {
    const g = graceBySite.get(s.id);
    const view = views.get(s.id) ?? null;
    const deleted = Boolean(view?.deleted);
    const switchedOff = !deleted && s.status === 'paused' && Boolean(view?.switchedOff);
    const warnings = g ? sent.filter((n) => n.websiteId === s.id && Date.parse(n.episodeStartedAt) === Date.parse(g.episodeStartedAt)).length : 0;
    const req = requests.get(s.id) ?? { new: 0, open: 0 };
    const display = deleted ? 'deleted' : switchedOff ? 'switched off' : s.status;
    const switchedDay = view?.switchedOffAt ? ukDayOf(view.switchedOffAt) : null;
    return {
      id: s.id,
      slug: s.slug,
      ownerId: s.userId,
      member: emails.get(s.userId) ?? s.userId,
      status: s.status,
      display,
      switchedOff,
      deleted,
      domain: domains.get(s.id) ?? s.domain,
      leads30: leadCount.get(s.funnelId) ?? 0,
      lastLogin: iso(seen.get(s.userId)),
      lastEnquiry: newest(leadNewest.get(s.funnelId) ?? null, older.get(s.funnelId) ?? null),
      warningsSent: warnings,
      switchOffOn: switchedOff || deleted ? switchedDay : (view?.pendingSwitchOff ?? null),
      deleteOn: view?.deleteOn ?? null,
      reason: view?.reason ?? null,
      requestsNew: req.new,
      requestsOpen: req.open,
    };
  });
}

// ── The runner (dry run, then run) ──

export interface ConsoleDeps {
  /** One site by id (the console's read), or null. */
  loadSite(websiteId: string): Promise<ConsoleSite | null>;
  settings(): Promise<GraceSettings>;
  today(): UkDay;
  /** pause / resume: setStatus on the site's own owner, conditional on the status read. */
  setStatus(ownerId: string, to: 'paused' | 'live'): Promise<{ ok: boolean; conflict?: boolean }>;
  switchOff(websiteId: string, opts: { dryRun: boolean }): Promise<{ ok: boolean; reason?: string }>;
  switchOn(ownerId: string): Promise<{ ok: boolean; messages?: string[] }>;
  deleteData(websiteId: string, opts: { dryRun: boolean }): Promise<{ ok: boolean; reason?: string }>;
  exportData(websiteId: string): Promise<unknown | null>;
  /** One console audit line: the caller already put the admin's id in it. */
  audit(line: string): void;
}

export interface ConsoleResult {
  ok: boolean;
  message: string;
  lines: string[];
  emails: string[];
  removes?: string[];
  keeps?: string[];
  /** The Run button may be offered (the dry run passed). */
  canRun: boolean;
  /** export: the JSON text. */
  data?: string;
}

const failed = (message: string, lines: string[] = []): ConsoleResult => ({ ok: false, message, lines, emails: [], canRun: false });

export function consoleRunner(deps: ConsoleDeps) {
  async function plan(kind: ConsoleKind, websiteId: string): Promise<{ site: ConsoleSite; plan: ConsolePlan } | ConsoleResult> {
    const id = String(websiteId ?? '');
    const site = await deps.loadSite(id);
    if (!site) return failed('No such website.');
    const settings = await deps.settings();
    return { site, plan: planConsoleAction(kind, site, { deleteAfterDays: settings.deleteAfterDays, today: deps.today() }) };
  }

  /** READS only. Writes nothing, sends nothing: the engines are asked with their dry-run flag. */
  async function dryRun(kind: ConsoleKind, websiteId: string): Promise<ConsoleResult> {
    const p = await plan(kind, websiteId);
    if (!('plan' in p)) return p;
    const { site } = p;
    if (!p.plan.ok) return failed(`Dry run: ${p.plan.lines[0]}`, p.plan.lines);
    if (kind === 'switch_off') {
      const r = await deps.switchOff(site.id, { dryRun: true });
      if (!r.ok) return failed(`Dry run: it cannot be switched off (${r.reason ?? 'unavailable'}).`);
    }
    if (kind === 'delete') {
      const r = await deps.deleteData(site.id, { dryRun: true });
      if (!r.ok) return failed(`Dry run: it cannot be deleted (${r.reason ?? 'unavailable'}).`);
    }
    return { ok: true, canRun: true, message: `Dry run: ${CONSOLE_LABEL[kind]} /s/${site.slug}. Nothing was changed.`, lines: p.plan.lines, emails: p.plan.emails, removes: p.plan.removes, keeps: p.plan.keeps };
  }

  /** Refuses whatever the plan refuses: Delete on a site that is not switched off never runs. */
  async function run(kind: ConsoleKind, websiteId: string): Promise<ConsoleResult> {
    const p = await plan(kind, websiteId);
    if (!('plan' in p)) return p;
    const { site } = p;
    if (!p.plan.ok) return failed(p.plan.lines[0], p.plan.lines);
    const tag = site.id.slice(0, 8);
    const done = (message: string, extra: Partial<ConsoleResult> = {}): ConsoleResult => {
      deps.audit(`${kind} ${tag}: ok`);
      return { ok: true, canRun: false, message, lines: p.plan.lines, emails: p.plan.emails, ...extra };
    };
    const refused = (code: string, message: string): ConsoleResult => {
      deps.audit(`${kind} ${tag}: refused ${code}`);
      return failed(message);
    };

    if (kind === 'pause' || kind === 'resume') {
      const to = p.plan.to as 'paused' | 'live';
      const r = await deps.setStatus(site.ownerId, to);
      if (!r.ok) return refused(r.conflict ? 'conflict' : 'unavailable', r.conflict ? 'The site changed while you were looking. Reload and try again.' : 'The status could not be changed. Nothing was changed.');
      return done(`/s/${site.slug} is now ${to}.`);
    }
    if (kind === 'switch_off') {
      const r = await deps.switchOff(site.id, { dryRun: false });
      return r.ok ? done(`/s/${site.slug} is switched off.`) : refused(r.reason ?? 'unavailable', `It could not be switched off (${r.reason ?? 'unavailable'}).`);
    }
    if (kind === 'switch_on') {
      // The owner is the one read from the site above, never an id from the form.
      const r = await deps.switchOn(site.ownerId);
      return r.ok ? done(`/s/${site.slug} is live again.`) : refused('refused', r.messages?.[0] ?? 'It could not be switched back on.');
    }
    if (kind === 'export') {
      const data = await deps.exportData(site.id);
      if (data === null) return refused('unavailable', 'The data could not be read.');
      return done(`Exported /s/${site.slug}.`, { data: JSON.stringify(data, null, 2) });
    }
    const r = await deps.deleteData(site.id, { dryRun: false });
    return r.ok ? done(`The data for /s/${site.slug} is deleted.`, { removes: p.plan.removes, keeps: p.plan.keeps }) : refused(r.reason ?? 'unavailable', `It could not be deleted (${r.reason ?? 'unavailable'}).`);
  }

  return { dryRun, run };
}

// ── The real reads ──

type Row = Record<string, unknown>;

/** The console's reads over the admin client. Read only; the client is loaded when first used. */
export function realConsoleSource(): ConsoleSource {
  const client = async () => (await import('../supabase/admin')).createAdminClient();
  const unwrap = <T,>(r: { data: T | null; error: { message: string } | null }): T => {
    if (r.error) throw new Error(r.error.message);
    return (r.data ?? ([] as unknown)) as T;
  };
  return {
    async sites(ids) {
      const admin = await client();
      let q = admin.from('websites').select('id, user_id, funnel_id, slug, status, domain').order('created_at', { ascending: false }).limit(500);
      if (ids) q = q.in('id', ids);
      return unwrap<Row[]>(await q).map((r) => ({ id: String(r.id), userId: String(r.user_id), funnelId: String(r.funnel_id), slug: String(r.slug), status: String(r.status), domain: iso(r.domain) }));
    },
    async emails(userIds) {
      const admin = await client();
      const rows = unwrap<Row[]>(await admin.from('profiles').select('id, email').in('id', userIds));
      return new Map(rows.map((r) => [String(r.id), iso(r.email)]));
    },
    async lastSeen(ownerIds) {
      const admin = await client();
      const team = unwrap<Row[]>(await admin.from('team_members').select('member_id, owner_id').in('owner_id', ownerIds));
      const everyone = [...new Set([...ownerIds, ...team.map((t) => String(t.member_id))])];
      const profiles = unwrap<Row[]>(await admin.from('profiles').select('id, last_seen_at').in('id', everyone));
      const at = new Map(profiles.map((p) => [String(p.id), iso(p.last_seen_at)]));
      const out = new Map<string, string | null>();
      for (const o of ownerIds) out.set(o, at.get(o) ?? null);
      for (const t of team) out.set(String(t.owner_id), newest(out.get(String(t.owner_id)) ?? null, at.get(String(t.member_id)) ?? null));
      return out;
    },
    async recentLeads(funnelIds, sinceIso) {
      const admin = await client();
      // Only the funnel id and the time come back: no name, email, phone or address.
      const rows = unwrap<Row[]>(await admin.from('leads').select('funnel_id, created_at').in('funnel_id', funnelIds).gte('created_at', sinceIso).limit(50000));
      return rows.map((r) => ({ funnelId: String(r.funnel_id), createdAt: String(r.created_at) }));
    },
    async lastLead(funnelIds) {
      const admin = await client();
      const out = new Map<string, string | null>();
      await Promise.all(
        funnelIds.slice(0, 200).map(async (f) => {
          const rows = unwrap<Row[]>(await admin.from('leads').select('created_at').eq('funnel_id', f).order('created_at', { ascending: false }).limit(1));
          out.set(f, rows[0] ? iso(rows[0].created_at) : null);
        }),
      );
      return out;
    },
    async graceRows(websiteIds) {
      const admin = await client();
      const rows = unwrap<Row[]>(await admin.from('website_grace').select('website_id, episode_started_at, cancelled_at').in('website_id', websiteIds));
      return rows.map((r) => ({ websiteId: String(r.website_id), episodeStartedAt: String(r.episode_started_at), cancelledAt: iso(r.cancelled_at) }));
    },
    async sentNotices(websiteIds) {
      const admin = await client();
      const rows = unwrap<Row[]>(await admin.from('website_grace_notices').select('website_id, episode_started_at').eq('status', 'sent').in('website_id', websiteIds));
      return rows.map((r) => ({ websiteId: String(r.website_id), episodeStartedAt: String(r.episode_started_at) }));
    },
    async domains(websiteIds) {
      const admin = await client();
      const rows = unwrap<Row[]>(await admin.from('website_domains').select('website_id, name').neq('status', 'released').in('website_id', websiteIds));
      return new Map(rows.map((r) => [String(r.website_id), String(r.name)]));
    },
    async requestCounts() {
      const { liveRequestsEngine } = await import('./edit-requests-store');
      return liveRequestsEngine().openCounts();
    },
  };
}
