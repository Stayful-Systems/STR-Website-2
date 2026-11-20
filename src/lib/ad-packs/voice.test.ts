import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { joinScriptLines, validateBriefScript, type Alignment } from './captions.ts';
import {
  ELEVENLABS_BASE_URL,
  MAX_VOICE_CHARACTERS,
  SEED_CHARACTER_PENCE,
  VOICE_CODES,
  VOICE_MODEL_ID,
  estimateVoicePence,
  synthesiseCore,
  voiceCharacters,
  type SynthesiseCoreInput,
  type VoiceMeter,
} from './voice-core.ts';
import { makeTtsResponse, sampleScriptLines, sampleScriptText } from './voice-test-support.ts';
import { VOICES } from './voices.ts';

const KEY = 'xi-secret-key-0123456789abcdef';
const LINES = sampleScriptLines();
const fixture = JSON.parse(readFileSync(new URL('./fixtures/alignment-notice.json', import.meta.url), 'utf8')) as {
  audio_base64: string;
  alignment: Alignment;
};

type Call = { url: string; init: RequestInit };

function jsonRes(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stub(responses: Array<Response | (() => Response | Promise<Response>)>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i++, responses.length - 1)];
    return typeof r === 'function' ? r() : r;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const base = (fetchImpl: typeof fetch, extra: Partial<SynthesiseCoreInput> = {}): SynthesiseCoreInput => ({
  voiceKey: 'jane',
  lines: LINES,
  fetchImpl,
  apiKey: KEY,
  ...extra,
});

const okBody = () => makeTtsResponse(joinScriptLines(LINES));

test('success: request shape, audio, script, cost', async () => {
  const s = stub([jsonRes(fixture)]);
  const logs: string[] = [];
  const r = await synthesiseCore(base(s.fetchImpl, { log: (e, f) => logs.push(`${e} ${f.voiceKey} ${f.code}`) }));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(s.calls.length, 1);
  const [call] = s.calls;
  assert.ok(call.url.startsWith(`${ELEVENLABS_BASE_URL}/v1/text-to-speech/RILOU7YmBhvwJGDGjNmP/with-timestamps`));
  assert.equal(call.init.method, 'POST');
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers['xi-api-key'], KEY);
  const sent = JSON.parse(String(call.init.body));
  assert.equal(sent.text, sampleScriptText());
  assert.equal(sent.model_id, VOICE_MODEL_ID);
  assert.equal(sent.model_id, 'eleven_turbo_v2_5');
  assert.ok(sent.voice_settings && typeof sent.voice_settings.stability === 'number');
  assert.ok(!call.url.includes(KEY) && !String(call.init.body).includes(KEY));

  assert.equal(r.mimeType, 'audio/mpeg');
  assert.ok(r.audio instanceof Uint8Array && r.audio.byteLength > 0);
  assert.equal(Buffer.from(r.audio).toString('base64'), fixture.audio_base64);
  assert.equal(r.characters, sampleScriptText().length);
  assert.equal(r.costPence, Math.round(r.characters * SEED_CHARACTER_PENCE * 10_000) / 10_000);
  assert.ok(r.costPence > 0 && r.costPence < 50);
  assert.equal(r.script.lines.length, 5);
  assert.deepEqual(validateBriefScript(r.script), { ok: true, problems: [] });
  assert.deepEqual(logs, []);
});

test('each voice uses its own id; an unknown voice never reaches the network', async () => {
  for (const v of VOICES) {
    const s = stub([jsonRes(okBody())]);
    const r = await synthesiseCore(base(s.fetchImpl, { voiceKey: v.key }));
    assert.ok(r.ok);
    assert.ok(s.calls[0].url.includes(`/text-to-speech/${v.id}/`));
  }
  const s = stub([jsonRes(okBody())]);
  const r = await synthesiseCore(base(s.fetchImpl, { voiceKey: 'bob' as never }));
  assert.deepEqual(r, { ok: false, code: 'voice_unavailable' });
  assert.equal(s.calls.length, 0);
});

test('a configured unit cost and the meter hook are used', async () => {
  const seen: number[] = [];
  const meterCall: VoiceMeter = async (chars, run) => {
    seen.push(chars);
    return run();
  };
  const s = stub([jsonRes(okBody())]);
  const r = await synthesiseCore(base(s.fetchImpl, { unitCostPence: 0.1, meterCall }));
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.costPence, Math.round(r.characters * 0.1 * 10_000) / 10_000);
  assert.deepEqual(seen, [sampleScriptText().length]);
});

test('missing key: no_key and no request', async () => {
  for (const apiKey of [undefined, '', '   ']) {
    const s = stub([jsonRes(okBody())]);
    assert.deepEqual(await synthesiseCore(base(s.fetchImpl, { apiKey })), { ok: false, code: 'no_key' });
    assert.equal(s.calls.length, 0);
  }
});

test('error mapping', async () => {
  const cases: Array<[string, Response, string]> = [
    ['404 voice not found', jsonRes({ detail: { status: 'voice_not_found', message: 'A voice with the voice_id was not found.' } }, 404), 'voice_unavailable'],
    ['404 empty', jsonRes('', 404), 'voice_unavailable'],
    ['400 voice not in account', jsonRes({ detail: { status: 'voice_not_found', message: 'voice missing' } }, 400), 'voice_unavailable'],
    ['400 other', jsonRes({ detail: { status: 'invalid_text' } }, 400), 'failed'],
    ['401 bad key', jsonRes({ detail: { status: 'invalid_api_key' } }, 401), 'no_key'],
    ['401 quota', jsonRes({ detail: { status: 'quota_exceeded', message: 'quota exceeded' } }, 401), 'quota'],
    ['402', jsonRes({ detail: 'payment' }, 402), 'quota'],
    ['429', jsonRes({ detail: { status: 'too_many_concurrent_requests' } }, 429), 'rate_limited'],
    ['403', jsonRes('', 403), 'failed'],
  ];
  for (const [name, res, code] of cases) {
    const s = stub([res]);
    const r = await synthesiseCore(base(s.fetchImpl));
    assert.deepEqual(r, { ok: false, code }, name);
    assert.equal(s.calls.length, 1, `${name}: not retried`);
    assert.ok(VOICE_CODES.includes(code as never));
  }
});

test('a 5xx is retried once: 500 then 200 succeeds; 500 twice fails', async () => {
  const s = stub([jsonRes('boom', 500), jsonRes(okBody())]);
  const r = await synthesiseCore(base(s.fetchImpl));
  assert.ok(r.ok);
  assert.equal(s.calls.length, 2);

  const s2 = stub([jsonRes('boom', 503), jsonRes('boom', 502), jsonRes(okBody())]);
  assert.deepEqual(await synthesiseCore(base(s2.fetchImpl)), { ok: false, code: 'failed', billedCalls: 2 }, 'both calls reached ElevenLabs and may have been billed');
  assert.equal(s2.calls.length, 2, 'one retry only');
});

test('billedCalls: only a call that reached ElevenLabs and was not refused counts (a 5xx then a timeout is two; refusals, network errors and bad requests are none)', async () => {
  let n = 0;
  const fetchImpl = ((_url: string, init: RequestInit) => {
    if (n++ === 0) return Promise.resolve(jsonRes('boom', 500));
    return new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  }) as unknown as typeof fetch;
  const keepAlive = setInterval(() => {}, 1000);
  try {
    assert.deepEqual(await synthesiseCore(base(fetchImpl, { timeoutMs: 25 })), { ok: false, code: 'timeout', billedCalls: 2 });
  } finally {
    clearInterval(keepAlive);
  }
  for (const status of [400, 401, 402, 404, 429]) {
    const r = await synthesiseCore(base(stub([jsonRes({ detail: { status: 'x' } }, status)]).fetchImpl));
    assert.ok(!r.ok && (r as { billedCalls?: number }).billedCalls === undefined, String(status));
  }
  const net = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  assert.deepEqual(await synthesiseCore(base(net)), { ok: false, code: 'failed' });
  // A good reply carries no billedCalls (its cost is in costPence).
  const good = await synthesiseCore(base(stub([jsonRes(okBody())]).fetchImpl));
  assert.ok(good.ok && !('billedCalls' in good));
});

test('bad responses', async () => {
  const noAudio = { alignment: okBody().alignment };
  const noAlign = { audio_base64: okBody().audio_base64 };
  const otherText = { ...makeTtsResponse('Some completely different sentence.') };
  const cases: Array<[string, Response]> = [
    ['malformed JSON', jsonRes('{"audio_base64": "abc', 200)],
    ['not JSON', jsonRes('<html>nope</html>', 200)],
    ['empty object', jsonRes({}, 200)],
    ['null', jsonRes('null', 200)],
    ['no audio', jsonRes(noAudio, 200)],
    ['empty audio', jsonRes({ ...okBody(), audio_base64: '' }, 200)],
    ['no alignment', jsonRes(noAlign, 200)],
    ['alignment of other text', jsonRes(otherText, 200)],
    ['ragged alignment', jsonRes({ audio_base64: okBody().audio_base64, alignment: { characters: ['a'], character_start_times_seconds: [], character_end_times_seconds: [] } }, 200)],
  ];
  for (const [name, res] of cases) {
    const s = stub([res]);
    assert.deepEqual(await synthesiseCore(base(s.fetchImpl)), { ok: false, code: 'bad_response', billedCalls: 1 }, name);
  }
  // normalized_alignment is used only when alignment is missing.
  const ok = okBody();
  const s = stub([jsonRes({ audio_base64: ok.audio_base64, normalized_alignment: ok.normalized_alignment })]);
  assert.ok((await synthesiseCore(base(s.fetchImpl))).ok);
});

test('timeout: an attempt that does not answer in time gives timeout', async () => {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  }) as unknown as typeof fetch;
  // AbortSignal.timeout's timer is unref'd (a real socket keeps the process alive); keep the loop alive here.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const r = await synthesiseCore(base(fetchImpl, { timeoutMs: 25 }));
    assert.deepEqual(r, { ok: false, code: 'timeout', billedCalls: 1 });
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(calls.length, 1, 'a timeout is not retried');
  assert.ok(calls[0].init.signal instanceof AbortSignal);

  const dom = (async () => {
    throw new DOMException('The operation was aborted', 'AbortError');
  }) as unknown as typeof fetch;
  assert.deepEqual(await synthesiseCore(base(dom)), { ok: false, code: 'timeout', billedCalls: 1 });
  const net = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  assert.deepEqual(await synthesiseCore(base(net)), { ok: false, code: 'failed' });
});

test('invalid input fails without a request', async () => {
  const s = stub([jsonRes(okBody())]);
  assert.deepEqual(await synthesiseCore(base(s.fetchImpl, { lines: [] })), { ok: false, code: 'failed' });
  assert.deepEqual(await synthesiseCore(base(s.fetchImpl, { lines: ['', '  '] })), { ok: false, code: 'failed' });
  assert.deepEqual(await synthesiseCore(base(s.fetchImpl, { lines: ['x'.repeat(MAX_VOICE_CHARACTERS + 1)] })), { ok: false, code: 'failed' });
  assert.deepEqual(await synthesiseCore(base(s.fetchImpl, { lines: null as never })), { ok: false, code: 'failed' });
  assert.equal(s.calls.length, 0);
});

test('a meter that throws gives failed, never a thrown error', async () => {
  const s = stub([jsonRes(okBody())]);
  const meterCall: VoiceMeter = async () => {
    throw new Error(`db down for ${KEY}`);
  };
  assert.deepEqual(await synthesiseCore(base(s.fetchImpl, { meterCall })), { ok: false, code: 'failed' });
});

test('the key and the script never appear in a result, a thrown error or a log line', async () => {
  const logs: string[] = [];
  const log = (e: string, f: { voiceKey: string; code: string }) => logs.push(JSON.stringify([e, f]));
  const echo = jsonRes({ detail: { message: `bad key ${KEY} for text ${sampleScriptText().slice(0, 40)}` } }, 400);
  const outcomes: unknown[] = [];
  for (const res of [echo, jsonRes(`${KEY} ${sampleScriptText()}`, 500), jsonRes({}, 200), jsonRes('', 429), jsonRes('', 401)]) {
    const s = stub([res, res]);
    outcomes.push(await synthesiseCore(base(s.fetchImpl, { log })));
  }
  const throwing = (async () => {
    throw new Error(`socket error ${KEY} ${sampleScriptText()}`);
  }) as unknown as typeof fetch;
  outcomes.push(await synthesiseCore(base(throwing, { log })));
  const dump = JSON.stringify(outcomes) + logs.join('\n');
  assert.ok(!dump.includes(KEY));
  assert.ok(!dump.includes('Brightstone'));
  assert.ok(!dump.includes('tenant'));
  for (const o of outcomes) assert.ok(Object.keys(o as object).every((k) => ['billedCalls', 'code', 'ok'].includes(k)));
  assert.ok(logs.length >= 5);
  for (const l of logs) assert.match(l, /^\["voice_failed",\{"voiceKey":"jane","code":"[a-z_]+"\}\]$/);
});

test('estimateVoicePence: worst case, whole pence, grows with the script', () => {
  const chars = voiceCharacters(LINES);
  assert.equal(chars, sampleScriptText().length);
  const est = estimateVoicePence(LINES, 'jane');
  assert.ok(Number.isInteger(est) && est >= 1);
  assert.ok(est >= chars * SEED_CHARACTER_PENCE, 'never below the real cost');
  assert.ok(est < chars * SEED_CHARACTER_PENCE + 1);
  for (const v of VOICES) assert.equal(estimateVoicePence(LINES, v.key), est);
  assert.ok(estimateVoicePence([...LINES, ...LINES], 'jane') > est);
  assert.equal(estimateVoicePence([], 'jane'), 0);
  assert.equal(estimateVoicePence(LINES, 'jane', 1), chars);
  assert.ok(SEED_CHARACTER_PENCE > 0 && SEED_CHARACTER_PENCE < 1);
});
