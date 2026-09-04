function normalizeTier(tier) {
  const normalized = (tier ?? '').toUpperCase();
  if (normalized === 'IRON') return 1;
  if (normalized === 'BRONZE') return 2;
  if (normalized === 'SILVER') return 3;
  if (normalized === 'GOLD') return 4;
  if (normalized === 'PLATINUM') return 5;
  if (normalized === 'EMERALD') return 6;
  if (normalized === 'DIAMOND') return 7;
  if (normalized === 'MASTER' || normalized === 'GRANDMASTER' || normalized === 'CHALLENGER') return 8;
  return 0;
}

function normalizeDivision(rank) {
  const normalized = (rank ?? '').toUpperCase();
  if (normalized === 'IV') return 4;
  if (normalized === 'III') return 3;
  if (normalized === 'II') return 2;
  if (normalized === 'I') return 1;
  return 0;
}

function rankToScore(snapshot) {
  if (!snapshot) return 0;
  return normalizeTier(snapshot.tier) * 1000 + normalizeDivision(snapshot.rank) * 100 + (snapshot.leaguePoints ?? 0);
}

function resolveSnapshotForMatch(playAt, history) {
  let selected = null;

  for (const snapshot of history) {
    if ((snapshot.capturedAt ?? 0) <= playAt) {
      selected = snapshot;
      continue;
    }
    break;
  }

  return selected;
}

export function resolveRankSnapshotForMatch(playAt, history = []) {
  return resolveSnapshotForMatch(playAt, history);
}

function normalizePatchOrder(patch) {
  const value = `${patch ?? ''}`.trim();
  const match = value.match(/(?:tft|set)\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (match) return Number(match[1]);

  const numberMatch = value.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (numberMatch) return Number(numberMatch[1]);

  return value.toLowerCase();
}

export function buildRankTrendBySet(matches = [], rankHistory = [], selectedSets = []) {
  const sortedMatches = [...matches].sort((left, right) => left.playedAt - right.playedAt);
  const sortedHistory = [...rankHistory].sort((left, right) => (left.capturedAt ?? 0) - (right.capturedAt ?? 0));
  const grouped = new Map();

  for (const match of sortedMatches) {
    const patch = match.patch || 'Unknown set';
    if (selectedSets.length && !selectedSets.includes(patch)) continue;

    const snapshot = resolveRankSnapshotForMatch(match.playedAt, sortedHistory);
    const entry = grouped.get(patch) ?? { patch, points: [], peak: null };

    entry.points.push({
      id: match.id,
      patch,
      placement: match.placement,
      playedAt: match.playedAt,
      snapshot,
      rankedSnapshot: snapshot,
      score: rankToScore(snapshot),
    });

    grouped.set(patch, entry);
  }

  return Array.from(grouped.values())
    .map((group) => {
      const peak = group.points.reduce((best, point) => (point.score > (best?.score ?? -Infinity) ? point : best), null);
      return { ...group, peak };
    })
    .sort((left, right) => {
      const leftOrder = normalizePatchOrder(left.patch);
      const rightOrder = normalizePatchOrder(right.patch);
      if (leftOrder === rightOrder) {
        return right.points.length - left.points.length;
      }
      if (typeof leftOrder === 'number' && typeof rightOrder === 'number') {
        return leftOrder - rightOrder;
      }
      return String(leftOrder).localeCompare(String(rightOrder));
    });
}
