/**
 * Batch 38b: an in-memory RenderStore, sandbox and storage for the tests. It
 * mirrors what the SQL does (conditional claim, conditional finish, unique
 * (pack, version)). Nothing in the app imports it.
 */
import type { MemoryAdPackStore } from './test-store.ts';
import type { PackRow } from './store-types.ts';
import { RENDER_STATES, type RenderCounts, type RenderDone, type RenderFinish, type RenderRequeue, type RenderRow, type RenderStore } from './render-store.ts';
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

  async enqueue(packId: string, version: number, voiceKey: string) {
    const existing = [...this.rows.values()].find((r) => r.packId === packId && r.version === version);
    if (existing) return { inserted: false, row: clone(existing) };
    this.writes.push('enqueue');
    const now = this.stamp();
    const row: RenderRow = {
      id: `render-${++this.seq}`,
      packId,
      version,
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

  async getRender(packId: string, version: number) {
    const r = [...this.rows.values()].find((x) => x.packId === packId && x.version === version);
    return r ? clone(r) : null;
  }

  async requeueRender(i: RenderRequeue) {
    const r = [...this.rows.values()].find((x) => x.packId === i.packId && x.version === i.version);
    if (!r) {
      this.writes.push('requeue:insert');
      const now = this.stamp();
      const row: RenderRow = { id: `render-${++this.seq}`, packId: i.packId, version: i.version, voiceKey: i.voiceKey, state: 'queued', sandboxId: null, attempts: 0, leaseUntil: null, startedAt: null, finishedAt: null, costPence: 0, errorCode: null, files: null, createdAt: now, updatedAt: now };
      this.rows.set(row.id, row);
      return clone(row);
    }
    if (r.state === 'running') return null;
    this.writes.push('requeue');
    r.state = 'queued';
    r.attempts = 0;
    r.errorCode = null;
    r.files = null;
    r.voiceKey = i.voiceKey;
    r.leaseUntil = null;
    r.startedAt = null;
    r.finishedAt = null;
    r.updatedAt = this.stamp();
    return clone(r);
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

export class FakeStorage implements StorageLike {
  files = new Map<string, { bytes: Uint8Array; contentType: string }>();
  puts: string[] = [];
  failPut: ((path: string) => boolean) | null = null;
  async get(path: string) {
    return this.files.get(path)?.bytes ?? null;
  }
  async put(path: string, bytes: Uint8Array, contentType: string) {
    this.puts.push(path);
    if (this.failPut?.(path)) return { ok: false };
    this.files.set(path, { bytes, contentType });
    return { ok: true };
  }
}
