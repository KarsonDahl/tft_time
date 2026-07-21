import { NextResponse } from 'next/server';
import { getCache, setCache, getPuuidMapping, setPuuidMapping, type CachedMatch, type PlayerCache } from '@/lib/matchCache';

type RiotTrait = {
  name?: string;
  num_units?: number;
  style?: number;
  tier_current?: number;
};

type RiotUnit = {
  character_id?: string;
  name?: string;
  traits?: string[];
  tier?: number;
  rarity?: number;
};

type RiotParticipant = {
  puuid: string;
  placement: number;
  units?: RiotUnit[];
  traits?: RiotTrait[];
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

function formatChampionName(characterId?: string) {
  if (!characterId) return 'Unknown';
  return characterId
    .replace(/^TFT[0-9]+_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
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

function cacheFallbackResponse(region: string, cache: PlayerCache, warning: string) {
  const { summary, matches } = summarizeMatches(cache.matches);
  return NextResponse.json({
    summoner: cache.displayName,
    region,
    source: 'cache',
    warning,
    cachedGames: cache.matches.length,
    lastFetchedAt: cache.lastFetchedAt,
    summary,
    matches,
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

  if (!apiKey) {
    if (fallbackCache) {
      console.warn('[riot-route] no API key, serving cached data', { summoner, region });
      return cacheFallbackResponse(region, fallbackCache, 'RIOT_API_KEY is not configured on the server — showing cached data from Redis.');
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

    // Riot IDs are "gameName#tagLine". Use the Account API to resolve a PUUID first.
    const hashIndex = summoner.indexOf('#');
    let puuid: string;
    let displayName: string;

    if (hashIndex !== -1) {
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
    await setPuuidMapping(nameKey, { puuid, displayName });

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

      const newCached: CachedMatch[] = newRiotMatches.map((match) => {
        const participant = match.info.participants.find((p) => p.puuid === puuid)!;
        const champions = (participant?.units ?? [])
          .map((u) => ({ id: u.character_id ?? '', name: formatChampionName(u.character_id), traits: Array.isArray(u.traits) ? u.traits : [] }))
          .filter((c) => c.id && c.name !== 'Unknown');
        return {
          id: match.metadata.match_id,
          durationMinutes: match.info.game_length / 60,
          placement: participant?.placement ?? 0,
          queue: queueLabel(match.info.queue_id),
          patch: match.info.tft_set_core_name ?? 'Unknown set',
          champions,
          traits: participant?.traits ?? [],
          playedAt: match.info.game_datetime ?? 0,
        };
      });

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
    const newCached: CachedMatch[] = newRiotMatches.map((match) => {
      const participant = match.info.participants.find((p) => p.puuid === puuid)!;
      const champions = (participant?.units ?? [])
        .map((u) => ({
          id: u.character_id ?? '',
          name: formatChampionName(u.character_id),
          traits: Array.isArray(u.traits) ? u.traits : [],
        }))
        .filter((c) => c.id && c.name !== 'Unknown');
      return {
        id: match.metadata.match_id,
        durationMinutes: match.info.game_length / 60,
        placement: participant?.placement ?? 0,
        queue: queueLabel(match.info.queue_id),
        patch: match.info.tft_set_core_name ?? 'Unknown set',
        champions,
        traits: participant?.traits ?? [],
        playedAt: match.info.game_datetime ?? 0,
      };
    });

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
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Riot API error';
    console.error('[riot-route] failure', { summoner, region, message, durationMs: Date.now() - startedAt });

    if (fallbackCache) {
      console.warn('[riot-route] API call failed, falling back to cached data', { summoner, region, message });
      return cacheFallbackResponse(region, fallbackCache, `Riot API is unavailable (${message}) — showing cached data from Redis.`);
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
