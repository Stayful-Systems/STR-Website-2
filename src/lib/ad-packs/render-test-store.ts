/**
 * Batch 38b: an in-memory RenderStore, sandbox and storage for the tests. It
 * mirrors what the SQL does (conditional claim, conditional finish, unique
 * (pack, version)). Nothing in the app imports it.
 */
import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import type { MemoryAdPackStore } from './test-store.ts';
import type { PackRow } from './store-types.ts';
import { RENDER_STATES, kindOf, type RenderKind, type NotifyOutcome, type RenderCounts, type RenderDone, type RenderFinish, type RenderRequeue, type RenderRow, type RenderStore } from './render-store.ts';
import type { SandboxLike, SandboxRun, StorageLike } from './render-core.ts';

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryRenderStore implements RenderStore {
  readonly rows = new Map<string, RenderRow>();
  /** Every write, by name, so a dry run can be shown to have made none. */
  readonly writes: string[] = [];
  clock: () => Date = () => new Date();
  private seq = 0;

  readonly packs: MemoryAdPackStore;
  constructor(packs: MemoryAdPackStore) {
    this.packs = packs;
  }

  private stamp(): string {
    return this.clock().toISOString();
  }

  async enqueue(packId: string, version: number, voiceKey: string, kind: RenderKind = 'notice') {
    const existing = [...this.rows.values()].find((r) => r.packId === packId && r.version === version && kindOf(r) === kind);
    if (existing) return { inserted: false, row: clone(existing) };
    this.writes.push(kind === 'notice' ? 'enqueue' : `enqueue:${kind}`);
    const now = this.stamp();
    const row: RenderRow = {
      id: `render-${++this.seq}`,
      packId,
      version,
      ...(kind !== 'notice' ? { kind } : {}),
      voiceKey,
      state: 'queued',
      sandboxId: null,
      attempts: 0,
      leaseUntil: null,
      startedAt: null,
      finishedAt: null,
      costPence: 0,
      errorCode: null,
      files: null,
      createdAt: now,
      updatedAt: now,
      notifiedAt: null,
      notifiedOutcome: null,
    };
    this.rows.set(row.id, row);
    return { inserted: true, row: clone(row) };
  }

  async listQueued(limit: number) {
    return [...this.rows.values()]
      .filter((r) => r.state === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(clone);
  }

  async listExpired(nowIso: string, limit: number) {
    return [...this.rows.values()]
      .filter((r) => r.state === 'running' && r.leaseUntil !== null && r.leaseUntil < nowIso)
      .slice(0, limit)
      .map(clone);
  }

  async counts(): Promise<RenderCounts> {
    const out = Object.fromEntries(RENDER_STATES.map((s) => [s, 0])) as RenderCounts;
    for (const r of this.rows.values()) out[r.state]++;
    return out;
  }

  async claim(id: string, nowIso: string, leaseUntilIso: string) {
    const r = this.rows.get(id);
    if (!r || r.state !== 'queued') return null;
    this.writes.push('claim');
    r.state = 'running';
    r.leaseUntil = leaseUntilIso;
    r.attempts += 1;
    r.startedAt = nowIso;
    r.errorCode = null;
    r.updatedAt = nowIso;
    return clone(r);
  }

  async release(id: string, claimedAttempts: number, patch: RenderFinish) {
    const r = this.rows.get(id);
    if (!r || r.state !== 'running' || r.attempts !== claimedAttempts) return false;
    this.writes.push(`release:${patch.state}`);
    r.state = patch.state;
    r.errorCode = patch.errorCode;
    r.costPence = patch.costPence;
    r.sandboxId = patch.sandboxId ?? r.sandboxId;
    r.finishedAt = patch.finishedAt;
    r.leaseUntil = null;
    r.updatedAt = this.stamp();
    return true;
  }

  async complete(id: string, claimedAttempts: number, patch: RenderDone) {
    const r = this.rows.get(id);
    if (!r || r.state !== 'running' || r.attempts !== claimedAttempts) return false;
    this.writes.push('complete');
    r.state = 'done';
    r.errorCode = null;
    r.costPence = patch.costPence;
    r.sandboxId = patch.sandboxId ?? r.sandboxId;
    r.files = clone(patch.files);
    r.finishedAt = patch.finishedAt;
    r.leaseUntil = null;
    r.updatedAt = this.stamp();
    return true;
  }

  async expire(id: string, attempts: number, nowIso: string, maxAttempts: number) {
    const r = this.rows.get(id);
    if (!r || r.state !== 'running' || r.attempts !== attempts || r.leaseUntil === null || r.leaseUntil >= nowIso) return null;
    this.writes.push('expire');
    r.leaseUntil = null;
    r.updatedAt = nowIso;
    if (r.attempts >= maxAttempts) {
      r.state = 'failed';
      r.errorCode = 'timeout';
      r.finishedAt = nowIso;
      return 'failed';
    }
    r.state = 'queued';
    r.errorCode = 'timeout';
    return 'requeued';
  }

  async getRender(packId: string, version: number, kind: RenderKind = 'notice') {
    const r = [...this.rows.values()].find((x) => x.packId === packId && x.version === version && kindOf(x) === kind);
    return r ? clone(r) : null;
  }

  async requeueRender(i: RenderRequeue) {
    const kind = i.kind ?? 'notice';
    const r = [...this.rows.values()].find((x) => x.packId === i.packId && x.version === i.version && kindOf(x) === kind);
    if (!r) {
      this.writes.push('requeue:insert');
      const now = this.stamp();
      const row: RenderRow = { id: `render-${++this.seq}`, packId: i.packId, version: i.version, ...(kind !== 'notice' ? { kind } : {}), voiceKey: i.voiceKey, state: 'queued', sandboxId: null, attempts: 0, leaseUntil: null, startedAt: null, finishedAt: null, costPence: 0, errorCode: null, files: null, createdAt: now, updatedAt: now, notifiedAt: null, notifiedOutcome: null };
      this.rows.set(row.id, row);
      return clone(row);
    }
    if (r.state === 'running') return null;
    this.writes.push('requeue');
    r.state = 'queued';
    if (i.keepAttempts !== true) r.attempts = 0;
    r.errorCode = null;
    r.files = null;
    r.voiceKey = i.voiceKey;
    r.leaseUntil = null;
    r.startedAt = null;
    r.finishedAt = null;
    r.notifiedAt = null;
    r.notifiedOutcome = null;
    r.updatedAt = this.stamp();
    return clone(r);
  }

  async listUnnotified(sinceIso: string, limit: number) {
    return [...this.rows.values()]
      .filter((r) => (r.state === 'done' || r.state === 'failed') && !r.notifiedAt && r.finishedAt !== null && r.finishedAt >= sinceIso)
      .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? '') || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(clone);
  }

  async claimNotify(i: { id: string; state: 'done' | 'failed'; outcome: NotifyOutcome; atIso: string }) {
    const r = this.rows.get(i.id);
    if (!r || r.state !== i.state || r.notifiedAt) return null;
    this.writes.push(`notify:${i.outcome}`);
    r.notifiedAt = i.atIso;
    r.notifiedOutcome = i.outcome;
    return clone(r);
  }

  async releaseNotify(id: string, atIso: string) {
    const r = this.rows.get(id);
    if (!r || r.notifiedAt !== atIso) return;
    this.writes.push('notify:release');
    r.notifiedAt = null;
    r.notifiedOutcome = null;
  }

  async getPack(packId: string): Promise<PackRow | null> {
    const p = this.packs.packs.get(packId);
    return p ? clone(p) : null;
  }

  async setAdFiles(ownerId: string, packAdId: string, files: Record<string, unknown>) {
    const ad = this.packs.ads.get(packAdId);
    if (!ad || ad.ownerId !== ownerId) return false;
    this.writes.push('setAdFiles');
    (ad as { files: unknown }).files = clone(files);
    return true;
  }
}

// ── Fakes ──

export type FakeSandboxOptions = {
  /** Called for every command; return what it did. Default: success with no output. */
  onRun?: (cmd: SandboxRunInput, sandbox: FakeSandbox) => SandboxRun | Promise<SandboxRun>;
  /** Make creating the sandbox fail. */
  failCreate?: boolean;
  /** Files that exist in the sandbox after the render command (read back by path). */
  outputs?: Record<string, Uint8Array>;
};
type SandboxRunInput = Parameters<SandboxLike['run']>[0];

/** A sandbox that records everything and returns canned results. */
export class FakeSandbox implements SandboxLike {
  readonly id: string;
  files = new Map<string, Uint8Array>();
  commands: SandboxRunInput[] = [];
  stopped = 0;
  private readonly opts: FakeSandboxOptions;
  private readonly advance: (ms: number) => void;
  constructor(id: string, opts: FakeSandboxOptions, advance: (ms: number) => void) {
    this.id = id;
    this.opts = opts;
    this.advance = advance;
  }
  async writeFiles(files: { path: string; content: Uint8Array }[]) {
    for (const f of files) this.files.set(f.path, f.content);
  }
  async run(cmd: SandboxRunInput): Promise<SandboxRun> {
    this.commands.push(cmd);
    if (this.opts.onRun) return this.opts.onRun(cmd, this);
    this.advance(10_000);
    return { exitCode: 0, stderr: '', timedOut: false };
  }
  async readFile(path: string) {
    return this.opts.outputs?.[path] ?? this.files.get(path) ?? null;
  }
  async stop() {
    this.stopped++;
  }
}

export class FakeSandboxes {
  created: { vcpus: number; timeoutMs: number; sandbox: FakeSandbox }[] = [];
  opts: FakeSandboxOptions = {};
  private readonly advance: (ms: number) => void;
  constructor(advance: (ms: number) => void) {
    this.advance = advance;
  }
  readonly factory = async (o: { vcpus: number; timeoutMs: number }): Promise<SandboxLike> => {
    if (this.opts.failCreate) throw new Error('boom: a token and a url that must never be stored');
    const sandbox = new FakeSandbox(`sbx-${this.created.length + 1}`, this.opts, this.advance);
    this.created.push({ ...o, sandbox });
    return sandbox;
  };
}

/**
 * The ad-packs bucket's allowed_mime_types, read from supabase/schema.sql (the one statement that creates the bucket).
 * A FakeStorage given these refuses a type the real bucket would refuse (Supabase answers a disallowed type with an error).
 */
export function adPacksBucketMimeTypes(schemaSql: string = readFileSync(nodePath.join(process.cwd(), 'supabase', 'schema.sql'), 'utf8')): string[] {
  const m = /insert into storage\.buckets[^;]*?values\s*\(\s*'ad-packs'[^;]*?array\[([^\]]*)\]/.exec(schemaSql);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

export class FakeStorage implements StorageLike {
  files = new Map<string, { bytes: Uint8Array; contentType: string }>();
  puts: string[] = [];
  /** Every content type that was put (accepted or refused). */
  putTypes: string[] = [];
  failPut: ((path: string) => boolean) | null = null;
  /** When set, a put with any other content type is refused, as the private bucket does. */
  allowedTypes: ReadonlySet<string> | null = null;
  /** When set, a put throws instead of answering (a network error). */
  throwOnPut: ((path: string) => boolean) | null = null;
  async get(path: string) {
    return this.files.get(path)?.bytes ?? null;
  }
  async put(path: string, bytes: Uint8Array, contentType: string) {
    this.puts.push(path);
    this.putTypes.push(contentType);
    if (this.throwOnPut?.(path)) throw new Error('network down');
    if (this.allowedTypes && !this.allowedTypes.has(contentType)) return { ok: false };
    if (this.failPut?.(path)) return { ok: false };
    this.files.set(path, { bytes, contentType });
    return { ok: true };
  }
}
