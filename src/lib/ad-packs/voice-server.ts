import 'server-only';

import { meter } from '../credit/meter';
import { getUnitCostTable } from '../credit/unit-costs';
import { priceFor } from '../credit/pricing';
import { synthesiseCore, SEED_CHARACTER_PENCE, type SynthesiseResult, type VoiceMeter } from './voice-core.ts';
import { previewUrlFor, type VoiceKey } from './voices.ts';

export { previewUrlFor };
export type { SynthesiseResult } from './voice-core.ts';
export { estimateVoicePence, VOICE_CODES, VOICE_MODEL_ID, type VoiceCode } from './voice-core.ts';

/**
 * Batch 38b: the voiceover for the notice video.
 *
 *   synthesise({voiceKey, lines, packId?, fetchImpl?}) -> {ok:true, audio, mimeType, script, costPence, characters} | {ok:false, code}
 *
 * The cost is the house's, never the operator's: the call goes through the
 * credit meter with an explicit house context (userId null), so it is logged in
 * provider_calls at its raw cost and nobody is charged, even when this is called
 * inside someone's metered request. `costPence` is the raw cost estimate
 * (characters x the live ElevenLabs per-character unit cost; the seed if the
 * table cannot be read) for the pack's cost_pence and the monthly cap.
 *
 * Needs ELEVENLABS_API_KEY. The key, the script and ElevenLabs' error text are
 * never logged or returned; a log line carries the pack id, the voice key and a code.
 */
export async function synthesise(input: {
  voiceKey: VoiceKey;
  lines: readonly string[];
  packId?: string;
  fetchImpl?: typeof fetch;
}): Promise<SynthesiseResult> {
  let unitCostPence = SEED_CHARACTER_PENCE;
  try {
    const priced = priceFor(await getUnitCostTable(), 'elevenlabs', 'character', 1);
    if (priced.found && Number.isFinite(priced.unitCostPence)) unitCostPence = priced.unitCostPence;
  } catch {
    // the seed rate stands
  }

  const meterCall: VoiceMeter = (characters, run) =>
    meter(
      {
        provider: 'elevenlabs',
        unit: 'character',
        quantity: characters,
        description: 'Ad pack voiceover',
        failed: (r) => !r.ok,
        skipPreflight: true,
      },
      run,
      // An explicit house context: without one, meter() would take the surrounding request's payer.
      { userId: null, admin: false, action: 'ad_pack_voice', actionId: crypto.randomUUID() },
    );

  return synthesiseCore({
    voiceKey: input.voiceKey,
    lines: input.lines,
    fetchImpl: input.fetchImpl ?? fetch,
    apiKey: process.env.ELEVENLABS_API_KEY,
    unitCostPence,
    meterCall,
    log: (event, f) => console.error(`[ad-packs] ${event}`, input.packId ?? '-', f.voiceKey, f.code),
  });
}
