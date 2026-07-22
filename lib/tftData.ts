/**
 * Display-name lookup tables for TFT traits, items/augments, and champions.
 *
 * Riot's match-v1 API only returns internal `apiName`-style identifiers
 * (e.g. "TFT17_ShieldTank", "TFT13_Augment_BruiserCrown") — NOT the
 * human-readable names shown in-client (e.g. "Vanguard", "Bruiser Crown").
 * Those two are frequently unrelated strings, so no amount of regex/casing
 * cleanup on the apiName can recover the real display name.
 *
 * CommunityDragon publishes a community-maintained data dump (extracted from
 * the game client) that maps apiName → display name for every set. This
 * module fetches it once, builds flat lookup tables, and caches the (much
 * smaller) extracted tables in Redis/KV so we don't re-download the ~25MB
 * source file on every request.
 */

import { getRawCache, setRawCache } from './matchCache';

const CDRAGON_URL = 'https://raw.communitydragon.org/latest/cdragon/tft/en_us.json';
const CACHE_KEY = 'tft:cdragon:namemaps:v1';
const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24h — the dump only changes when a patch ships
const FETCH_TIMEOUT_MS = 10_000;

export type TftNameMaps = {
  traits: Record<string, string>;
  // Covers both regular items and augments (team-up augments included) —
  // CommunityDragon lists them all in the same flat top-level `items` array.
  items: Record<string, string>;
  champions: Record<string, string>;
  builtAt: number;
};

type RawApiNameEntry = { apiName?: string; name?: string };

type RawCDragonTft = {
  items?: RawApiNameEntry[];
  setData?: Array<{
    traits?: RawApiNameEntry[];
    champions?: RawApiNameEntry[];
  }>;
};

let memoryMaps: TftNameMaps | null = null;
let inflight: Promise<TftNameMaps | null> | null = null;

function addEntries(target: Record<string, string>, entries?: RawApiNameEntry[]) {
  for (const entry of entries ?? []) {
    if (entry.apiName && entry.name) target[entry.apiName] = entry.name;
  }
}

async function fetchRemoteMaps(): Promise<TftNameMaps> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(CDRAGON_URL, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`CommunityDragon TFT data fetch failed (${response.status} ${response.statusText})`);
    }
    const data = (await response.json()) as RawCDragonTft;

    const items: Record<string, string> = {};
    addEntries(items, data.items);

    const traits: Record<string, string> = {};
    const champions: Record<string, string> = {};
    for (const set of data.setData ?? []) {
      addEntries(traits, set.traits);
      addEntries(champions, set.champions);
    }

    return { traits, items, champions, builtAt: Date.now() };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Returns the apiName → display-name lookup tables, or null if they could
 * not be obtained (network failure, timeout, etc). Callers should fall back
 * to a best-effort string formatter when this returns null or a specific key
 * is missing from the map — that keeps match ingestion working even when
 * CommunityDragon is unreachable.
 */
export async function getTftNameMaps(): Promise<TftNameMaps | null> {
  if (memoryMaps) return memoryMaps;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const cached = await getRawCache<TftNameMaps>(CACHE_KEY);
      if (cached) {
        memoryMaps = cached;
        return cached;
      }
    } catch (err) {
      console.warn('[tftData] Redis lookup for name maps failed, will try remote fetch', err);
    }

    try {
      const built = await fetchRemoteMaps();
      memoryMaps = built;
      setRawCache(CACHE_KEY, built, CACHE_TTL_SECONDS).catch((err) => {
        console.warn('[tftData] failed to persist name maps to cache', err);
      });
      return built;
    } catch (err) {
      console.warn('[tftData] failed to fetch CommunityDragon TFT data, falling back to raw ids', err);
      return null;
    }
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export function lookupDisplayName(
  maps: TftNameMaps | null,
  category: keyof Omit<TftNameMaps, 'builtAt'>,
  apiName: string | undefined,
  fallback: string,
): string {
  if (!apiName) return fallback;
  const resolved = maps?.[category]?.[apiName];
  return resolved ?? fallback;
}
