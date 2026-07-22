'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type MatchSummary = {
  id: string;
  durationMinutes: number;
  placement: number;
  queue: string;
  patch: string;
  champions: Array<{
    id: string;
    name: string;
    traits?: string[];
    items?: string[];
    tier?: number;
    rarity?: number;
    chosen?: string;
  }>;
  traits?: Array<{ name?: string; num_units?: number; style?: number; tier_current?: number; tier_total?: number }>;
  augments?: string[];
  level?: number;
  goldLeft?: number;
  lastRound?: number;
  timeEliminated?: number;
  playersEliminated?: number;
  totalDamageToPlayers?: number;
  playedAt: number;
};

type ApiResponse = {
  summoner: string;
  region: string;
  source: 'demo' | 'riot' | 'cache';
  warning?: string;
  totalKnownGames?: number;
  summary: {
    totalGames: number;
    totalHours: number;
    averagePlacement: number;
    winRate: number;
    topChampion: string;
  };
  matches: MatchSummary[];
  isCaughtUp?: boolean;
  cachedGames?: number;
  fetchedNewGames?: number;
  uncachedRemaining?: number;
  cooldownMs?: number;
};

function placementLabel(n: number): string {
  if (n === 1) return '1st';
  if (n === 2) return '2nd';
  if (n === 3) return '3rd';
  return `${n}th`;
}

function placementBadgeClass(n: number): string {
  if (n === 1) return 'bg-yellow-400 text-yellow-900';
  if (n === 2) return 'bg-slate-300 text-slate-800';
  if (n === 3) return 'bg-amber-700 text-amber-100';
  if (n === 4) return 'bg-green-500 text-white';
  if (n === 5) return 'bg-lime-400 text-lime-900';
  if (n === 6) return 'bg-yellow-300 text-yellow-900';
  if (n === 7) return 'bg-orange-500 text-white';
  return 'bg-red-600 text-white';
}

function formatDuration(minutes: number): string {
  const totalSeconds = Math.round(minutes * 60);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

function championIconId(characterId: string): string {
  return characterId.replace(/^TFT\d+_/i, '').toLowerCase();
}

function formatPlayedAt(timestamp: number): string {
  if (!timestamp) return 'Date unavailable';
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function traitStyleClass(style?: number): string {
  if (style === 4) return 'bg-fuchsia-400 text-fuchsia-950';
  if (style === 3) return 'bg-yellow-400 text-yellow-900';
  if (style === 2) return 'bg-slate-300 text-slate-800';
  if (style === 1) return 'bg-amber-700 text-amber-100';
  return 'bg-base-200 text-base-content/70';
}

export default function Home() {
  const [summoner, setSummoner] = useState('SamplePlayer');
  const [region, setRegion] = useState('na1');
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Ready to load your TFT stats.');
  const [error, setError] = useState('');
  const [data, setData] = useState<ApiResponse | null>(null);
  const [selectedSets, setSelectedSets] = useState<string[]>([]);
  const [trackingMore, setTrackingMore] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const retryTimerRef = useRef<number | null>(null);

  async function loadStats(mode: 'auto' | 'fetch-missing' | 'refresh' = 'auto') {
    if (retryTimerRef.current) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    setLoading(true);
    setError('');
    setStatusMessage(mode === 'auto' ? 'Checking cached stats…' : 'Checking Riot for new games…');

    try {
      setTrackingMore(mode === 'fetch-missing');
      const response = await fetch(`/api/riot?summoner=${encodeURIComponent(summoner)}&region=${encodeURIComponent(region)}&mode=${mode}`, {
        cache: 'no-store',
      });

      setStatusMessage('Loading match history…');
      const json = (await response.json()) as ApiResponse & { error?: string };
      if (!response.ok || json.error) {
        const message = json.error ?? 'Unable to load Riot stats right now.';
        const isForbidden = message.toLowerCase().includes('403') || message.toLowerCase().includes('forbidden');
        throw new Error(
          isForbidden
            ? 'Riot rejected this request (403 Forbidden). The API key may be invalid, expired, or not authorized for this region. Regenerate the key and redeploy the app, then try again.'
            : message,
        );
      }

      setStatusMessage('Compiling your TFT stats…');
      setData(json);
      setStatusMessage('Stats ready.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStatusMessage('Unable to finish the request.');
    } finally {
      setLoading(false);
      setTrackingMore(false);
    }
  }

  function formatSummonerLabel(value: string) {
    return value.replace(/#/, ' #');
  }

  function cacheStatusMessage(data: ApiResponse | null) {
    if (!data) return 'No stats loaded yet.';

    if (data.source === 'cache') {
      return 'Served straight from the Redis cache — Riot API was not called.';
    }

    if (data.isCaughtUp) {
      return 'History is caught up — all currently available games are cached.';
    }

    const remaining = data.uncachedRemaining ?? 0;
    return remaining > 0
      ? `More games are still being fetched from Riot (${remaining} unseen match${remaining === 1 ? '' : 'es'} remaining).`
      : 'Checking for newly available games…';
  }

  useEffect(() => {
    if (!data || !data.uncachedRemaining || data.uncachedRemaining <= 0 || loading) {
      setCooldownSeconds(0);
      return;
    }

    const delay = Math.max(data.cooldownMs ?? 2100, 2100);
    setCooldownSeconds(Math.ceil(delay / 1000));

    if (retryTimerRef.current) return;

    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      // Use 'refresh' (not 'auto') so this continuation keeps talking to Riot
      // to finish a multi-page backfill instead of being short-circuited by
      // the cache-first check that 'auto' does once data already exists.
      void loadStats('refresh');
    }, delay);

    return () => {
      if (retryTimerRef.current) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [data, loading]);

  const setSummaries = useMemo(() => {
    if (!data?.matches?.length) return [];

    const grouped = new Map<string, { patch: string; totalGames: number; totalMinutes: number; topChampion: string; counts: Map<string, number> }>();

    for (const match of data.matches) {
      const patch = match.patch || 'Unknown set';
      const bucket = grouped.get(patch) ?? { patch, totalGames: 0, totalMinutes: 0, topChampion: 'Unknown', counts: new Map<string, number>() };
      bucket.totalGames += 1;
      bucket.totalMinutes += match.durationMinutes;
      for (const champ of match.champions) {
        bucket.counts.set(champ.name, (bucket.counts.get(champ.name) ?? 0) + 1);
      }
      bucket.topChampion = [...bucket.counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Unknown';
      grouped.set(patch, bucket);
    }

    return [...grouped.values()].map((entry) => ({
      patch: entry.patch,
      totalGames: entry.totalGames,
      totalHours: entry.totalMinutes / 60,
      topChampion: entry.topChampion,
    }));
  }, [data]);

  useEffect(() => {
    if (!setSummaries.length) {
      setSelectedSets([]);
      return;
    }

    setSelectedSets((current) => {
      const available = setSummaries.map((entry) => entry.patch);
      const valid = current.filter((patch) => available.includes(patch));
      return valid.length ? valid : available;
    });
  }, [setSummaries]);

  const filteredMatches = useMemo(() => {
    if (!data?.matches?.length) return [];
    if (!selectedSets.length) return [];
    return data.matches.filter((match) => selectedSets.includes(match.patch || 'Unknown set'));
  }, [data, selectedSets]);

  const filteredSummary = useMemo(() => {
    if (!filteredMatches.length) return null;

    const totalMinutes = filteredMatches.reduce((sum, match) => sum + match.durationMinutes, 0);
    const totalPlacement = filteredMatches.reduce((sum, match) => sum + match.placement, 0);
    const wins = filteredMatches.filter((match) => match.placement === 1).length;

    return {
      totalGames: filteredMatches.length,
      totalHours: totalMinutes / 60,
      averagePlacement: totalPlacement / filteredMatches.length,
      winRate: (wins / filteredMatches.length) * 100,
      topChampion: (() => {
        const counts = new Map<string, number>();
        for (const match of filteredMatches) {
          for (const champ of match.champions) {
            counts.set(champ.name, (counts.get(champ.name) ?? 0) + 1);
          }
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Unknown';
      })(),
    };
  }, [filteredMatches]);

  const summaryCards = useMemo(
    () => [
      ['Total Hours', data?.summary.totalHours.toFixed(1) ?? '0.0'],
      ['Games Tracked', data
        ? (data.totalKnownGames && data.totalKnownGames > data.summary.totalGames
          ? `${data.summary.totalGames} / ${data.totalKnownGames}`
          : String(data.summary.totalGames))
        : '0'],
      ['Average Placement', data ? data.summary.averagePlacement.toFixed(2) : '—'],
      ['Win Rate', data ? `${data.summary.winRate.toFixed(1)}%` : '—'],
    ],
    [data],
  );

  return (
    <main className="min-h-screen bg-base-200 text-base-content">
      <section className="mx-auto flex min-h-screen max-w-7xl flex-col gap-8 px-6 py-10 lg:px-10">
        <header className="rounded-3xl bg-base-100 p-8 shadow-xl">
          <p className="text-sm uppercase tracking-[0.35em] text-primary">TFT Time</p>
          <h1 className="mt-3 text-4xl font-black md:text-5xl">Track your TFT hours, placements, and progress.</h1>
          <p className="mt-4 max-w-3xl text-base-content/80">
            This dashboard now loads a Riot stats response through the app route, with a demo fallback until your API key is configured.
          </p>
        </header>

        <article className="rounded-3xl bg-base-100 p-6 shadow-xl">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-xl font-semibold">Search TFT stats</h2>
              <p className="text-sm text-base-content/70">Enter a summoner name to pull the latest time-based summary.</p>
            </div>
            <div className="flex flex-col gap-3 lg:flex-row">
              <input
                value={summoner}
                onChange={(event) => setSummoner(event.target.value)}
                className="input input-bordered w-full lg:w-80"
                placeholder="Summoner name"
              />
              <select
                value={region}
                onChange={(event) => setRegion(event.target.value)}
                className="select select-bordered w-full lg:w-40"
              >
                <option value="na1">NA</option>
                <option value="euw1">EUW</option>
                <option value="eun1">EUNE</option>
                <option value="kr">KR</option>
                <option value="jp1">JP</option>
                <option value="br1">BR</option>
                <option value="la1">LAN</option>
                <option value="la2">LAS</option>
                <option value="oc1">OC</option>
                <option value="tr1">TR</option>
                <option value="ru">RU</option>
              </select>
              <button className="btn btn-primary" onClick={() => void loadStats('auto')} disabled={loading}>
                {loading ? 'Loading…' : 'Load stats'}
              </button>
              <button
                className="btn btn-outline"
                onClick={() => void loadStats('refresh')}
                disabled={loading}
                title="Ask Riot for brand-new games beyond what's cached"
              >
                Check Riot for new games
              </button>
              <button
                className="btn btn-outline btn-secondary"
                onClick={() => void loadStats('fetch-missing')}
                disabled={loading || !data || (data.totalKnownGames ?? 0) <= (data.summary?.totalGames ?? 0)}
              >
                {trackingMore ? 'Tracking more…' : 'Track more matches'}
              </button>
            </div>
          </div>
          {error ? <p className="mt-4 text-sm text-error">{error}</p> : null}
          <p className="mt-3 text-sm text-base-content/70">{loading ? 'Status: ' + statusMessage : statusMessage}</p>
        </article>

        <section className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
          {summaryCards.map(([label, value]) => (
            <article key={label} className="rounded-3xl bg-base-100 p-6 shadow-xl">
              <p className="text-sm text-base-content/70">{label}</p>
              <p className="mt-3 text-3xl font-bold">{value}</p>
            </article>
          ))}
        </section>

        <section className="flex flex-col gap-6">
          <article className="rounded-3xl bg-base-100 p-6 shadow-xl">
            <h2 className="text-xl font-semibold">Time Tracking Focus</h2>
            <ul className="mt-4 space-y-3 text-sm text-base-content/80">
              <li>• Total hours played</li>
              <li>• Daily, weekly, and monthly time summaries</li>
              <li>• Placement trends and win rate</li>
              <li>• Champion and queue breakdowns</li>
            </ul>
            <div className="mt-6 rounded-2xl border border-base-300 bg-base-200 p-4 text-sm">
              <p className="font-semibold">Top champion</p>
              <p className="mt-1 text-base-content/80">{data?.summary.topChampion ?? 'Waiting for a search result…'}</p>
            </div>
            {filteredSummary && (
              <div className="mt-6 rounded-2xl border border-base-300 bg-base-200 p-4 text-sm">
                <p className="font-semibold">Selected set summary</p>
                <ul className="mt-2 space-y-1 text-base-content/80">
                  <li>Games: {filteredSummary.totalGames}</li>
                  <li>Hours: {filteredSummary.totalHours.toFixed(1)}</li>
                  <li>Avg placement: {filteredSummary.averagePlacement.toFixed(2)}</li>
                  <li>Win rate: {filteredSummary.winRate.toFixed(1)}%</li>
                  <li>Top champion: {filteredSummary.topChampion}</li>
                </ul>
              </div>
            )}
            {setSummaries.length > 0 && (
              <div className="mt-6 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold">Set breakdown</p>
                  <button
                    type="button"
                    className="btn btn-xs btn-ghost"
                    onClick={() => setSelectedSets(setSummaries.map((entry) => entry.patch))}
                  >
                    All sets
                  </button>
                </div>
                <p className="text-xs text-base-content/60">Choose one or more sets to filter the session list below.</p>
                <div className="flex flex-wrap gap-2">
                  {setSummaries.map((entry) => {
                    const checked = selectedSets.includes(entry.patch);
                    return (
                      <label key={entry.patch} className="flex cursor-pointer items-center gap-2 rounded-full border border-base-300 bg-base-200 px-3 py-2 text-xs font-medium text-base-content/80">
                        <input
                          type="checkbox"
                          className="checkbox checkbox-xs"
                          checked={checked}
                          onChange={() =>
                            setSelectedSets((current) =>
                              current.includes(entry.patch)
                                ? current.filter((patch) => patch !== entry.patch)
                                : [...current, entry.patch],
                            )
                          }
                        />
                        {entry.patch} ({entry.totalGames})
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </article>

          <article className="rounded-3xl bg-base-100 p-6 shadow-xl">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">Recent TFT Sessions</h2>
              <span className="badge badge-secondary">{data?.source ?? 'demo'}</span>
            </div>
            <p className="mt-2 text-sm text-base-content/70">
              {data ? `${formatSummonerLabel(data.summoner)} • ${data.region.toUpperCase()}` : 'No stats loaded yet.'}
            </p>
            {data?.warning ? (
              <p className="mt-2 text-xs text-warning">{data.warning}</p>
            ) : null}
            <p className="mt-2 text-xs text-base-content/60">{cacheStatusMessage(data)}</p>
            {cooldownSeconds > 0 ? (
              <p className="mt-2 text-xs text-base-content/60">Cooldown: next backfill in {cooldownSeconds} second{cooldownSeconds === 1 ? '' : 's'}.</p>
            ) : null}
            <p className="mt-2 text-xs text-base-content/60">
              {selectedSets.length
                ? `Showing ${filteredMatches.length} of ${data?.matches?.length ?? 0} games for ${selectedSets.join(', ')}.`
                : 'Select one or more sets to view recent matches.'}
            </p>
            <div className="mt-6 space-y-2">
              {selectedSets.length ? (
                filteredMatches.map((match) => (
                  <div key={match.id} className="flex items-start gap-4 rounded-2xl border border-base-300 p-4">
                    <div className={`flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl text-sm font-black ${placementBadgeClass(match.placement)}`}>
                      <span className="text-lg leading-none">{match.placement}</span>
                      <span className="text-xs font-semibold opacity-80">{placementLabel(match.placement).slice(1)}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold">{match.queue} · {match.patch}</span>
                        <span className="shrink-0 text-sm tabular-nums text-base-content/60">{formatDuration(match.durationMinutes)}</span>
                      </div>
                      <p className="mt-1 text-xs text-base-content/60">Played {formatPlayedAt(match.playedAt)}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {match.champions.map((champ) => (
                          <div key={champ.id || champ.name} className="flex flex-col gap-1 rounded-md bg-base-200 px-1.5 py-1 text-xs text-base-content/80">
                            <span className="flex items-center gap-1 font-medium">
                              {champ.id && (
                                <img
                                  src={`https://cdn.communitydragon.org/latest/champion/${championIconId(champ.id)}/square.png`}
                                  alt={champ.name}
                                  className="h-4 w-4 rounded-sm object-cover"
                                  referrerPolicy="no-referrer"
                                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                                />
                              )}
                              {champ.name}
                              {champ.chosen ? <span className="text-primary" title="Chosen unit">★</span> : null}
                            </span>
                            {champ.items && champ.items.length > 0 ? (
                              <span className="text-[10px] leading-tight text-base-content/60">{champ.items.join(', ')}</span>
                            ) : null}
                          </div>
                        ))}
                      </div>
                      {match.augments && match.augments.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {match.augments.map((augment) => (
                            <span key={augment} className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                              {augment}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {match.traits && match.traits.some((t) => (t.tier_current ?? 0) > 0) ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {[...match.traits]
                            .filter((t) => (t.tier_current ?? 0) > 0)
                            .sort((a, b) => (b.tier_current ?? 0) - (a.tier_current ?? 0))
                            .map((t) => (
                              <span key={t.name} className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${traitStyleClass(t.style)}`}>
                                {t.name}{t.num_units ? ` ${t.num_units}` : ''}
                              </span>
                            ))}
                        </div>
                      ) : null}
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-base-content/60">
                        {typeof match.level === 'number' ? <span>Level {match.level}</span> : null}
                        {typeof match.lastRound === 'number' ? <span>Survived to round {match.lastRound}</span> : null}
                        {typeof match.totalDamageToPlayers === 'number' ? <span>{match.totalDamageToPlayers} dmg to players</span> : null}
                        {typeof match.playersEliminated === 'number' ? <span>{match.playersEliminated} eliminated</span> : null}
                        {typeof match.goldLeft === 'number' ? <span>{match.goldLeft} gold left</span> : null}
                      </div>
                    </div>
                  </div>
                ))
              ) : null}
            </div>
          </article>

        </section>
      </section>
    </main>
  );
}
