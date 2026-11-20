/**
 * Batch 33: which registrar the app uses, from DOMAINS_REGISTRAR.
 *
 *   unset         nothing is bought: getRegistrar() throws not_configured
 *   openprovider  the real one (OPENPROVIDER_USERNAME / _PASSWORD / _SANDBOX / _OWNER_HANDLE)
 *   fake          in memory; refused when VERCEL_ENV is production, so a live
 *                 site can never "buy" a domain that does not exist
 *
 * The fake is one instance per process, so a local dry run keeps its state.
 * Pure of server-only: env is passed in, which is how the tests choose.
 */
import { FakeRegistrar } from './fake.ts';
import { createOpenprovider } from './openprovider.ts';
import { RegistrarError, type Registrar } from './types.ts';

export type Env = Record<string, string | undefined>;

let fakeInstance: FakeRegistrar | null = null;

/** The registrar named in DOMAINS_REGISTRAR, or a not_configured error. */
export function getRegistrar(env: Env = process.env): Registrar {
  const which = (env.DOMAINS_REGISTRAR ?? '').trim().toLowerCase();
  if (which === 'fake') {
    if (env.VERCEL_ENV === 'production') throw new RegistrarError('not_configured');
    fakeInstance ??= new FakeRegistrar();
    return fakeInstance;
  }
  if (which === 'openprovider') {
    const username = env.OPENPROVIDER_USERNAME?.trim();
    const password = env.OPENPROVIDER_PASSWORD;
    if (!username || !password) throw new RegistrarError('not_configured');
    return createOpenprovider({ username, password, sandbox: (env.OPENPROVIDER_SANDBOX ?? '').trim().toLowerCase() === 'true' });
  }
  throw new RegistrarError('not_configured');
}

/** Is a registrar set up at all (so the UI can say "buying is off" instead of failing)? */
export function registrarConfigured(env: Env = process.env): boolean {
  try {
    getRegistrar(env);
    return true;
  } catch {
    return false;
  }
}

/** Stayful's owner handle at the registrar (the Stayful Systems Ltd contact), or null when it is not set. */
export function ownerHandle(env: Env = process.env): string | null {
  const h = env.OPENPROVIDER_OWNER_HANDLE?.trim();
  return h ? h : null;
}

/** Tests only: forget the fake so the next one starts empty. */
export function resetFakeRegistrar(): void {
  fakeInstance = null;
}
