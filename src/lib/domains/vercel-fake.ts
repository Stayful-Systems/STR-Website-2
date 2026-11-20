/**
 * Batch 33: an in-memory Vercel for the engine's tests. It records every
 * write, so a dry run can be shown to have called none.
 */
import { VercelError, type DomainConfig, type VercelDomains } from './vercel.ts';

export class FakeVercel implements VercelDomains {
  /** Domains on the project: name -> redirect target (or null). */
  readonly domains = new Map<string, string | null>();
  readonly log: string[] = [];
  /** What domainConfig answers; flip `misconfigured` to model DNS not yet pointing. */
  config: DomainConfig = { misconfigured: false, recommendedIPv4: ['76.76.21.21'], recommendedCNAME: 'cname.vercel-dns.com' };
  verified = true;
  /** The next call of this method throws. */
  readonly failNext = new Map<string, 'unclear' | 'refused'>();

  private enter(op: string, name: string): void {
    this.log.push(`${op}:${name}`);
    const f = this.failNext.get(op);
    if (f) {
      this.failNext.delete(op);
      throw new VercelError(f, f === 'unclear' ? 504 : 400);
    }
  }

  async addDomain(name: string): Promise<void> {
    this.enter('addDomain', name);
    if (!this.domains.has(name)) this.domains.set(name, null);
  }

  async addWwwRedirect(name: string): Promise<void> {
    this.enter('addWwwRedirect', name);
    this.domains.set(`www.${name}`, name);
  }

  async domainConfig(name: string): Promise<DomainConfig> {
    this.enter('domainConfig', name);
    return { ...this.config, recommendedIPv4: [...this.config.recommendedIPv4] };
  }

  async domainVerified(name: string): Promise<boolean> {
    this.enter('domainVerified', name);
    return this.verified && this.domains.has(name);
  }

  async removeDomain(name: string): Promise<void> {
    this.enter('removeDomain', name);
    this.domains.delete(name);
  }

  /** Writes: adds and removes. */
  writeCalls(): number {
    return this.log.filter((l) => l.startsWith('addDomain:') || l.startsWith('addWwwRedirect:') || l.startsWith('removeDomain:')).length;
  }
}
