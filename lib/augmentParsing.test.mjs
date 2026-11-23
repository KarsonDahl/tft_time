import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAugmentApiNames } from './augmentParsing.js';

test('extracts augments from nested participant selection fields', () => {
  const participant = {
    augments: [
      { apiName: 'TFT18_Augment_Test', name: 'Test Augment' },
      { id: 'TFT18_Augment_Second', displayName: 'Second Augment' },
    ],
    selectedAugments: [{ augmentId: 'TFT18_Augment_Third', name: 'Third Augment' }],
    nested: {
      augmentSelections: [{ name: 'Fourth Augment' }],
    },
  };

  assert.deepEqual(normalizeAugmentApiNames(participant), [
    'TFT18_Augment_Test',
    'TFT18_Augment_Second',
    'TFT18_Augment_Third',
    'Fourth Augment',
  ]);
});

test('handles plain string augment values', () => {
  assert.deepEqual(normalizeAugmentApiNames({ augment: ['TFT18_Augment_Alpha'] }), ['TFT18_Augment_Alpha']);
});

test('accepts unprefixed string ids when the field is known to hold augments', () => {
  assert.deepEqual(normalizeAugmentApiNames(['DA_Something', 'TFT_Augment_X'], 'augments'), ['DA_Something', 'TFT_Augment_X']);
  assert.deepEqual(normalizeAugmentApiNames(['DA_Something']), []);
});

test('does not mistake champion, trait or item ids for augments when given only participant.augments', () => {
  const participant = {
    augments: [],
    units: [{ character_id: 'TFT17_Ahri', itemNames: ['TFT_Item_BFSword'] }],
    traits: [{ name: 'TFT17_ShieldTank' }],
  };
  assert.deepEqual(normalizeAugmentApiNames(participant.augments, 'augments'), []);
});
