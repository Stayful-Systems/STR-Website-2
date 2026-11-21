/**
 * Batch 33: an in-memory registrar for tests and a local dry run. It buys
 * nothing, anywhere. It keeps state (what is owned, what is taken, the DNS it
 * was given), counts every call, and can be told to misbehave: time out before
 * or after a registration really happened, report a name as taken, refuse.
 *
 * index.ts refuses to hand it out when VERCEL_ENV is production.
 */
import { RegistrarError, type Availability, type DnsRecord, type OwnedDomain, type Registrar } from './types.ts';

export type FakeOp = 'check' | 'findOwned' | 'register' | 'setDns' | 'setAutoRenew' | 'renew' | 'info' | 'changeIpsTag' | 'transferCode';

export class FakeRegistrar implements Registrar {
  readonly id = 'fake';
  /** Names we hold: name -> record. */
  readonly owned = new Map<string, { ref: string; expiresAt: string; autoRenew: boolean }>();
  /** Names somebody else holds: check says unavailable, register says taken. */
  readonly taken = new Set<string>();
  readonly premium = new Set<string>();
  /** Per-name price in pence; anything not listed costs defaultPricePence. */
  readonly prices = new Map<string, number>();
  defaultPricePence = 600;
  readonly dns = new Map<string, DnsRecord[]>();
  /** The IPS tag last set for each name (changeIpsTag). */
  readonly tags = new Map<string, string>();
  /** What transferCode returns: fixed, and not a real code. */
  static readonly TEST_TRANSFER_CODE = 'FAKE-TEST-CODE';
  readonly calls: Record<FakeOp, number> = { check: 0, findOwned: 0, register: 0, setDns: 0, setAutoRenew: 0, renew: 0, info: 0, changeIpsTag: 0, transferCode: 0 };
  /** Every call in order, "op:name". */
  readonly log: string[] = [];
  /** The next register throws `unclear`: 'before' = nothing happened, 'after' = the name WAS registered. */
  unclearOnNextRegister: 'before' | 'after' | null = null;
  /** The next call of an op throws this code (once). */
  readonly failNext = new Map<FakeOp, 'unclear' | 'refused' | 'taken'>();
  now: () => Date = () => new Date();
  private seq = 0;

  private enter(op: FakeOp, name = ''): void {
    this.calls[op] += 1;
    this.log.push(`${op}:${name}`);
    const fail = this.failNext.get(op);
    if (fail) {
      this.failNext.delete(op);
      throw new RegistrarError(fail, fail === 'unclear' ? 504 : 400);
    }
  }

  private oneYearOn(from: Date): string {
    const d = new Date(from.getTime());
    d.setUTCFullYear(d.getUTCFullYear() + 1);
    return d.toISOString();
  }

  async check(names: readonly string[]): Promise<Availability[]> {
    this.enter('check', names.join(','));
    return names.map((name) => {
      const available = !this.taken.has(name) && !this.owned.has(name);
      return { name, available, premium: this.premium.has(name), pricePence: available ? (this.prices.get(name) ?? this.defaultPricePence) : null };
    });
  }

  async findOwned(name: string): Promise<OwnedDomain | null> {
    this.enter('findOwned', name);
    const o = this.owned.get(name);
    return o ? { ref: o.ref, expiresAt: o.expiresAt, autoRenew: o.autoRenew } : null;
  }

  async register(name: string, opts: { ownerHandle: string }): Promise<{ ref: string; expiresAt: string | null }> {
    this.enter('register', name);
    if (!opts.ownerHandle) throw new RegistrarError('refused', 400);
    if (this.taken.has(name) || this.owned.has(name)) throw new RegistrarError('taken', 409);
    const mode = this.unclearOnNextRegister;
    this.unclearOnNextRegister = null;
    if (mode === 'before') throw new RegistrarError('unclear', 504);
    const record = { ref: `fake-${++this.seq}`, expiresAt: this.oneYearOn(this.now()), autoRenew: false };
    this.owned.set(name, record);
    if (mode === 'after') throw new RegistrarError('unclear', 504);
    return { ref: record.ref, expiresAt: record.expiresAt };
  }

  async setDns(name: string, records: readonly DnsRecord[]): Promise<void> {
    this.enter('setDns', name);
    if (!this.owned.has(name)) throw new RegistrarError('refused', 404);
    this.dns.set(name, records.map((r) => ({ ...r })));
  }

  async setAutoRenew(name: string, on: boolean): Promise<void> {
    this.enter('setAutoRenew', `${name}:${on}`);
    const o = this.owned.get(name);
    if (!o) throw new RegistrarError('refused', 404);
    o.autoRenew = on;
  }

  async renew(name: string): Promise<{ expiresAt: string }> {
    this.enter('renew', name);
    const o = this.owned.get(name);
    if (!o) throw new RegistrarError('refused', 404);
    o.expiresAt = this.oneYearOn(new Date(o.expiresAt));
    return { expiresAt: o.expiresAt };
  }

  async info(name: string): Promise<OwnedDomain | null> {
    this.enter('info', name);
    const o = this.owned.get(name);
    return o ? { ref: o.ref, expiresAt: o.expiresAt, autoRenew: o.autoRenew } : null;
  }

  async changeIpsTag(name: string, tag: string): Promise<void> {
    this.enter('changeIpsTag', name);
    this.tags.set(name, tag);
  }

  async transferCode(name: string): Promise<string> {
    this.enter('transferCode', name);
    return FakeRegistrar.TEST_TRANSFER_CODE;
  }

  /** The calls that spend money or change the registrar: none of these may happen on a dry run. */
  writeCalls(): number {
    return this.calls.register + this.calls.setDns + this.calls.setAutoRenew + this.calls.renew + this.calls.changeIpsTag + this.calls.transferCode;
  }
}
