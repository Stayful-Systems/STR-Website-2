'use server';

import { revalidatePath } from 'next/cache';
import { chooseProblemText } from '@/lib/domains/member-view';
import { liveDomainEngine } from '@/lib/domains/store-server';
import { websiteActor } from './context';

/**
 * Batch 33: the member picks their web address.
 *
 * The site is found by WHO IS SIGNED IN (websiteActor: the account owner's own
 * website), never from the form: the only thing read from the form is the
 * chosen name, and the engine accepts it only if it is in the list this site
 * was offered in the last 24 hours (website_domain_offers). So a member cannot
 * choose, change or buy anything for another member's site, or any name that
 * was not suggested. The name cannot change once it is being bought.
 */

export interface DomainChoiceState {
  error?: string;
  chosen?: boolean;
}

const refresh = () => revalidatePath('/leads/setup/website', 'layout');

export async function chooseDomainAction(_prev: DomainChoiceState, formData: FormData): Promise<DomainChoiceState> {
  const r = await websiteActor();
  if (!r.ok) return { error: r.reason === 'signed_out' ? 'Please sign in again.' : 'We could not do that just now. Please try again.' };
  const name = formData.get('name');
  if (typeof name !== 'string' || !name) return { error: 'Please choose one of the addresses below.' };

  const engine = liveDomainEngine();
  const result = await engine.chooseName({ websiteId: r.actor.site.id, name });
  if (!result.ok) {
    // Stale or unknown suggestions: fetch fresh ones so the page shows something to pick.
    if (result.reason === 'offer_expired' || result.reason === 'not_offered') await engine.offerNames({ websiteId: r.actor.site.id }, { refresh: true }).catch(() => undefined);
    refresh();
    return { error: chooseProblemText(result.reason) };
  }
  refresh();
  return { chosen: true };
}
