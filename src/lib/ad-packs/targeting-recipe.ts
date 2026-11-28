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

/** The radius the guide asks for around each chosen town (Phase 3, lead database packs with chosen areas). */
export const AREA_RADIUS_MILES = 25;

/**
 * Batch 55 step 5 (Phase 3): the seven settings for one LEAD DATABASE pack, whose location follows where its ads say
 * the customer works. Nationwide: "United Kingdom, living in or recently in", with no note about narrowing it. Chosen
 * areas: each town with a 25 mile radius, the towns listed. Every other item is RECIPE_ITEMS unchanged. The Academy
 * guide keeps RECIPE_ITEMS exactly (it never calls this). LAST_CHECKED is not moved: the radius wording was not
 * re-checked against Meta's screen.
 */
export function recipeItemsFor(coverage: { mode: 'uk' } | { mode: 'areas'; areas: readonly string[] }): RecipeItem[] {
  const location: RecipeItem =
    coverage.mode === 'uk' || coverage.areas.length === 0
      ? { id: 'location', label: 'Location', setting: 'United Kingdom, living in or recently in' }
      : {
          id: 'location',
          label: 'Location',
          setting: `Add ${coverage.areas.length === 1 ? 'this town' : 'each of these towns'} with a ${AREA_RADIUS_MILES} mile radius: ${listTowns(coverage.areas)}`,
          note: 'Choose people living in or recently in these places. Remove United Kingdom if Facebook added it.',
        };
  return RECIPE_ITEMS.map((item) => (item.id === 'location' ? location : item));
}

function listTowns(areas: readonly string[]): string {
  const n = areas.map((a) => String(a).replace(/\s+/g, ' ').trim()).filter(Boolean);
  // A district label has its own comma ("Lenton, Nottingham"), so such a list is split with semicolons.
  const sep = n.some((x) => x.includes(',')) ? '; ' : ', ';
  return n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(sep)} and ${n[n.length - 1]}`;
}

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
