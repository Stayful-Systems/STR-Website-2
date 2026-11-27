import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * Batch 55 Part A, phase A3: source pins for the three signed doors the lead
 * database calls (provision, state, signin). The routes need a database and
 * the auth admin API, so what is held here is the shape of the code: the
 * signature is checked before anything else, no mailer is imported, nothing
 * logs a body or an address, and each route does only its own job. The
 * decisions themselves are pinned behaviourally in
 * src/lib/leaddb/provision-run.test.ts and inbound.test.ts.
 */
const read = (name: string) => readFileSync(new URL(`./${name}/route.ts`, import.meta.url), 'utf8');
/** Source with comments removed, so a rule about code is not met (or broken) by prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

const NAMES = ['provision', 'state', 'signin', 'unpaid-hold'] as const;
const sources = Object.fromEntries(NAMES.map((n) => [n, { raw: read(n), code: code(read(n)) }])) as Record<(typeof NAMES)[number], { raw: string; code: string }>;

for (const name of NAMES) {
  const { raw, code: c } = sources[name];

  test(`${name}: POST only, dynamic, and verifyInbound is the first thing the handler does`, () => {
    assert.match(c, /export async function POST\(request: Request\)/);
    assert.doesNotMatch(c, /export async function (GET|PUT|PATCH|DELETE)\b/);
    assert.match(raw, /export const dynamic = 'force-dynamic';/);
    assert.match(c, /import \{[^}]*\bverifyInbound\b[^}]*\} from '@\/lib\/leaddb\/inbound'/);
    const handler = c.slice(c.indexOf('export async function POST'));
    // The first statement of the handler is the signature check, its refusal returned as is.
    assert.match(handler, /^export async function POST\(request: Request\) \{\s*const verified = await verifyInbound\(request\);\s*if \(!verified\.ok\) return verified\.response;/);
    // Nothing reads the request body or a header before it, and nothing else does so at all.
    assert.equal((c.match(/request\.(json|text|formData|headers)/g) ?? []).length, 0);
    assert.doesNotMatch(c, /authoriseInternal|internalSecretsConfigured/);
  });

  test(`${name}: never imports a mailer and never writes leads`, () => {
    assert.doesNotMatch(c, /sendEmail|sendOwner|sendAdmin|@\/lib\/email|resend|nodemailer/i);
    assert.doesNotMatch(c, /['"]leads['"]/);
    assert.doesNotMatch(c, /crm_pushed_at|\bstatus:\s*['"]/);
  });

  test(`${name}: every log line carries a code at most, never the body, an email or a url`, () => {
    for (const m of c.matchAll(/console\.(log|error|warn|info)\(([^\n]*)\);/g)) {
      // Identifiers only: the quoted label is prose and may say "link failed".
      const args = m[2].replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
      assert.doesNotMatch(args, /\b(verified|body|raw|email|company|phone|input|json|url|link|hashed|request)\b(?!\.)/, `a log line names sensitive data: ${m[0]}`);
      assert.doesNotMatch(args, /\.message\b/, `a log line prints an error's text: ${m[0]}`);
    }
    assert.doesNotMatch(c, /console\.\w+\([^)]*(JSON\.stringify|\$\{)/);
  });

  test(`${name}: answers are JSON codes only`, () => {
    for (const m of c.matchAll(/Response\.json\(([^;]*)\)/g)) {
      assert.match(m[1], /\bok:\s*(true|false)|outcome\.body/, `a response has no ok flag: ${m[0]}`);
    }
    assert.match(c, /code: 'bad_request'/);
    assert.match(c, /code: 'server_error'/);
  });
}

test('provision: validates the body, runs the engine, and refuses has_website through it', () => {
  const c = sources.provision.code;
  assert.match(c, /parseProvisionBody\(verified\.json\)/);
  assert.match(c, /runProvision\(liveProvisionDeps\(\), input\)/);
  assert.ok(c.indexOf('parseProvisionBody(') < c.indexOf('runProvision('));
  assert.match(c, /if \(!input\) return Response\.json\(\{ ok: false, code: 'bad_request' \}, \{ status: 400 \}\)/);
  assert.match(c, /Response\.json\(outcome\.body, \{ status: outcome\.status \}\)/);
  // It never touches the database itself: the wiring is in provision-server.ts.
  assert.doesNotMatch(c, /\.(from|insert|update|upsert|delete|rpc)\(/);
  const run = readFileSync(new URL('../../../../../lib/leaddb/provision-run.ts', import.meta.url), 'utf8');
  assert.match(run, /fail\(409, 'has_website'\)/);
  assert.match(run, /fail\(409, 'conflict'\)/);
  const server = readFileSync(new URL('../../../../../lib/leaddb/provision-server.ts', import.meta.url), 'utf8');
  assert.match(server, /auth\.admin\.createUser\(\{\s*email,\s*email_confirm: true/);
  assert.doesNotMatch(server, /sendEmail|generateLink|@\/lib\/email/);
  assert.match(server, /ensureCalculatorSite/);
});

test('state: unknown customer is 404, a stale push is 200, and the state goes through applyAdAccountState', () => {
  const c = sources.state.code;
  assert.match(c, /parseAdAccountState\(body\?\.state\)/);
  assert.match(c, /readAdAccountByCustomerId\(ldCustomerId\)/);
  assert.match(c, /code: 'unknown_customer' \}, \{ status: 404 \}/);
  assert.match(c, /applyAdAccountState\(account\.ownerId, state\)/);
  assert.ok(c.indexOf('readAdAccountByCustomerId(') < c.indexOf('applyAdAccountState('));
  assert.match(c, /Response\.json\(\{ ok: true, code: result \}\)/);
  // No other write path to the table, and never Zac's switch.
  assert.doesNotMatch(c, /\.(from|insert|update|upsert|delete|rpc)\(|setAdAccountAllowed|createAdAccount|allowed/);
});

test('signin: only for a linked customer, one magic link, lands on /leads/ads, sends no email', () => {
  const c = sources.signin.code;
  assert.match(c, /readAdAccountByCustomerId\(ldCustomerId\)/);
  assert.match(c, /code: 'unknown_customer' \}, \{ status: 404 \}/);
  assert.ok(c.indexOf('readAdAccountByCustomerId(') < c.indexOf('generateLink('));
  assert.equal((c.match(/generateLink\(/g) ?? []).length, 1);
  assert.match(c, /generateLink\(\{ type: 'magiclink', email \}\)/);
  assert.match(c, /const LANDING_PATH = '\/leads\/ads';/);
  assert.match(c, /confirmLink\(hashed, LANDING_PATH\)/);
  assert.match(c, /Response\.json\(\{ ok: true, url: confirmLink/);
  // Supabase's mailer is never asked: no signInWithOtp, no invite, no reset, no resend.
  assert.doesNotMatch(c, /signInWithOtp|inviteUserByEmail|resetPasswordForEmail|\.resend\(|auth\.admin\.(createUser|updateUser|deleteUser)/);
  // The url and the email are not logged.
});

test('unpaid-hold: unknown customer is 404, a stale call is 200, and the hold goes through applyUnpaidHold only', () => {
  const c = sources['unpaid-hold'].code;
  assert.match(c, /parseUnpaidHold\(body\)/);
  assert.match(c, /readAdAccountByCustomerId\(ldCustomerId\)/);
  assert.match(c, /code: 'unknown_customer' \}, \{ status: 404 \}/);
  assert.match(c, /applyUnpaidHold\(account\.ownerId, hold\)/);
  assert.ok(c.indexOf('readAdAccountByCustomerId(') < c.indexOf('applyUnpaidHold('));
  assert.match(c, /Response\.json\(\{ ok: true, code: result \}\)/);
  // No other write path to the table, never Zac's switch, and never called a pause.
  assert.doesNotMatch(c, /\.(from|insert|update|upsert|delete|rpc)\(|setAdAccountAllowed|createAdAccount|allowed|pause/i);
});

test('the routes sit under /api/internal/si/ad-route and are the only five (stage has its own test file: it writes leads)', () => {
  const dir = new URL('./', import.meta.url);
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(entries, ['provision', 'signin', 'stage', 'state', 'unpaid-hold']);
});
