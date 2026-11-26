/**
 * Batch 55 (Part A, Phase A9): the audience recipe the Facebook guide asks every operator to set,
 * Academy and lead database alike. Pure data: no network, no database, no filesystem. guide.ts builds
 * the "Set up your audience" step from RECIPE_ITEMS, in this order.
 *
 * Words: plain English, sentence case, no exclamation marks. No money figure, no promise about
 * results, and no product name in any item (guide.test.ts pins this for the audience step). The
 * operator sets their own budget amount in Meta; this recipe never types one.
 */

/** The day Zac last checked this recipe against Meta's own screen. */
export const LAST_CHECKED = '2026-11-23';

/** The interests to add, exactly as Meta names them. */
export const INTERESTS = ['Real property (property)', 'Landlord', 'Airbnb (lodging)'] as const;

export type RecipeItemId = 'location' | 'age-gender' | 'advantage-audience' | 'interests' | 'placements' | 'campaign-budget' | 'exclusions';

export type RecipeItem = {
  id: RecipeItemId;
  /** The name of the setting on Meta's screen. */
  label: string;
  /** What to set it to, as a short phrase. */
  setting: string;
  /** One extra sentence of help, if the setting needs one. */
  note?: string;
};

/** The seven settings, in the order the guide shows them. */
export const RECIPE_ITEMS: readonly RecipeItem[] = [
  {
    id: 'location',
    label: 'Location',
    setting: 'United Kingdom, living in or recently in',
    note: 'You may narrow this to your own area, but the wider setting gives Meta more to learn from.',
  },
  { id: 'age-gender', label: 'Age and gender', setting: '18 to 65+, all genders' },
  { id: 'advantage-audience', label: 'Advantage+ audience', setting: 'On' },
  { id: 'interests', label: 'Interests', setting: `Add ${INTERESTS[0]}, ${INTERESTS[1]} and ${INTERESTS[2]}` },
  { id: 'placements', label: 'Placements', setting: 'Advantage+ placements' },
  {
    id: 'campaign-budget',
    label: 'Campaign budget',
    setting: 'On',
    note: 'Do not type an amount here, because you choose your own amount.',
  },
  {
    id: 'exclusions',
    label: 'Exclusions and lookalikes',
    setting: 'Leave both empty',
    note: 'You can add your own list if you have one.',
  },
];

/** One line of the checklist: "Label: setting." and the note, if any. */
export const recipeLine = (item: RecipeItem): string => `${item.label}: ${item.setting}.${item.note ? ` ${item.note}` : ''}`;

/**
 * PROPOSED, not yet part of the guide: the campaign goal for this recipe. The guide still sends
 * operators to the Traffic goal (step "choose-traffic"), which needs no tracking set up per
 * operator, and this proposal names Leads. Zac decides whether to switch before it is shown.
 */
export const OBJECTIVE_PROPOSED = {
  status: 'proposed',
  goal: 'Leads',
  destination: 'Website',
  optimiseFor: 'Maximise number of landing page views',
} as const;
