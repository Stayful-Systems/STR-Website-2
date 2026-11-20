/**
 * Batch 38b: the pure half of the voiceover call (voice-server.ts wires the
 * key, the meter and the logger; the tests call this with an injected fetch).
 *
 *   synthesiseCore({voiceKey, lines, fetchImpl, apiKey, ...}) ->
 *     {ok:true, audio, mimeType, script, costPence, characters} | {ok:false, code}
 *
 * One POST to ElevenLabs `/v1/text-to-speech/{voice}/with-timestamps`: the JSON
 * reply holds the mp3 (base64) and a character-level alignment, which
 * captions.ts turns into the brief's `script` block. The model is the app's
 * narrator model (eleven_turbo_v2_5, the same family as /api/speak).
 *
 * Codes (never a message: ElevenLabs' error text and our script are never
 * returned or logged):
 *   voice_unavailable  unknown voice key, or ElevenLabs does not know the voice
 *                      (404; 400/422 naming the voice: a library voice that has
 *                      not been added to the account yet)
 *   no_key             no ELEVENLABS_API_KEY, or ElevenLabs refused it (401)
 *   quota              402, or 401 saying the quota is used up
 *   rate_limited       429
 *   timeout            no reply inside timeoutMs (45 s) on an attempt
 *   bad_response       a 200 whose body is not audio + an alignment of our text
 *   failed             anything else (also invalid input, network error, 5xx twice)
 * A 5xx is retried once.
 *
 * Pure: no database, no server-only, no process.env.
 */
import { UNIT_COST_SEED } from '../credit/costs.ts';
import { AlignmentError, buildBriefScript, cleanLines, joinScriptLines, validateBriefScript, type Alignment, type BriefScript } from './captions.ts';
import { voiceByKey, type VoiceKey } from './voices.ts';

export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';
export const VOICE_MODEL_ID = 'eleven_turbo_v2_5';
export const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0 } as const;
export const VOICE_OUTPUT_FORMAT = 'mp3_44100_128';
export const VOICE_MIME_TYPE = 'audio/mpeg';
export const VOICE_TIMEOUT_MS = 45_000;
/** A script is ~5 short paragraphs; anything near this is a bug, and the call is bought per character. */
export const MAX_VOICE_CHARACTERS = 2500;

export const VOICE_CODES = ['voice_unavailable', 'no_key', 'rate_limited', 'quota', 'timeout', 'bad_response', 'failed'] as const;
export type VoiceCode = (typeof VOICE_CODES)[number];

export type SynthesiseResult =
  | { ok: true; audio: Uint8Array; mimeType: string; script: BriefScript; costPence: number; characters: number }
  | { ok: false; code: VoiceCode };

/** Pence per character: the unit_costs seed row for ElevenLabs speech (the live row, when the server has one, is passed in). */
export const SEED_CHARACTER_PENCE: number = UNIT_COST_SEED.find((r) => r.provider === 'elevenlabs' && r.unit === 'character')?.unitCostPence ?? 0.02;

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Characters of the text that is actually sent for these lines. */
export function voiceCharacters(lines: readonly string[]): number {
  return joinScriptLines(lines).length;
}

/**
 * The most the voice call can cost us (raw pence, rounded UP to a whole penny),
 * for generate-core's estimateRawPence. One attempt: a failed 5xx is not billed.
 */
export function estimateVoicePence(lines: readonly string[], voiceKey: VoiceKey, unitCostPence: number = SEED_CHARACTER_PENCE): number {
  void voiceKey; // every voice costs the same per character today
  const chars = voiceCharacters(lines);
  if (chars === 0) return 0;
  return Math.max(1, Math.ceil(chars * unitCostPence));
}

/** Wraps the paid call so the house meter sees it. `run` resolves ok:false for a call that delivered nothing. */
export type VoiceMeter = <T extends { ok: boolean }>(characters: number, run: () => Promise<T>) => Promise<T>;

export type SynthesiseCoreInput = {
  voiceKey: VoiceKey;
  lines: readonly string[];
  fetchImpl: typeof fetch;
  apiKey: string | undefined;
  timeoutMs?: number;
  /** Raw pence per character (the live unit cost); default is the seed. */
  unitCostPence?: number;
  meterCall?: VoiceMeter;
  /** Called with the voice key and a code only. */
  log?: (event: string, fields: { voiceKey: string; code: string }) => void;
};

type Attempt = { ok: true; body: unknown } | { ok: false; code: VoiceCode; retry?: boolean };

function classify(status: number, body: string): VoiceCode {
  const b = body.toLowerCase();
  if (status === 404) return 'voice_unavailable';
  if (status === 400 || status === 422) return b.includes('voice') ? 'voice_unavailable' : 'failed';
  if (status === 402) return 'quota';
  if (status === 401) return b.includes('quota') ? 'quota' : 'no_key';
  if (status === 429) return 'rate_limited';
  return 'failed';
}

async function attempt(fetchImpl: typeof fetch, url: string, apiKey: string, payload: string, timeoutMs: number): Promise<Attempt> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    return { ok: false, code: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'failed' };
  }
  if (res.status >= 500) return { ok: false, code: 'failed', retry: true };
  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    return { ok: false, code: classify(res.status, text) };
  }
  try {
    return { ok: true, body: await res.json() };
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    // The body may have been cut by the timeout; either way we got no usable reply.
    return name === 'TimeoutError' || name === 'AbortError' ? { ok: false, code: 'timeout' } : { ok: true, body: undefined };
  }
}

function decodeBase64(b64: string): Uint8Array {
  const buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export async function synthesiseCore(input: SynthesiseCoreInput): Promise<SynthesiseResult> {
  const voice = voiceByKey(input.voiceKey);
  const lines = Array.isArray(input.lines) ? cleanLines(input.lines) : [];
  const fail = (code: VoiceCode): SynthesiseResult => {
    input.log?.('voice_failed', { voiceKey: String(input.voiceKey), code });
    return { ok: false, code };
  };
  if (!voice) return fail('voice_unavailable');
  const text = joinScriptLines(lines);
  if (lines.length === 0 || text.length > MAX_VOICE_CHARACTERS) return fail('failed');
  const apiKey = (input.apiKey ?? '').trim();
  if (!apiKey) return fail('no_key');

  const url = `${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(voice.id)}/with-timestamps?output_format=${VOICE_OUTPUT_FORMAT}`;
  const payload = JSON.stringify({ text, model_id: VOICE_MODEL_ID, voice_settings: VOICE_SETTINGS });
  const timeoutMs = input.timeoutMs ?? VOICE_TIMEOUT_MS;
  const characters = text.length;

  const run = async (): Promise<Attempt> => {
    let last = await attempt(input.fetchImpl, url, apiKey, payload, timeoutMs);
    if (!last.ok && last.retry) last = await attempt(input.fetchImpl, url, apiKey, payload, timeoutMs);
    return last;
  };

  let outcome: Attempt;
  try {
    outcome = input.meterCall ? await input.meterCall(characters, run) : await run();
  } catch {
    return fail('failed');
  }
  if (!outcome.ok) return fail(outcome.code);

  const body = outcome.body as { audio_base64?: unknown; alignment?: Alignment | null; normalized_alignment?: Alignment | null } | null | undefined;
  const b64 = body && typeof body === 'object' ? body.audio_base64 : undefined;
  if (typeof b64 !== 'string' || b64 === '') return fail('bad_response');
  const audio = decodeBase64(b64);
  if (audio.byteLength === 0) return fail('bad_response');

  // `alignment` is of the text we sent; the normalised one only if that is missing.
  let script: BriefScript | null = null;
  for (const candidate of [body?.alignment, body?.normalized_alignment]) {
    if (!candidate) continue;
    try {
      const s = buildBriefScript(lines, candidate);
      if (validateBriefScript(s).ok) {
        script = s;
        break;
      }
    } catch (e) {
      if (!(e instanceof AlignmentError)) return fail('bad_response');
    }
  }
  if (!script) return fail('bad_response');

  const rate = input.unitCostPence ?? SEED_CHARACTER_PENCE;
  return { ok: true, audio, mimeType: VOICE_MIME_TYPE, script, costPence: round4(characters * rate), characters };
}
