import { NextResponse } from 'next/server';
import { getCache, setCache, getPuuidMapping, setPuuidMapping, getRankHistory, appendRankSnapshot, type CachedMatch, type PlayerCache, type RankSnapshot } from '@/lib/matchCache';
import { getTftNameMaps, lookupDisplayName, lookupIconUrl, lookupAugmentTier, type TftNameMaps } from '@/lib/tftData';
import { formatChampionName, formatItemName, formatAugmentName, formatTraitName } from '@/lib/tftFormat';

type RiotLeagueEntry = {
  queueType?: string;
  tier?: string;
  rank?: string;
  leaguePoints?: number;
  wins?: number;
  losses?: number;
};

type RiotTrait = {
  name?: string;
  num_units?: number;
  style?: number;
  tier_current?: number;
  tier_total?: number;
};

type RiotUnit = {
  character_id?: string;
  name?: string;
  traits?: string[];
  tier?: number;
  rarity?: number;
  itemNames?: string[];
  items?: number[];
  chosen?: string;
};

type RiotAugment = string | { apiName?: string; name?: string };

type RiotParticipant = {
  puuid: string;
  placement: number;
  units?: RiotUnit[];
  traits?: RiotTrait[];
  augments?: RiotAugment[];
  gold_left?: number;
  last_round?: number;
  level?: number;
  players_eliminated?: number;
  time_eliminated?: number;
  total_damage_to_players?: number;
};

type RiotMatch = {
  metadata: { match_id: string };
  info: {
    game_length: number;
    queue_id?: number;
    tft_set_core_name?: string;
    participants: RiotParticipant[];
    game_datetime?: number;
  };
};

function getRegionHost(region: string) {
  const normalized = region.toLowerCase();
  if (['na1', 'br1', 'la1', 'la2', 'oc1'].includes(normalized)) return normalized;
  return normalized;
}

function getRouting(region: string) {
  const normalized = region.toLowerCase();

  if (['na1', 'br1', 'la1', 'la2', 'oc1'].includes(normalized)) return 'americas';
  if (['eun1', 'euw1', 'tr1', 'ru'].includes(normalized)) return 'europe';
  if (['kr', 'jp1'].includes(normalized)) return 'asia';

  return 'americas';
}

function normalizeAugmentApiNames(augments: RiotParticipant['augments'] | undefined): string[] {
  if (!Array.isArray(augments)) return [];
  return augments
    .map((augment) => {
      if (typeof augment === 'string') return augment;
      if (augment && typeof augment === 'object') {
        const maybeApiName = 'apiName' in augment ? augment.apiName : undefined;
        const maybeName = 'name' in augment ? augment.name : undefined;
        return typeof maybeApiName === 'string' && maybeApiName ? maybeApiName : typeof maybeName === 'string' ? maybeName : '';
      }
      return '';
    })
    .filter((value): value is string => Boolean(value));
}

// League-v1 (by-puuid) is platform-routed (na1/euw1/etc, same as the `region`
// query param) rather than the account-routing (americas/europe/asia) used
// for match/account lookups. Riot's public match-v1 API has no per-match LP
// delta at all, so this snapshot of current standing is the only ranked data
// available — history/gain-loss tracking is built by diffing snapshots over
// time (see appendRankSnapshot in lib/matchCache.ts).
async function fetchRankedSnapshot(region: string, puuid: string, apiKey: string): Promise<RankSnapshot | null> {
  try {
    const host = getRegionHost(region);
    const response = await fetch(
      `https://${host}.api.riotgames.com/tft/league/v1/by-puuid/${puuid}`,
      { headers: { 'X-Riot-Token': apiKey, Accept: 'application/json' }, cache: 'no-store' },
    );
    if (!response.ok) {
      console.warn('[riot-route] league lookup failed', { region, status: response.status });
      return null;
    }
    const entries = (await response.json()) as RiotLeagueEntry[];
    const ranked = entries.find((entry) => entry.queueType === 'RANKED_TFT');
    if (!ranked || !ranked.tier || !ranked.rank) return null;

    return {
      tier: ranked.tier,
      rank: ranked.rank,
      leaguePoints: ranked.leaguePoints ?? 0,
      wins: ranked.wins ?? 0,
      losses: ranked.losses ?? 0,
      capturedAt: Date.now(),
    };
  } catch (err) {
    console.warn('[riot-route] league lookup threw', err);
    return null;
  }
}

// Shared mapping from a raw Riot match + the tracked player's puuid into the
// CachedMatch shape we persist. Pulls in everything the public match-v1
// response actually exposes: itemization, augments picked, traits (with
// tier progress), and end-of-game round stats (level, gold left, last round
// survived, damage dealt, players eliminated, time eliminated). Riot's public
// API does not expose a round-by-round event/combat log — only these
// end-of-match aggregates are available.
//
// Riot's apiName ids (e.g. "TFT17_ShieldTank", "TFT13_Augment_BruiserCrown")
// frequently have NO textual relationship to their in-client display name
// ("Vanguard", "Bruiser Crown") — regex cleanup can't recover that. When
// `nameMaps` (from CommunityDragon, see lib/tftData.ts) has an entry we use
// the real display name; otherwise we fall back to the best-effort regex
// formatter so the app still works if that lookup is unavailable.
function toCachedMatch(match: RiotMatch, puuid: string, nameMaps: TftNameMaps | null): CachedMatch {
  const participant = match.info.participants.find((p) => p.puuid === puuid);
  const champions = (participant?.units ?? [])
    .map((u) => {
      const itemApiNames = Array.isArray(u.itemNames) ? u.itemNames : [];
      const items = itemApiNames.length > 0
        ? itemApiNames.map((item) => lookupDisplayName(nameMaps, 'items', item, formatItemName(item)))
        : Array.isArray(u.items)
          ? u.items.map((item) => String(item))
          : [];
      const itemIcons = itemApiNames.length > 0
        ? itemApiNames.map((item) => lookupIconUrl(nameMaps, 'items', item) ?? null)
        : [];
      return {
        id: u.character_id ?? '',
        name: lookupDisplayName(nameMaps, 'champions', u.character_id, formatChampionName(u.character_id)),
        traits: Array.isArray(u.traits) ? u.traits : [],
        items,
        itemIcons,
        icon: lookupIconUrl(nameMaps, 'champions', u.character_id),
        tier: u.tier,
        rarity: u.rarity,
        chosen: u.chosen,
      };
    })
    .filter((c) => c.id && c.name !== 'Unknown');

  const traits = (participant?.traits ?? []).map((t) => ({
    name: lookupDisplayName(nameMaps, 'traits', t.name, formatTraitName(t.name)),
    icon: lookupIconUrl(nameMaps, 'traits', t.name) ?? null,
    style: t.style,
    num_units: t.num_units,
    tier_current: t.tier_current,
    tier_total: t.tier_total,
  }));

  const augmentApiNames = normalizeAugmentApiNames(participant?.augments);
  const augmentDisplayNames = augmentApiNames.map((a) => lookupDisplayName(nameMaps, 'items', a, formatAugmentName(a)));
  const augmentIcons = augmentApiNames.map((a) => lookupIconUrl(nameMaps, 'items', a) ?? null);
  const augmentTiers = augmentApiNames.map((a) => lookupAugmentTier(nameMaps, a));

  return {
    id: match.metadata.match_id,
    durationMinutes: match.info.game_length / 60,
    placement: participant?.placement ?? 0,
    queue: queueLabel(match.info.queue_id),
    patch: match.info.tft_set_core_name ?? 'Unknown set',
    champions,
    traits,
    augments: augmentDisplayNames,
    augmentIcons,
    augmentTiers,
    level: participant?.level,
    goldLeft: participant?.gold_left,
    lastRound: participant?.last_round,
    timeEliminated: participant?.time_eliminated,
    playersEliminated: participant?.players_eliminated,
    totalDamageToPlayers: participant?.total_damage_to_players,
    playedAt: match.info.game_datetime ?? 0,
  };
}

function queueLabel(queueId?: number) {
  if (queueId === 1100) return 'Ranked TFT';
  if (queueId === 1090) return 'Normal TFT';
  return 'TFT Match';
}

// Stable key for the Riot ID → PUUID mapping, independent of the (rotating) API key.
function buildNameKey(region: string, summoner: string) {
  return `${region.toLowerCase()}:${summoner.toLowerCase()}`;
}

async function cacheFallbackResponse(region: string, puuid: string, cache: PlayerCache, warning?: string) {
  const { summary, matches } = summarizeMatches(cache.matches);
  const rankHistory = await getRankHistory(puuid).catch(() => []);
  return NextResponse.json({
    summoner: cache.displayName,
    region,
    source: 'cache',
    ...(warning ? { warning } : {}),
    totalKnownGames: cache.cachedMatchIds.length,
    cachedGames: cache.matches.length,
    isCaughtUp: cache.cachedMatchIds.length <= cache.matches.length,
    lastFetchedAt: cache.lastFetchedAt,
    summary,
    matches,
    rank: rankHistory[rankHistory.length - 1] ?? null,
    rankHistory,
  });
}

function summarizeMatches(matches: CachedMatch[]) {
  const sorted = [...matches].sort((a, b) => b.playedAt - a.playedAt);

  const totalGames = sorted.length;
  const totalMinutes = sorted.reduce((sum, m) => sum + m.durationMinutes, 0);
  const totalPlacement = sorted.reduce((sum, m) => sum + m.placement, 0);
  const wins = sorted.filter((m) => m.placement === 1).length;

  const championCounts = new Map<string, number>();
  for (const match of sorted) {
    for (const champ of match.champions) {
      championCounts.set(champ.name, (championCounts.get(champ.name) ?? 0) + 1);
    }
  }

  const topChampion = [...championCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Unknown';

  return {
    summary: {
      totalGames,
      totalHours: totalMinutes / 60,
      averagePlacement: totalGames > 0 ? totalPlacement / totalGames : 0,
      winRate: totalGames > 0 ? (wins / totalGames) * 100 : 0,
      topChampion,
    },
    matches: sorted,
  };
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const { searchParams } = new URL(request.url);
  const summoner = searchParams.get('summoner') ?? 'SamplePlayer';
  const region = searchParams.get('region') ?? 'na1';
  const mode = searchParams.get('mode') ?? 'auto';
  const apiKey = process.env.RIOT_API_KEY;

  console.info('[riot-route] start', { summoner, region, hasKey: Boolean(apiKey), url: request.url });

  // ── DB-first: resolve the PUUID from Redis (no API call needed) so a demo
  // still works with cached data even when the daily-rotated API key is expired.
  const nameKey = buildNameKey(region, summoner);
  const mapping = await getPuuidMapping(nameKey);
  const fallbackCache = mapping ? await getCache(mapping.puuid) : null;
  const hasCachedData = Boolean(
    fallbackCache && (fallbackCache.matches.length > 0 || fallbackCache.cachedMatchIds.length > 0),
  );
  const needsAugmentBackfill = Boolean(
    apiKey &&
    fallbackCache &&
    hasCachedData &&
    fallbackCache.matches.some((match) => match.augments === undefined || match.augmentIcons === undefined || match.augmentTiers === undefined),
  );

  // The default action (mode=auto) normally serves cached data straight from
  // Redis, but older cached rows can be missing augment fields entirely. In
  // that case we should refresh once from Riot so the UI can render augment
  // images/text for those existing matches instead of leaving them blank.
  if (mode === 'auto' && fallbackCache && hasCachedData && !needsAugmentBackfill) {
    console.info('[riot-route] auto mode: serving cached data, skipping Riot API', { summoner, region });
    return cacheFallbackResponse(region, mapping!.puuid, fallbackCache);
  }

  if (!apiKey) {
    if (fallbackCache) {
      console.warn('[riot-route] no API key, serving cached data', { summoner, region });
      return cacheFallbackResponse(region, mapping!.puuid, fallbackCache, 'RIOT_API_KEY is not configured on the server — showing cached data from Redis.');
    }
    return NextResponse.json({
      summoner,
      region,
      source: 'demo',
      error: 'RIOT_API_KEY is not configured on the server.',
      summary: { totalGames: 0, totalHours: 0, averagePlacement: 0, winRate: 0, topChampion: 'Unknown' },
      matches: [],
    }, { status: 500 });
  }

  try {
    const routing = getRouting(region);

    let puuid: string;
    let displayName: string;

    if (mapping) {
      // Already know the PUUID for this Riot ID from a previous lookup — skip
      // the identity API call entirely so refresh/fetch-missing don't burn a
      // request against the daily-rotated key when they don't need one.
      puuid = mapping.puuid;
      displayName = mapping.displayName;
      console.info('[riot-route] puuid resolved from cache mapping', { summoner, puuid: puuid.slice(0, 8) + '…' });
    } else if (summoner.indexOf('#') !== -1) {
      // Riot IDs are "gameName#tagLine". Use the Account API to resolve a PUUID first.
      const hashIndex = summoner.indexOf('#');
      const gameName = summoner.slice(0, hashIndex);
      const tagLine = summoner.slice(hashIndex + 1);

      const accountResponse = await fetch(
        `https://${routing}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
        {
          headers: { 'X-Riot-Token': apiKey, Accept: 'application/json' },
          cache: 'no-store',
        },
      );

      if (!accountResponse.ok) {
        const errorText = await accountResponse.text();
        const isForbidden = accountResponse.status === 403;
        const message = isForbidden
          ? 'Riot API rejected the request with 403 Forbidden. The API key may be invalid or expired.'
          : `Account lookup failed (${accountResponse.status} ${accountResponse.statusText}): ${errorText}`;
        console.error('[riot-route] account lookup failed', { summoner, region, status: accountResponse.status, responseBody: errorText });
        throw new Error(message);
      }

      const accountData = await accountResponse.json() as { puuid: string; gameName: string; tagLine: string };
      puuid = accountData.puuid;
      displayName = `${accountData.gameName}#${accountData.tagLine}`;
      console.info('[riot-route] account resolved', { summoner, puuid: puuid.slice(0, 8) + '…', displayName });
    } else {
      // Legacy summoner name fallback (no hashtag)
      const summonerHost = getRegionHost(region);
      const summonerResponse = await fetch(
        `https://${summonerHost}.api.riotgames.com/tft/summoner/v1/summoners/by-name/${encodeURIComponent(summoner)}`,
        {
          headers: { 'X-Riot-Token': apiKey, Accept: 'application/json' },
          cache: 'no-store',
        },
      );

      if (!summonerResponse.ok) {
        const errorText = await summonerResponse.text();
        const isForbidden = summonerResponse.status === 403;
        const message = isForbidden
          ? 'Riot API rejected the request with 403 Forbidden. The API key may be invalid or expired.'
          : `Summoner lookup failed (${summonerResponse.status} ${summonerResponse.statusText}): ${errorText}`;
        console.error('[riot-route] summoner lookup failed', { summoner, region, status: summonerResponse.status, responseBody: errorText, isForbidden });
        throw new Error(message);
      }

      const summonerData = await summonerResponse.json() as { puuid: string; name?: string };
      puuid = summonerData.puuid;
      displayName = summonerData.name ?? summoner;
    }

    // Persist the Riot ID → PUUID mapping so future requests can serve cached
    // data straight from Redis even if the API key has since expired.
    if (!mapping) {
      await setPuuidMapping(nameKey, { puuid, displayName });
    }

    // ── Ranked snapshot ────────────────────────────────────────────────────
    // Every time we actually talk to Riot, also grab the current League
    // standing and append it to history (a no-op write if unchanged from the
    // last snapshot) so the frontend can chart LP gain/loss over time.
    const rankSnapshot = await fetchRankedSnapshot(region, puuid, apiKey);
    const rankHistory = rankSnapshot ? await appendRankSnapshot(puuid, rankSnapshot) : await getRankHistory(puuid);
    const rank = rankHistory[rankHistory.length - 1] ?? null;

    // ── Load cache ───────────────────────────────────────────────────────────
    const cached = await getCache(puuid);
    const cachedIdSet = new Set(cached?.cachedMatchIds ?? []);
    const cachedMatchIds = cached?.cachedMatchIds ?? [];
    const detailMatchIds = new Set((cached?.matches ?? []).map((match) => match.id));
    const missingDetailIds = cachedMatchIds.filter((id) => !detailMatchIds.has(id));

    if (mode === 'fetch-missing') {
      const BATCH_SIZE = 10;
      const BATCH_DELAY_MS = 1100;
      const toFetch = missingDetailIds.slice(0, 90);

      if (!toFetch.length) {
        const { summary, matches: playerMatches } = summarizeMatches(cached?.matches ?? []);
        return NextResponse.json({
          summoner: displayName,
          region,
          source: 'riot',
          totalKnownGames: cachedMatchIds.length,
          cachedGames: (cached?.matches ?? []).length,
          missingDetailIds: 0,
          isCaughtUp: true,
          fetchedNewGames: 0,
          summary,
          matches: playerMatches,
          rank,
          rankHistory,
        });
      }

      const fetchMatchDetail = (matchId: string): Promise<RiotMatch> =>
        fetch(`https://${routing}.api.riotgames.com/tft/match/v1/matches/${matchId}`, {
          headers: { 'X-Riot-Token': apiKey, Accept: 'application/json' },
          cache: 'no-store',
        }).then(async (r) => {
          if (!r.ok) {
            const body = await r.text();
            throw new Error(`Match detail lookup failed (${r.status} ${r.statusText}): ${body}`);
          }
          return r.json() as Promise<RiotMatch>;
        });

      const newRiotMatches: RiotMatch[] = [];
      for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
        const batch = toFetch.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(fetchMatchDetail));
        newRiotMatches.push(...results);
        if (i + BATCH_SIZE < toFetch.length) {
          await new Promise<void>((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
        }
      }

      const nameMaps = await getTftNameMaps().catch(() => null);
      const newCached: CachedMatch[] = newRiotMatches.map((match) => toCachedMatch(match, puuid, nameMaps));

      const mergedMatches = [...newCached, ...(cached?.matches ?? [])];
      await setCache(puuid, {
        displayName,
        cachedMatchIds: cachedMatchIds,
        matches: mergedMatches,
        lastFetchedAt: Date.now(),
      });

      const { summary, matches: playerMatches } = summarizeMatches(mergedMatches);
      return NextResponse.json({
        summoner: displayName,
        region,
        source: 'riot',
        totalKnownGames: cachedMatchIds.length,
        cachedGames: mergedMatches.length,
        missingDetailIds: Math.max(0, missingDetailIds.length - toFetch.length),
        fetchedNewGames: newCached.length,
        isCaughtUp: missingDetailIds.length <= toFetch.length,
        summary,
        matches: playerMatches,
        rank,
        rankHistory,
      });
    }

    // ── Fetch fresh match ID list (most-recent-first, paginated) ─────────────
    const allMatchIds: string[] = [];
    const PAGE_SIZE = 200;
    const DETAIL_LIMIT = 90;
    const MAX_PAGES_PER_RUN = 4;
    const RIOT_RATE_LIMIT_DELAY_MS = 1100;
    const BACKFILL_COOLDOWN_BUFFER_MS = 1000;
    const BACKFILL_COOLDOWN_MS = RIOT_RATE_LIMIT_DELAY_MS + BACKFILL_COOLDOWN_BUFFER_MS;
    let pageStart = 0;
    let collectedNewIds = 0;

    while (true) {
      const matchIdsResponse = await fetch(
        `https://${routing}.api.riotgames.com/tft/match/v1/matches/by-puuid/${puuid}/ids?start=${pageStart}&count=${PAGE_SIZE}`,
        { headers: { 'X-Riot-Token': apiKey, Accept: 'application/json' }, cache: 'no-store' },
      );
      if (!matchIdsResponse.ok) {
        const errorText = await matchIdsResponse.text();
        throw new Error(`Match history lookup failed (${matchIdsResponse.status} ${matchIdsResponse.statusText}): ${errorText}`);
      }
      const page = (await matchIdsResponse.json()) as string[];
      allMatchIds.push(...page);
      const pageNewIds = page.filter((id) => !cachedIdSet.has(id));
      collectedNewIds += pageNewIds.length;

      if (
        page.length < PAGE_SIZE ||
        collectedNewIds >= DETAIL_LIMIT ||
        pageStart >= (MAX_PAGES_PER_RUN - 1) * PAGE_SIZE
      ) {
        break;
      }

      pageStart += PAGE_SIZE;
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    }

    // ── Find IDs not yet in cache ─────────────────────────────────────────────
    const newIds = allMatchIds.filter((id) => !cachedIdSet.has(id));
    console.info('[riot-route] id diff', {
      total: allMatchIds.length,
      cached: cachedIdSet.size,
      newToFetch: newIds.length,
    });

    // ── Fetch only the newly discovered match details, in batches.
    // This keeps the history incremental and cache-friendly even when the
    // player has a long match history.
    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = BACKFILL_COOLDOWN_MS;

    const fetchMatchDetail = (matchId: string): Promise<RiotMatch> =>
      fetch(`https://${routing}.api.riotgames.com/tft/match/v1/matches/${matchId}`, {
        headers: { 'X-Riot-Token': apiKey, Accept: 'application/json' },
        cache: 'no-store',
      }).then(async (r) => {
        if (!r.ok) {
          const body = await r.text();
          throw new Error(`Match detail lookup failed (${r.status} ${r.statusText}): ${body}`);
        }
        return r.json() as Promise<RiotMatch>;
      });

    const toFetch = newIds.slice(0, DETAIL_LIMIT);
    const newRiotMatches: RiotMatch[] = [];
    for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
      const batch = toFetch.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(fetchMatchDetail));
      newRiotMatches.push(...results);
      if (i + BATCH_SIZE < toFetch.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    // ── Convert new Riot matches → CachedMatch shape ─────────────────────────
    const nameMaps = await getTftNameMaps().catch(() => null);
    const newCached: CachedMatch[] = newRiotMatches.map((match) => toCachedMatch(match, puuid, nameMaps));

    // ── Merge + persist ───────────────────────────────────────────────────────
    const mergedMatches: CachedMatch[] = [...newCached, ...(cached?.matches ?? [])];
    const mergedIds = [...new Set([...allMatchIds, ...Array.from(cachedIdSet)])];
    await setCache(puuid, {
      displayName,
      cachedMatchIds: mergedIds,
      matches: mergedMatches,
      lastFetchedAt: Date.now(),
    });

    const uncachedRemaining = Math.max(0, newIds.length - toFetch.length);
    const uncachedCount = newIds.length;
    const { summary, matches: playerMatches } = summarizeMatches(mergedMatches);

    console.info('[riot-route] success', {
      summoner,
      region,
      newFetched: newCached.length,
      totalCached: mergedMatches.length,
      uncachedRemaining,
      totalHours: summary.totalHours,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      summoner: displayName,
      region,
      source: 'riot',
      totalKnownGames: allMatchIds.length,
      cachedGames: mergedMatches.length,
      uncachedRemaining,
      uncachedCount,
      isCaughtUp: uncachedRemaining === 0,
      fetchedNewGames: newCached.length,
      cooldownMs: BACKFILL_COOLDOWN_MS,
      lastFetchedAt: cached?.lastFetchedAt ?? null,
      summary,
      matches: playerMatches,
      rank,
      rankHistory,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Riot API error';
    console.error('[riot-route] failure', { summoner, region, message, durationMs: Date.now() - startedAt });

    if (fallbackCache) {
      console.warn('[riot-route] API call failed, falling back to cached data', { summoner, region, message });
      return cacheFallbackResponse(region, mapping!.puuid, fallbackCache, `Riot API is unavailable (${message}) — showing cached data from Redis.`);
    }

    return NextResponse.json({
      summoner,
      region,
      source: 'demo',
      error: message,
      summary: { totalGames: 0, totalHours: 0, averagePlacement: 0, winRate: 0, topChampion: 'Unknown' },
      matches: [],
    }, { status: 500 });
  }
}
