import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRankTrendBySet } from './rankTrend.js';

test('buildRankTrendBySet groups matches by set and uses the latest prior rank snapshot', () => {
  const matches = [
    { id: 'm1', patch: 'Set 10', playedAt: 100 },
    { id: 'm2', patch: 'Set 10', playedAt: 300 },
    { id: 'm3', patch: 'Set 9', playedAt: 250 },
  ];

  const rankHistory = [
    { tier: 'Gold', rank: 'IV', leaguePoints: 20, capturedAt: 50 },
    { tier: 'Platinum', rank: 'I', leaguePoints: 10, capturedAt: 250 },
  ];

  const groups = buildRankTrendBySet(matches, rankHistory, ['Set 10']);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].points.length, 2);
  assert.equal(groups[0].points[0].snapshot?.tier, 'Gold');
  assert.equal(groups[0].points[1].snapshot?.tier, 'Platinum');
  assert.equal(groups[0].peak?.snapshot?.tier, 'Platinum');
});
