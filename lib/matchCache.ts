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
  champions: Array<{ id: string; name: string }>;
  playedAt: number;
};

export type PlayerCache = {
  displayName: string;
  cachedMatchIds: string[];
  matches: CachedMatch[];
  lastFetchedAt: number;
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

// ── Public API ────────────────────────────────────────────────────────────────

const KEY_PREFIX = 'tft:matches:';
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

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
