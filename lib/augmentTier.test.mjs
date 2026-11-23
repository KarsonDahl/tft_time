import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAugmentTier } from './augmentTier.js';

test('lowercase roman-numeral icons map to tiers', () => {
  assert.equal(extractAugmentTier('assets/maps/tft/icons/augments/hexcore/justhit_iii.tex'), 3);
  assert.equal(extractAugmentTier('assets/maps/tft/icons/augments/hexcore/promisedprotection_ii.tex'), 4);
  assert.equal(extractAugmentTier('assets/maps/tft/icons/augments/hexcore/something_i.tex'), 2);
});

test('uppercase numerals still work', () => {
  assert.equal(extractAugmentTier('Hexcore/AcademicCitation_II.tex'), 4);
});

test('missing-tN placeholder icons map to tiers', () => {
  assert.equal(extractAugmentTier('assets/maps/tft/icons/augments/hexcore/missing-t1.tex'), 2);
  assert.equal(extractAugmentTier('assets/maps/tft/icons/augments/hexcore/missing-t2.tex'), 4);
  assert.equal(extractAugmentTier('assets/maps/tft/icons/augments/hexcore/missing-t3.tex'), 3);
});

test('unknown or missing icons return 0', () => {
  assert.equal(extractAugmentTier(undefined), 0);
  assert.equal(extractAugmentTier('assets/ux/tft/hud/zaps/wands/set18_mechanicicon.tex'), 0);
});
