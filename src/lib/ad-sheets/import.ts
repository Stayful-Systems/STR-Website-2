/**
 * Batch 35 phase 5: the import engine. Rows of an operator's Facebook lead-form
 * Google Sheet become leads, once each.
 *
 * Every outside effect arrives through `ImportDeps` (a store and a Google
 * client), so the whole flow runs under `node --test` with fakes. The real
 * ones are in import-server.ts. Pure: no network, no database, no server-only.
 *
 * Rules the code below keeps:
 *   - Only links in state active / waiting_test_row are read, never any other.
 *   - Each row is saved to `ad_sheet_rows` FIRST (insert, on conflict do
 *     nothing), with the owner taken from the LINK, never from the row's
 *     content. Only the insert's winner goes on to make a lead, so a re-read,
 *     a second run or a retry never makes a second lead.
 *   - test -> row state test (and a waiting link becomes active); foreign (the
 *     ad code is another operator's) -> foreign, no lead, no answers kept;
 *     incomplete -> incomplete, `missing` and `answers` kept, no lead; same
 *     landlord as a recent lead -> merged; otherwise a new lead.
 *   - `last_row_read` moves only over rows that were saved, so a failure in
 *     the middle re-reads the rest next time (the insert makes that safe).
 *   - A row saved as `imported` with no lead (a crash or timeout between the
 *     insert and the lead) is picked up by a later run once it is older than
 *     ORPHAN_AFTER_MS: `claimOrphanRow` is one atomic update, so only the run
 *     whose update wins makes the lead.
 *   - Any test row seen on a waiting link activates it, whether or not that
 *     run's insert won (the first run may have saved the row and not activated).
 *   - One run stops cleanly at its time budget; `last_row_read` stays at the
 *     last row fully saved and the next run continues.
 *   - A dry run reads and counts; it writes nothing and sends nothing.
 *
 * Never writes `leads.status` or `leads.crm_pushed_at` (they mean "went to
 * your CRM"): a new lead is `new`, and that is `captureLead`'s doing.
 * NEVER LOGS A LEAD: a log line carries a link id, a lead id and a code at
 * most, never a name, an address, a number, a postcode or a cell.
 */
import type { LinkRow, PackAdRef } from '../ad-packs/attribution.ts';
import { normaliseCode } from '../ad-packs/codes.ts';
import { attributeRow } from './attribute.ts';
import type { RowAttribution } from './attribute.ts';
import type { GoogleCode, SheetTab } from './google.ts';
import { headersChanged, mapHeaders } from './headers.ts';
import type { HeaderMap, RequiredField } from './headers.ts';
import { findCodeInText, isComplete, isTestLead, rowKey, toCandidate } from './rows.ts';
import type { Candidate } from './rows.ts';

// ── Types ──────────────────────────────────────────────────────────────────

export type ImportLinkState = 'waiting_test_row' | 'active';
export type RowState = 'imported' | 'merged' | 'incomplete' | 'test' | 'foreign';

/** One ad_sheet_links row, as far as the import needs it. */
export interface ImportLink {
  id: string;
  ownerId: string;
  spreadsheetId: string;
  tabGid: string | null;
  tabTitle: string | null;
  state: ImportLinkState;
  headerHash: string | null;
  lastRowRead: number;
  rowsImported: number;
  untaggedCount: number;
}

/** What the engine knows of one owner's pack: loaded once per link per run. */
export interface PackContext {
  operatorCode: string | null;
  /** The owner's pack ads, every version. */
  packAds: PackAdRef[];
  /** Meta ad id -> pack ad id, from ad_pack_lead_links (seen with a code, this owner). */
  knownMetaAdIds: Map<string, string>;
}

export interface NewRow {
  linkId: string;
  /** Always the link's owner. */
  ownerId: string;
  rowKey: string;
  rowNumber: number;
  state: RowState;
  missing: RequiredField[];
  answers: Record<string, string> | null;
}

export interface CapturedLead {
  id: string;
  /** True when the lead already existed (the same enquiry again inside the hour). */
  reused: boolean;
}

export interface LinkPatch {
  /** Only ever 'error' (not shared / not found); a link becomes active through activateLink. */
  state?: 'error';
  headerHash?: string;
  headerMap?: unknown;
  columnsChangedAt?: string;
  lastRowRead?: number;
  rowsImported?: number;
  untaggedCount?: number;
  lastRowAt?: string;
  lastImportAt?: string;
  lastErrorCode?: string | null;
}

export interface ImportStore {
  /** Links in state active or waiting_test_row, optionally just one. Never any other state. */
  links(opts: { linkId?: string }): Promise<ImportLink[]>;
  /** The owner's pack ads, operator code and known Meta ad ids. */
  packContext(ownerId: string): Promise<PackContext>;
  /** The operator that owns a pack code, across owners: the id only, never contents. */
  ownerOfCode(code: string): Promise<string | null>;
  /** `ad_sheet_dedupe_days`. */
  dedupeDays(): Promise<number>;
  /** The operator's website funnel, or null. */
  websiteFunnelId(ownerId: string): Promise<string | null>;
  /** Insert on conflict (link_id, row_key) do nothing. The new row's id when this call won, null when the row already existed. */
  insertRow(row: NewRow): Promise<string | null>;
  /** Dry runs: which of these keys are already saved. */
  existingRowKeys(linkId: string, keys: string[]): Promise<Set<string>>;
  /**
   * Atomic claim of a row stuck at `imported` with no lead: one update of that (link, key) `where state = 'imported' and
   * lead_id is null and created_at < olderThanIso`, which also stamps created_at to now (so a second worker, or this one
   * again within the window, finds nothing). The row's id when this call won, null otherwise.
   */
  claimOrphanRow(linkId: string, rowKey: string, olderThanIso: string): Promise<string | null>;
  updateRow(rowId: string, patch: { state: RowState; leadId: string | null }): Promise<void>;
  /** Takes back a row whose lead could not be made, so the next run tries it again. */
  deleteRow(rowId: string): Promise<void>;
  findSameLandlord(ownerId: string, cand: { postcode: string | null; email: string | null; phone: string | null }, days: number): Promise<{ id: string } | null>;
  captureLead(input: {
    ownerId: string;
    funnelId: string | null;
    name: string | null;
    email: string | null;
    phone: string | null;
    postcode: string | null;
  }): Promise<CapturedLead | null>;
  hasPackLink(leadId: string): Promise<boolean>;
  upsertPackLink(row: LinkRow): Promise<void>;
  activateLink(linkId: string, atIso: string): Promise<void>;
  saveLink(linkId: string, patch: LinkPatch): Promise<void>;
  /** Fire-and-forget after a new lead: the lead database push. Never awaited by the engine. */
  pushToLeadDb(leadId: string): Promise<unknown>;
  /** Fire-and-forget after a new lead: the instant new-lead email. Never awaited by the engine. */
  notifyNewLead(leadId: string): Promise<unknown>;
}

export interface SheetClient {
  sheetMeta(spreadsheetId: string): Promise<SheetTab[]>;
  readRange(spreadsheetId: string, tab: string, fromRow: number, toRow: number): Promise<string[][]>;
}

export interface ImportDeps {
  store: ImportStore;
  client: SheetClient;
  now?: () => Date;
  /** Time budget of one whole run in ms (default 45 s of the route's 60 s). */
  budgetMs?: number;
}

export interface LinkImportResult {
  linkId: string;
  /** False when a Google or database error stopped this link. */
  ok: boolean;
  /** 'ok', a Google code (not_shared, not_found, rate_limited, error, not_configured) or 'db_error'. */
  code: string;
  /** Rows looked at (blank rows and rows already saved included). */
  rowsRead: number;
  /** Rows already saved by an earlier run (or, in a dry run, already in the table). */
  alreadySaved: number;
  /** New rows saved (dry: that would be). */
  saved: number;
  imported: number;
  merged: number;
  incomplete: number;
  test: number;
  foreign: number;
  /** New leads with no pack ad (Ad unknown). */
  untagged: number;
  /** A waiting link became active (dry: would). */
  activated: boolean;
  columnsChanged: boolean;
  /** Set only when the run's time budget ended this link early (not an error; the next run continues). */
  budgetStopped?: boolean;
}

export interface ImportResult {
  ok: boolean;
  code: 'ok' | 'not_configured' | 'error';
  dry: boolean;
  links: LinkImportResult[];
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Rows re-read before the last one read, in case an operator edits or fills a row late. */
export const REREAD_OVERLAP = 50;
const CHUNK_ROWS = 500;
/** At most this many rows of one sheet per run; last_row_read moves on and the next run continues. */
const MAX_CHUNKS = 10;
const DEFAULT_DEDUPE_DAYS = 30;
/** A row left at `imported` with no lead is only taken over after this long, so a running worker is never raced. */
export const ORPHAN_AFTER_MS = 5 * 60 * 1000;
/** One run's time budget: stops cleanly well before the route's 60 s limit. */
export const DEFAULT_BUDGET_MS = 45 * 1000;

// ── Reading ────────────────────────────────────────────────────────────────

interface SheetRow {
  number: number;
  cells: string[];
}

function codeOf(err: unknown): string {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === 'string' && c ? c : 'db_error';
}

function isGoogleCode(code: string): code is GoogleCode {
  return code === 'not_configured' || code === 'not_shared' || code === 'not_found' || code === 'rate_limited' || code === 'error';
}

async function resolveTab(client: SheetClient, link: ImportLink): Promise<string> {
  if (link.tabTitle && !link.tabGid) return link.tabTitle;
  const tabs = await client.sheetMeta(link.spreadsheetId);
  if (link.tabGid) {
    const hit = tabs.find((t) => String(t.gid) === link.tabGid);
    if (hit) return hit.title;
  }
  if (link.tabTitle && tabs.some((t) => t.title === link.tabTitle)) return link.tabTitle;
  if (link.tabTitle) return link.tabTitle;
  if (tabs.length === 0) throw Object.assign(new Error('not_found'), { code: 'not_found' });
  return tabs[0].title;
}

/** Rows from `from` on, in chunks, ending at the first short chunk. A Google error part-way keeps the rows already read. */
async function readFrom(client: SheetClient, link: ImportLink, tab: string, from: number): Promise<{ rows: SheetRow[]; reached: number; stopped: string | null }> {
  const rows: SheetRow[] = [];
  let start = from;
  let stopped: string | null = null;
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    let values: string[][];
    try {
      values = await client.readRange(link.spreadsheetId, tab, start, start + CHUNK_ROWS - 1);
    } catch (err) {
      const code = codeOf(err);
      // Past the end of the sheet's grid Google answers with an error rather than nothing: a first chunk that fails is a
      // real failure, a later one is the end of the data.
      if (chunk > 0 && code === 'error') break;
      stopped = code;
      break;
    }
    values.forEach((cells, i) => rows.push({ number: start + i, cells }));
    if (values.length < CHUNK_ROWS) break;
    start += CHUNK_ROWS;
  }
  const reached = rows.length > 0 ? rows[rows.length - 1].number : from - 1;
  return { rows, reached, stopped };
}

const isBlank = (cells: readonly unknown[]) => cells.every((c) => String(c ?? '').trim() === '');

// ── One row, decided without side effects ──────────────────────────────────

interface Decision {
  kind: 'test' | 'foreign' | 'incomplete' | 'complete';
  cand: Candidate;
  attr: RowAttribution;
  missing: RequiredField[];
}

function classify(cand: Candidate, attr: RowAttribution): Decision {
  const { complete, missing } = isComplete(cand);
  if (isTestLead(cand)) return { kind: 'test', cand, attr, missing: [] };
  if (attr.foreign) return { kind: 'foreign', cand, attr, missing: [] };
  if (!complete) return { kind: 'incomplete', cand, attr, missing };
  return { kind: 'complete', cand, attr, missing: [] };
}

// ── The run ────────────────────────────────────────────────────────────────

export async function runImport(opts: { dry?: boolean; linkId?: string } = {}, deps: ImportDeps): Promise<ImportResult> {
  const dry = opts.dry === true;
  const { store, client } = deps;
  const now = deps.now ?? (() => new Date());
  const out: ImportResult = { ok: true, code: 'ok', dry, links: [] };

  let links: ImportLink[];
  let days = DEFAULT_DEDUPE_DAYS;
  try {
    links = (await store.links({ linkId: opts.linkId })).filter((l) => l.state === 'active' || l.state === 'waiting_test_row');
    days = await store.dedupeDays();
  } catch {
    console.error('[ad-sheets] could not load links');
    return { ok: false, code: 'error', dry, links: [] };
  }

  const deadline = now().getTime() + (deps.budgetMs ?? DEFAULT_BUDGET_MS);
  for (const link of links) {
    // Links left unread are the ones with the oldest last_import_at, so the next run starts with them.
    if (!dry && now().getTime() >= deadline) break;
    const res = await importLink(link, { dry, store, client, now, days, deadline });
    if (res === 'not_configured') return { ok: false, code: 'not_configured', dry, links: [] };
    out.links.push(res);
    if (!res.ok) {
      out.ok = false;
      out.code = 'error';
    }
  }
  return out;
}

async function importLink(
  link: ImportLink,
  ctx: { dry: boolean; store: ImportStore; client: SheetClient; now: () => Date; days: number; deadline: number },
): Promise<LinkImportResult | 'not_configured'> {
  const { dry, store, client, now, days, deadline } = ctx;
  const res: LinkImportResult = {
    linkId: link.id,
    ok: true,
    code: 'ok',
    rowsRead: 0,
    alreadySaved: 0,
    saved: 0,
    imported: 0,
    merged: 0,
    incomplete: 0,
    test: 0,
    foreign: 0,
    untagged: 0,
    activated: false,
    columnsChanged: false,
  };
  const nowIso = () => now().toISOString();
  let state: ImportLinkState = link.state;

  // Whatever stops this link ends with a code on the link (never a lead's detail).
  const finishFailed = async (code: string, patch: LinkPatch = {}): Promise<LinkImportResult | 'not_configured'> => {
    res.ok = false;
    res.code = code;
    if (!dry) {
      await store
        .saveLink(link.id, {
          ...patch,
          lastImportAt: nowIso(),
          lastErrorCode: code,
          ...(code === 'not_shared' || code === 'not_found' ? { state: 'error' as const } : {}),
        })
        .catch(() => console.error('[ad-sheets] could not record the error on link', link.id));
    }
    console.error('[ad-sheets] import stopped for link', link.id, code);
    return res;
  };

  // The header row, and whether the columns changed since last time.
  let tab: string;
  let hm: HeaderMap;
  let headerPatch: LinkPatch = {};
  try {
    tab = await resolveTab(client, link);
    const header = await client.readRange(link.spreadsheetId, tab, 1, 1);
    const headerRow = header[0] ?? [];
    if (isBlank(headerRow)) {
      // Nothing to read yet (an empty sheet): not an error, and nothing to save.
      if (!dry) await store.saveLink(link.id, { lastImportAt: nowIso(), lastErrorCode: null });
      return res;
    }
    hm = mapHeaders(headerRow);
    res.columnsChanged = headersChanged(link.headerHash, hm.hash);
    headerPatch = {
      headerHash: hm.hash,
      headerMap: { map: hm.map, missingRequired: hm.missingRequired },
      ...(res.columnsChanged ? { columnsChangedAt: nowIso() } : {}),
    };
  } catch (err) {
    const code = codeOf(err);
    if (code === 'not_configured') return 'not_configured';
    return finishFailed(isGoogleCode(code) ? code : 'db_error');
  }

  // The rows: from 50 before the last one read; the whole sheet again when it is shorter than that.
  let sheetRows: SheetRow[];
  let readStopped: string | null = null;
  let reached: number;
  try {
    const from = Math.max(2, link.lastRowRead - REREAD_OVERLAP);
    let read = await readFrom(client, link, tab, from);
    if (read.stopped === null && link.lastRowRead > 0 && from > 2 && read.reached < link.lastRowRead) {
      read = await readFrom(client, link, tab, 2);
    }
    sheetRows = read.rows;
    readStopped = read.stopped;
    reached = Math.max(1, read.reached);
  } catch (err) {
    const code = codeOf(err);
    if (code === 'not_configured') return 'not_configured';
    return finishFailed(isGoogleCode(code) ? code : 'db_error', headerPatch);
  }

  // The owner's pack, loaded once. A pack code that belongs to someone else is looked up (owner id only).
  let pack: PackContext;
  let funnelId: string | null = null;
  try {
    pack = await store.packContext(link.ownerId);
    if (!dry) funnelId = await store.websiteFunnelId(link.ownerId);
  } catch {
    return finishFailed('db_error', headerPatch);
  }
  const ads: PackAdRef[] = [...pack.packAds];
  const attrCtx = { ownerId: link.ownerId, operatorCode: pack.operatorCode, packAds: ads, knownMetaAdIds: pack.knownMetaAdIds };
  const looked = new Map<string, string | null>();
  const attribute = async (cand: Candidate): Promise<RowAttribution> => {
    const code = findCodeInText(cand.adName);
    if (code && !ads.some((a) => normaliseCode(a.code) === code)) {
      if (!looked.has(code)) looked.set(code, await store.ownerOfCode(code));
      const owner = looked.get(code);
      if (owner && owner !== link.ownerId) ads.push({ id: `foreign:${code}`, code, ownerId: owner, version: 0 });
    }
    return attributeRow(attrCtx, cand);
  };

  const existing = dry
    ? await store
        .existingRowKeys(
          link.id,
          sheetRows.filter((r) => !isBlank(r.cells)).map((r) => rowKey(r.cells, hm)),
        )
        .catch(() => null)
    : null;
  if (dry && existing === null) return finishFailed('db_error');

  // The last row number fully dealt with (progress is never claimed past it).
  let lastDone = 1;
  let stopped: string | null = null;
  let budgetStopped = false;

  for (const sr of sheetRows) {
    if (!dry && now().getTime() >= deadline) {
      budgetStopped = true;
      break;
    }
    res.rowsRead += 1;
    if (isBlank(sr.cells)) {
      lastDone = sr.number;
      continue;
    }
    const key = rowKey(sr.cells, hm);
    try {
      if (dry) {
        if (existing?.has(key)) {
          res.alreadySaved += 1;
          if (state === 'waiting_test_row' && isTestLead(toCandidate(sr.cells, hm))) res.activated = true;
        } else {
          const cand = toCandidate(sr.cells, hm);
          const d = classify(cand, await attribute(cand));
          res.saved += 1;
          if (d.kind === 'test') {
            res.test += 1;
            if (state === 'waiting_test_row') res.activated = true;
          } else if (d.kind === 'foreign') res.foreign += 1;
          else if (d.kind === 'incomplete') res.incomplete += 1;
          else if (await store.findSameLandlord(link.ownerId, d.cand, days)) res.merged += 1;
          else {
            res.imported += 1;
            if (!d.attr.packAdId) res.untagged += 1;
          }
        }
        lastDone = sr.number;
        continue;
      }

      const cand = toCandidate(sr.cells, hm);
      const d = classify(cand, await attribute(cand));
      const keepAnswers = Object.keys(cand.answers).length > 0 ? cand.answers : null;
      const base = { linkId: link.id, ownerId: link.ownerId, rowKey: key, rowNumber: sr.number };

      if (d.kind === 'test' || d.kind === 'foreign' || d.kind === 'incomplete') {
        const rowState: RowState = d.kind;
        const rowId = await store.insertRow({
          ...base,
          state: rowState,
          missing: d.kind === 'incomplete' ? d.missing : [],
          answers: d.kind === 'incomplete' ? keepAnswers : null,
        });
        if (rowId === null) {
          res.alreadySaved += 1;
        } else {
          res.saved += 1;
          res[d.kind] += 1;
        }
        // Any test row seen on a waiting link activates it, also one an earlier run saved without activating.
        if (d.kind === 'test' && state === 'waiting_test_row') {
          await store.activateLink(link.id, nowIso());
          state = 'active';
          res.activated = true;
        }
        lastDone = sr.number;
        continue;
      }

      // A complete row: saved first; only the insert's winner makes a lead.
      let rowId = await store.insertRow({ ...base, state: 'imported', missing: [], answers: keepAnswers });
      if (rowId === null) {
        // Saved before. If an earlier run stopped between the insert and the lead, this row has no lead: one atomic claim
        // decides which run makes it (a row younger than ORPHAN_AFTER_MS is left to the run that may still be on it).
        rowId = await store.claimOrphanRow(link.id, key, new Date(now().getTime() - ORPHAN_AFTER_MS).toISOString());
        if (rowId === null) {
          res.alreadySaved += 1;
          lastDone = sr.number;
          continue;
        }
      }
      res.saved += 1;

      let leadId: string;
      let rowState: RowState;
      let isNew: boolean;
      try {
        const hit = await store.findSameLandlord(link.ownerId, d.cand, days);
        if (hit) {
          leadId = hit.id;
          rowState = 'merged';
          isNew = false;
        } else {
          const cap = await store.captureLead({
            ownerId: link.ownerId,
            funnelId,
            name: d.cand.name,
            email: d.cand.email,
            phone: d.cand.phone,
            postcode: d.cand.postcode,
          });
          if (!cap) throw new Error('capture');
          leadId = cap.id;
          rowState = cap.reused ? 'merged' : 'imported';
          isNew = !cap.reused;
        }
      } catch (err) {
        // No lead was made: take the row back so the next run tries it again.
        await store.deleteRow(rowId).catch(() => console.error('[ad-sheets] could not take back a row on link', link.id));
        throw err;
      }

      // From here a lead exists (or the row joined one): the row stays whatever happens.
      await store.updateRow(rowId, { state: rowState, leadId });
      if (isNew) {
        res.imported += 1;
        if (!d.attr.packAdId) res.untagged += 1;
        await store.upsertPackLink(d.attr.link(leadId));
        void Promise.resolve()
          .then(() => store.pushToLeadDb(leadId))
          .catch(() => {});
        void Promise.resolve()
          .then(() => store.notifyNewLead(leadId))
          .catch(() => {});
      } else {
        res.merged += 1;
        // The lead may already be tied to an ad (a website lead): that stays. Only an untied lead takes this row's.
        if (!(await store.hasPackLink(leadId))) await store.upsertPackLink(d.attr.link(leadId));
      }
      lastDone = sr.number;
    } catch (err) {
      stopped = isGoogleCode(codeOf(err)) ? codeOf(err) : 'db_error';
      break;
    }
  }

  if (dry) {
    if (readStopped) {
      res.ok = false;
      res.code = readStopped;
    }
    return res;
  }

  const code = stopped ?? readStopped;
  const patch: LinkPatch = {
    ...headerPatch,
    lastRowRead: code || budgetStopped ? Math.max(lastDone, link.lastRowRead) : reached,
    rowsImported: link.rowsImported + res.imported,
    untaggedCount: link.untaggedCount + res.untagged,
    lastImportAt: nowIso(),
    lastErrorCode: code,
    ...(res.saved > 0 ? { lastRowAt: nowIso() } : {}),
    ...(code === 'not_shared' || code === 'not_found' ? { state: 'error' as const } : {}),
  };
  if (budgetStopped) res.budgetStopped = true;
  try {
    await store.saveLink(link.id, patch);
  } catch {
    console.error('[ad-sheets] could not save progress on link', link.id);
    res.ok = false;
    res.code = 'db_error';
    return res;
  }
  if (code) {
    res.ok = false;
    res.code = code;
    console.error('[ad-sheets] import stopped for link', link.id, code);
  }
  return res;
}
