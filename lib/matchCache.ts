/**
 * Match cache backed by Vercel KV / Upstash Redis when env vars are present,
 * falling back to an in-memory Map for local development.
 *
 * Free persistent setup for Vercel:
 *   - Vercel KV / Upstash Redis integration in the Vercel dashboard
 *   - or set these env vars manually in Vercel:
 *     KV_URL, KV_REST_API_TOKEN
 *     UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 */

import type { Redis } from '@upstash/redis';

export type CachedMatch = {
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
    itemIcons?: (string | null)[];
    icon?: string;
    tier?: number;
    rarity?: number;
    chosen?: string;
  }>;
  traits?: Array<{ name?: string; style?: number; num_units?: number; tier_current?: number; tier_total?: number }>;
  augments?: string[];
  // Parallel arrays to `augments`, matched by index (same pattern as
  // champions[].itemIcons) — icon URL (or null if unresolved) and trait-style
  // tier number (2=silver, 4=gold, 3=prismatic, 0=unknown) so augments render
  // as images with the same bronze/silver/gold/chromatic color scheme traits use.
  augmentIcons?: (string | null)[];
  augmentTiers?: number[];
  level?: number;
  goldLeft?: number;
  lastRound?: number;
  timeEliminated?: number;
  playersEliminated?: number;
  totalDamageToPlayers?: number;
  playedAt: number;
};

export type PlayerCache = {
  displayName: string;
  cachedMatchIds: string[];
  matches: CachedMatch[];
  lastFetchedAt: number;
};

export type PuuidMapping = {
  puuid: string;
  displayName: string;
};

// ── Persistent cache clients (lazy, only when env vars exist) ───────────────

let _kvClient: any = null;
let _redis: Redis | null = null;

function getVercelKvClient() {
  if (_kvClient) return _kvClient;

  const url = process.env.KV_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;

  const { createClient } = require('@vercel/kv');
  _kvClient = createClient({ url, token });
  return _kvClient;
}

function getRedis(): Redis | null {
  if (_redis) return _redis;

  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;

  const { Redis } = require('@upstash/redis');
  _redis = new Redis({ url, token });
  return _redis;
}

// ── In-memory fallback ────────────────────────────────────────────────────────

const memoryStore = new Map<string, PlayerCache>();
const genericMemoryStore = new Map<string, unknown>();

// ── Generic raw cache (used for things like the CommunityDragon TFT name
// lookup tables, which aren't per-player and don't fit the PlayerCache shape) ─

export async function getRawCache<T>(key: string): Promise<T | null> {
  const kv = getVercelKvClient();
  if (kv) {
    const raw = await kv.get(key);
    return (raw ?? null) as T | null;
  }

  const redis = getRedis();
  if (redis) {
    const raw = await redis.get<T>(key);
    return raw ?? null;
  }

  return (genericMemoryStore.get(key) as T | undefined) ?? null;
}

export async function setRawCache<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  const kv = getVercelKvClient();
  if (kv) {
    await kv.set(key, value, { ex: ttlSeconds });
    return;
  }

  const redis = getRedis();
  if (redis) {
    await redis.set(key, value, { ex: ttlSeconds });
    return;
  }

  genericMemoryStore.set(key, value);
}

// ── Public API ────────────────────────────────────────────────────────────────

const KEY_PREFIX = 'tft:matches:';
const NAME_KEY_PREFIX = 'tft:puuid:';
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
// PUUIDs don't change, so this mapping can outlive the match cache and lets us
// resolve a player without hitting the Riot API (useful when the daily API
// key has expired but Redis still has the player's data).
const NAME_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year

export async function getCache(puuid: string): Promise<PlayerCache | null> {
  const kv = getVercelKvClient();
  if (kv) {
    const raw = await kv.get(`${KEY_PREFIX}${puuid}`);
    return (raw ?? null) as PlayerCache | null;
  }

  const redis = getRedis();
  if (redis) {
    const raw = await redis.get<PlayerCache>(`${KEY_PREFIX}${puuid}`);
    return raw ?? null;
  }

  return memoryStore.get(puuid) ?? null;
}

export async function setCache(puuid: string, data: PlayerCache): Promise<void> {
  const kv = getVercelKvClient();
  if (kv) {
    await kv.set(`${KEY_PREFIX}${puuid}`, data, { ex: TTL_SECONDS });
    return;
  }

  const redis = getRedis();
  if (redis) {
    await redis.set(`${KEY_PREFIX}${puuid}`, data, { ex: TTL_SECONDS });
    return;
  }

  memoryStore.set(puuid, data);
}

// ── Riot ID → PUUID lookup ──────────────────────────────────────────────────
// Lets the route resolve a player's cached data straight from Redis, without
// depending on the (frequently rotated) Riot API key being valid.

const nameStore = new Map<string, PuuidMapping>();

export async function getPuuidMapping(nameKey: string): Promise<PuuidMapping | null> {
  const kv = getVercelKvClient();
  if (kv) {
    const raw = await kv.get(`${NAME_KEY_PREFIX}${nameKey}`);
    return (raw ?? null) as PuuidMapping | null;
  }

  const redis = getRedis();
  if (redis) {
    const raw = await redis.get<PuuidMapping>(`${NAME_KEY_PREFIX}${nameKey}`);
    return raw ?? null;
  }

  return nameStore.get(nameKey) ?? null;
}

export async function setPuuidMapping(nameKey: string, data: PuuidMapping): Promise<void> {
  const kv = getVercelKvClient();
  if (kv) {
    await kv.set(`${NAME_KEY_PREFIX}${nameKey}`, data, { ex: NAME_TTL_SECONDS });
    return;
  }

  const redis = getRedis();
  if (redis) {
    await redis.set(`${NAME_KEY_PREFIX}${nameKey}`, data, { ex: NAME_TTL_SECONDS });
    return;
  }

  nameStore.set(nameKey, data);
}

// ── Ranked (League-v1) history ──────────────────────────────────────────────
// Riot's public match-v1 API has no per-match LP delta, so the only way to
// track "LP gain/loss over time" is to snapshot the player's current League
// standing (tier/rank/LP) every time we successfully talk to Riot, and diff
// consecutive snapshots on the frontend. Snapshots are only appended when
// they differ from the previous one, so this doesn't grow on every no-op
// refresh — just on actual rank/LP movement.

export type RankSnapshot = {
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
  capturedAt: number;
};

const RANK_KEY_PREFIX = 'tft:rank:';
const RANK_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year, same lifetime as the puuid mapping
const RANK_HISTORY_MAX_ENTRIES = 500;
const rankMemoryStore = new Map<string, RankSnapshot[]>();

export async function getRankHistory(puuid: string): Promise<RankSnapshot[]> {
  const kv = getVercelKvClient();
  if (kv) {
    const raw = await kv.get(`${RANK_KEY_PREFIX}${puuid}`);
    return (raw as RankSnapshot[] | null) ?? [];
  }

  const redis = getRedis();
  if (redis) {
    const raw = await redis.get<RankSnapshot[]>(`${RANK_KEY_PREFIX}${puuid}`);
    return raw ?? [];
  }

  return rankMemoryStore.get(puuid) ?? [];
}

export async function appendRankSnapshot(puuid: string, snapshot: RankSnapshot): Promise<RankSnapshot[]> {
  const history = await getRankHistory(puuid);
  const previous = history[history.length - 1];
  const unchanged = previous
    && previous.tier === snapshot.tier
    && previous.rank === snapshot.rank
    && previous.leaguePoints === snapshot.leaguePoints
    && previous.wins === snapshot.wins
    && previous.losses === snapshot.losses;

  const updated = unchanged ? history : [...history, snapshot].slice(-RANK_HISTORY_MAX_ENTRIES);

  if (!unchanged) {
    const kv = getVercelKvClient();
    if (kv) {
      await kv.set(`${RANK_KEY_PREFIX}${puuid}`, updated, { ex: RANK_TTL_SECONDS });
    } else {
      const redis = getRedis();
      if (redis) {
        await redis.set(`${RANK_KEY_PREFIX}${puuid}`, updated, { ex: RANK_TTL_SECONDS });
      } else {
        rankMemoryStore.set(puuid, updated);
      }
    }
  }

  return updated;
}
