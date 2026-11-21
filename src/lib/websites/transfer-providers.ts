/**
 * Batch 37: the registrars an operator can move their domain away from, and the
 * IPS tag each one is moved under. A .uk domain is moved to another registrar by
 * changing its tag to the new registrar's tag (until the transfer code takes over
 * on website_transfer_code_from; see transfer-rules.ts methodFor).
 *
 * Four are known: 123 Reg, Namecheap, IONOS and GoDaddy. "Other" is a tag the
 * operator types; it is normalised (trimmed, upper case) and checked against
 * TAG_PATTERN. GoDaddy and IONOS tags are to be confirmed before launch.
 *
 * Pure: no network, no database. helpUrl is the registrar's own help centre, shown
 * as "where to find this" in the guide; it is never fetched.
 */

export interface TransferProvider {
  key: string;
  name: string;
  /** The IPS tag, upper case. */
  tag: string;
  helpUrl: string;
}

export const OTHER_PROVIDER_KEY = 'other';
export const OTHER_PROVIDER_NAME = 'Other';

export const TRANSFER_PROVIDERS: readonly TransferProvider[] = [
  { key: '123-reg', name: '123 Reg', tag: '123-REG', helpUrl: 'https://www.123-reg.co.uk/support/' },
  { key: 'namecheap', name: 'Namecheap', tag: 'NAMECHEAP-INC', helpUrl: 'https://www.namecheap.com/support/' },
  { key: 'ionos', name: 'IONOS', tag: '1AND1', helpUrl: 'https://www.ionos.co.uk/help/' },
  { key: 'godaddy', name: 'GoDaddy', tag: 'GODADDY', helpUrl: 'https://www.godaddy.com/help' },
];

/** An IPS tag: upper case letters, digits and hyphens, 2 to 31 characters, not starting with a hyphen. */
export const TAG_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,30}$/;

/** A typed tag, trimmed and upper cased. Not checked. */
export function normaliseTag(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}

/** True when the (normalised) tag is a well-formed IPS tag. */
export function isValidTag(raw: unknown): boolean {
  return TAG_PATTERN.test(normaliseTag(raw));
}

export function providerByKey(key: unknown): TransferProvider | null {
  return typeof key === 'string' ? (TRANSFER_PROVIDERS.find((p) => p.key === key) ?? null) : null;
}

export type ProviderRefusal = 'unknown_provider' | 'bad_tag';

export const PROVIDER_REFUSALS: Record<ProviderRefusal, string> = {
  unknown_provider: 'Choose where your domain is registered now.',
  bad_tag: 'That tag does not look right. It is letters, numbers and hyphens only, for example MY-REGISTRAR.',
};

export type ProviderChoice =
  | { ok: true; key: string; name: string; tag: string }
  | { ok: false; code: ProviderRefusal; message: string };

/**
 * The provider the operator picked. A known key always uses our own tag (a typed
 * tag beside it is ignored); "other" needs a well-formed typed tag.
 */
export function resolveProvider(providerKey: unknown, typedTag?: unknown): ProviderChoice {
  const known = providerByKey(providerKey);
  if (known) return { ok: true, key: known.key, name: known.name, tag: known.tag };
  if (providerKey === OTHER_PROVIDER_KEY) {
    const tag = normaliseTag(typedTag);
    if (!TAG_PATTERN.test(tag)) return { ok: false, code: 'bad_tag', message: PROVIDER_REFUSALS.bad_tag };
    return { ok: true, key: OTHER_PROVIDER_KEY, name: OTHER_PROVIDER_NAME, tag };
  }
  return { ok: false, code: 'unknown_provider', message: PROVIDER_REFUSALS.unknown_provider };
}
