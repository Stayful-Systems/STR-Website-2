/**
 * Batch 38b: the three voiceover voices an operator can pick for the notice video.
 *
 * Pure: no network, no server-only. The operator listens to the free preview
 * clip (an ElevenLabs-hosted mp3, played by the browser) before generating, so
 * choosing a voice costs nothing.
 *
 * All three are ElevenLabs library voices. Jane and Olivia are already in the
 * house account; Oliver has to be added to the account once (until then a
 * generate with him comes back as `voice_unavailable`).
 */

export type VoiceKey = 'jane' | 'olivia' | 'oliver';

export type Voice = {
  key: VoiceKey;
  /** The ElevenLabs voice id (text-to-speech path segment). */
  id: string;
  label: string;
  /** A free, public sample clip the operator can play before choosing. */
  previewUrl: string;
  /** One line for the operator. */
  description: string;
};

export const VOICES: readonly Voice[] = [
  {
    key: 'jane',
    id: 'RILOU7YmBhvwJGDGjNmP',
    label: 'Jane',
    previewUrl:
      'https://storage.googleapis.com/eleven-public-prod/database/workspace/20dd3b9a3ec14f77bc0f5688c9f44ff5/voices/RILOU7YmBhvwJGDGjNmP/rg0TiCrZRw0nfGOZiVoe.mp3',
    description: 'A warm, professional woman, British, like a trusted audiobook narrator.',
  },
  {
    key: 'olivia',
    id: 'NbkKnEAZ7Bqw4EAkVEaz',
    label: 'Olivia',
    previewUrl:
      'https://storage.googleapis.com/eleven-public-prod/database/workspace/ed9b05e6324c457685490352e9a1ec90/voices/NbkKnEAZ7Bqw4EAkVEaz/114IWVrfcJmQIwLEG3nY.mp3',
    description: 'A confident, engaging woman, British, friendly and direct.',
  },
  {
    key: 'oliver',
    id: 'lo1O1Dz1Tu4FWVEPaxuT',
    label: 'Oliver',
    previewUrl:
      'https://storage.googleapis.com/eleven-public-prod/database/workspace/5c61c7a454d7439891c7adfbf89f8465/voices/lo1O1Dz1Tu4FWVEPaxuT/aa14ee68-ecaf-4342-be68-9336220ef944.mp3',
    description: 'A calm, credible man, British, a warm narrator you can trust.',
  },
];

export const DEFAULT_VOICE_KEY: VoiceKey = 'jane';

export function isVoiceKey(value: unknown): value is VoiceKey {
  return typeof value === 'string' && VOICES.some((v) => v.key === value);
}

export function voiceByKey(key: unknown): Voice | null {
  return VOICES.find((v) => v.key === key) ?? null;
}

export function voiceById(id: unknown): Voice | null {
  return typeof id === 'string' ? (VOICES.find((v) => v.id === id) ?? null) : null;
}

/** The preview clip for a voice, or null for an unknown key. */
export function previewUrlFor(key: unknown): string | null {
  return voiceByKey(key)?.previewUrl ?? null;
}
