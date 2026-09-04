import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeAugmentApiNames, shouldBackfillAugments } from './augmentParsing.js';

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

test('treats empty augment arrays as needing backfill', () => {
  assert.equal(shouldBackfillAugments({ augments: [], augmentIcons: [], augmentTiers: [] }), true);
  assert.equal(shouldBackfillAugments({ augments: ['TFT18_Augment_Alpha'], augmentIcons: ['https://x'], augmentTiers: [4] }), false);
});
