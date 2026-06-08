'use client';

import { useMemo, useState } from 'react';

type MatchSummary = {
  id: string;
  durationMinutes: number;
  placement: number;
  queue: string;
  patch: string;
  champions: Array<{ id: string; name: string }>;
};

type ApiResponse = {
  summoner: string;
  region: string;
  source: 'demo' | 'riot';
  totalKnownGames?: number;
  summary: {
    totalGames: number;
    totalHours: number;
    averagePlacement: number;
    winRate: number;
    topChampion: string;
  };
  matches: MatchSummary[];
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

export default function Home() {
  const [summoner, setSummoner] = useState('SamplePlayer');
  const [region, setRegion] = useState('na1');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<ApiResponse | null>(null);

  async function loadStats() {
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`/api/riot?summoner=${encodeURIComponent(summoner)}&region=${encodeURIComponent(region)}`, {
        cache: 'no-store',
      });
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
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  function formatSummonerLabel(value: string) {
    return value.replace(/#/, ' #');
  }

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
              <button className="btn btn-primary" onClick={loadStats} disabled={loading}>
                {loading ? 'Loading…' : 'Load stats'}
              </button>
            </div>
          </div>
          {error ? <p className="mt-4 text-sm text-error">{error}</p> : null}
        </article>

        <section className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
          {summaryCards.map(([label, value]) => (
            <article key={label} className="rounded-3xl bg-base-100 p-6 shadow-xl">
              <p className="text-sm text-base-content/70">{label}</p>
              <p className="mt-3 text-3xl font-bold">{value}</p>
            </article>
          ))}
        </section>
        <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">

          <article className="rounded-3xl bg-base-100 p-6 shadow-xl">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">Recent TFT Sessions</h2>
              <span className="badge badge-secondary">{data?.source ?? 'demo'}</span>
            </div>
            <p className="mt-2 text-sm text-base-content/70">
              {data ? `${formatSummonerLabel(data.summoner)} • ${data.region.toUpperCase()}` : 'No stats loaded yet.'}
            </p>
            <div className="mt-6 space-y-2">
              {(data?.matches ?? []).map((match) => (
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
                    <div className="mt-2 flex flex-wrap gap-1">
                      {match.champions.map((champ) => (
                        <span key={champ.id || champ.name} className="flex items-center gap-1 rounded-md bg-base-200 px-1.5 py-0.5 text-xs text-base-content/80">
                          {champ.id && (
                            <img
                              src={`https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/assets/characters/${champ.id.toLowerCase()}/hud/${champ.id.toLowerCase()}_square.png`}
                              alt={champ.name}
                              className="h-4 w-4 rounded-sm object-cover"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                            />
                          )}
                          {champ.name}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </article>
        </section>
      </section>
    </main>
  );
}
