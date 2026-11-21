/**
 * Batch 31: a website's slug, the part after /s/. Lowercase a-z, 0-9 and
 * hyphens, 3-40 characters, no leading or trailing hyphen (the database
 * checks '^[a-z0-9-]{3,40}$'; this is the stricter app rule), not reserved,
 * unique (the database enforces that), and fixed once the site is live.
 *
 * The reserved list is every top-level route of the app (so a later
 * own-domain or host rewrite can never shadow one) plus the words nobody
 * should own. slug.test.ts reads src/app and fails when a new top-level route
 * is missing from the list.
 *
 * Pure: no network, no database, no server-only.
 */

export const SLUG_MIN = 3;
export const SLUG_MAX = 40;
const SLUG_RE = /^[a-z0-9-]+$/;

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // Top-level routes under src/app (including the route groups' pages)
  'academy', 'account', 'admin', 'api', 'auth', 'briefing', 'btl-report', 'd', 'deal', 'deals', 'demo-report', 'estimate', 'extension',
  'f', 'home', 'intelligence', 'lead-form-sample', 'leads', 'm', 'markets', 'my-deals', 'p', 'picks', 'presentation', 'profile',
  'profiles', 'r', 'reports', 's', 'si', 't', 'team', 'today', 'upgrade', 'welcome',
  'login', 'signup', 'forgot-password', 'reset-password',
  'demo', 'features', 'for-management-companies', 'income-calculator', 'methodology', 'pricing', 'privacy', 'short-let-deals',
  'short-term-vs-long-term-letting', 'terms',
  'robots', 'robots.txt', 'sitemap', 'sitemap.xml', 'favicon', 'favicon.ico', 'icon', 'apple-icon', 'assets', 'images', 'data', 'static', '_next',
  // Words nobody should own
  'stayful', 'stayful-intelligence', 'www', 'app', 'mail', 'email', 'support', 'help', 'status', 'blog', 'docs', 'dashboard',
  'logout', 'signin', 'register', 'checkout', 'billing', 'webhook', 'webhooks', 'internal', 'cron', 'public', 'preview', 'new',
  'test', 'demo-site', 'example', 'null', 'undefined', 'root', 'about', 'contact', 'fees', 'faq', 'areas', 'website', 'websites', 'site', 'sites',
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.trim().toLowerCase());
}

export type SlugProblem = 'empty' | 'too_short' | 'too_long' | 'bad_characters' | 'edge_hyphen' | 'reserved';

const PROBLEM_TEXT: Record<SlugProblem, string> = {
  empty: 'Choose an address for the website.',
  too_short: `The address needs at least ${SLUG_MIN} characters.`,
  too_long: `The address can be at most ${SLUG_MAX} characters.`,
  bad_characters: 'Use only lowercase letters, numbers and hyphens.',
  edge_hyphen: 'The address cannot start or end with a hyphen.',
  reserved: 'That address is not available.',
};

export function slugProblemText(p: SlugProblem): string {
  return PROBLEM_TEXT[p];
}

/** The first thing wrong with a slug exactly as typed (no tidying), or null. */
export function slugProblem(slug: unknown): SlugProblem | null {
  if (typeof slug !== 'string' || slug.length === 0) return 'empty';
  if (!SLUG_RE.test(slug)) return 'bad_characters';
  if (slug.length < SLUG_MIN) return 'too_short';
  if (slug.length > SLUG_MAX) return 'too_long';
  if (slug.startsWith('-') || slug.endsWith('-')) return 'edge_hyphen';
  if (isReservedSlug(slug)) return 'reserved';
  return null;
}

export function isValidSlug(slug: unknown): slug is string {
  return slugProblem(slug) === null;
}

/**
 * A slug from a company name: accents folded, "&" read as "and", anything
 * else not a letter or number becomes one hyphen, trimmed and cut to 40. An
 * empty string when nothing usable is left. The result may still be too
 * short or reserved: check it with slugProblem.
 */
export function makeSlug(name: unknown): string {
  if (typeof name !== 'string') return '';
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, SLUG_MAX).replace(/-+$/g, '');
}

/**
 * Candidates to offer when a made slug is taken, reserved or too short:
 * the slug itself first, then -2, -3 ... (each cut so it still fits). `taken`
 * is what the database already holds. null when nothing usable can be made.
 */
export function freeSlug(base: string, taken: ReadonlySet<string> | readonly string[], maxTries = 50): string | null {
  const have = taken instanceof Set ? taken : new Set(taken);
  const root = makeSlug(base);
  if (!root) return null;
  for (let i = 1; i <= maxTries; i++) {
    const suffix = i === 1 ? '' : `-${i}`;
    const cand = root.slice(0, SLUG_MAX - suffix.length).replace(/-+$/g, '') + suffix;
    if (slugProblem(cand) === null && !have.has(cand)) return cand;
  }
  return null;
}
