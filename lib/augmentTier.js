// Maps an augment icon path to a trait-style tier number:
// Same numbering as Riot's trait `style`: 2 = silver, 3 = gold, 4 = prismatic, 0 = unknown.
//
// CommunityDragon icon paths are lowercase ("promisedprotection_ii.tex"), so
// matching must be case-insensitive. Most augments end in a Roman numeral
// (_i/_ii/_iii); the Set 18 "DA_" trait augments use placeholder icons named
// "missing-t1/t2/t3" instead, which encode the same tier.
export function extractAugmentTier(iconPath) {
  if (!iconPath) return 0;
  const fileName = iconPath.split('/').pop() ?? '';
  const base = (fileName.split('.')[0] ?? '').toLowerCase();

  const roman = base.match(/_(i{1,3})$/);
  const placeholder = base.match(/^missing-t([123])$/);
  const level = roman ? roman[1].length : placeholder ? Number(placeholder[1]) : 0;

  if (level === 3) return 4; // prismatic/chromatic
  if (level === 2) return 3; // gold
  if (level === 1) return 2; // silver
  return 0;
}
