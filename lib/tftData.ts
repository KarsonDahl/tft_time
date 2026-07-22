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
import { formatChampionName, formatItemName, formatAugmentName, formatTraitName } from './tftFormat';

const CDRAGON_URL = 'https://raw.communitydragon.org/latest/cdragon/tft/en_us.json';
const CACHE_KEY = 'tft:cdragon:namemaps:v3';
const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24h — the dump only changes when a patch ships
const FETCH_TIMEOUT_MS = 10_000;

export type TftNameMaps = {
    traits: Record<string, string>;
    // Covers both regular items and augments (team-up augments included) —
    // CommunityDragon lists them all in the same flat top-level `items` array.
    items: Record<string, string>;
    champions: Record<string, string>;
    // apiName -> fully-qualified CDN image URL, converted from CommunityDragon's
    // raw ".tex" asset paths (see convertIconPath below). Kept separate from the
    // name maps above so both display name and icon can be looked up by apiName.
    itemIcons: Record<string, string>;
    // Champions use the TFT-specific "tileIcon" (falling back to "squareIcon")
    // asset instead of the base League champion square — TFT-exclusive units
    // like Rhaast have no base-game champion art, and reskinned units should
    // show the art matching the set they were played in, not whatever the
    // live base-game splash currently is.
    championIcons: Record<string, string>;
    // apiName -> trait-style number (2=silver, 4=gold, 3=prismatic/chromatic,
    // 0=unknown) derived from the augment icon filename's trailing Roman
    // numeral (I/II/III), which corresponds to the augment's actual in-game
    // tier. Reuses the same style numbers as trait styling so augments render
    // with the identical bronze/silver/gold/chromatic color scheme.
    augmentTiers: Record<string, number>;
    builtAt: number;
};

type RawApiNameEntry = { apiName?: string; name?: string; icon?: string };

type RawChampionEntry = RawApiNameEntry & { squareIcon?: string; tileIcon?: string };

type RawCDragonTft = {
    items?: RawApiNameEntry[];
    setData?: Array<{
        traits?: RawApiNameEntry[];
        champions?: RawChampionEntry[];
    }>;
};

let memoryMaps: TftNameMaps | null = null;
let inflight: Promise<TftNameMaps | null> | null = null;

function addEntries(target: Record<string, string>, entries?: RawApiNameEntry[]) {
    for (const entry of entries ?? []) {
        if (entry.apiName && entry.name) target[entry.apiName] = entry.name;
    }
}

// CommunityDragon exposes raw game asset paths like
// "ASSETS/Maps/TFT/Icons/Items/Hexcore/TFT_Item_InfinityEdge.tex". The CDN
// serves these back at the same path, lowercased, with the extension swapped
// to .png — this holds for every asset category we use here (items, augments,
// champion tile/square icons).
function convertIconPath(path?: string): string | undefined {
    if (!path) return undefined;
    const lower = path.toLowerCase();
    const withPngExt = lower.endsWith('.tex') ? `${lower.slice(0, -4)}.png` : lower;
    return `https://raw.communitydragon.org/latest/game/${withPngExt}`;
}

function addIconEntries(target: Record<string, string>, entries?: RawApiNameEntry[]) {
    for (const entry of entries ?? []) {
        const url = convertIconPath(entry.icon);
        if (entry.apiName && url) target[entry.apiName] = url;
    }
}

// Augment icon filenames end with a Roman numeral matching their actual
// in-game tier, e.g. "AcademicCitation_II.tex" (Gold), "Crown_Bruiser_III.tex"
// (Prismatic — "Crown" augments are always Prismatic tier). This must run on
// the RAW (non-lowercased) icon path since the numeral casing matters.
function extractAugmentTier(rawIconPath?: string): number {
    if (!rawIconPath) return 0;
    const fileName = rawIconPath.split('/').pop() ?? '';
    const base = fileName.split('.')[0] ?? '';
    const match = base.match(/_(I{1,3})$/);
    if (!match) return 0;
    if (match[1] === 'III') return 3; // prismatic/chromatic
    if (match[1] === 'II') return 4; // gold
    return 2; // silver
}

function addAugmentTierEntries(target: Record<string, number>, entries?: RawApiNameEntry[]) {
    for (const entry of entries ?? []) {
        const tier = extractAugmentTier(entry.icon);
        if (entry.apiName && tier > 0) target[entry.apiName] = tier;
    }
}

export function normalizeLookupKey(value?: string): string {
    return (value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function guessDisplayName(category: 'champions' | 'items' | 'traits', value?: string): string | undefined {
    if (!value) return undefined;
    switch (category) {
        case 'champions':
            return formatChampionName(value);
        case 'items':
            return formatItemName(value);
        case 'traits':
            return formatTraitName(value);
        default:
            return undefined;
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
        const itemIcons: Record<string, string> = {};
        addIconEntries(itemIcons, data.items);
        const augmentTiers: Record<string, number> = {};
        addAugmentTierEntries(augmentTiers, data.items);

        const traits: Record<string, string> = {};
        const champions: Record<string, string> = {};
        const championIcons: Record<string, string> = {};
        for (const set of data.setData ?? []) {
            addEntries(traits, set.traits);
            addEntries(champions, set.champions);
            for (const champ of set.champions ?? []) {
                const url = convertIconPath(champ.tileIcon ?? champ.squareIcon);
                if (champ.apiName && url) championIcons[champ.apiName] = url;
            }
        }

        return { traits, items, champions, itemIcons, championIcons, augmentTiers, builtAt: Date.now() };
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
    category: 'champions' | 'items' | 'traits',
    apiName: string | undefined,
    fallback: string,
): string {
    if (!apiName) return fallback;

    const entries = maps?.[category] ?? {};
    const direct = entries[apiName];
    if (direct) return direct;

    const normalizedInput = normalizeLookupKey(apiName);
    const guess = guessDisplayName(category, apiName);
    const normalizedGuess = normalizeLookupKey(guess);

    for (const [key, resolved] of Object.entries(entries)) {
        if (key === apiName || key === guess) return resolved;

        const normalizedKey = normalizeLookupKey(key);
        if (normalizedKey && (normalizedKey === normalizedInput || normalizedKey === normalizedGuess)) {
            return resolved;
        }
    }

    return fallback;
}

// Same fuzzy-matching strategy as lookupDisplayName, but resolves an apiName
// to its CDN icon URL instead of its display name. Returns undefined (no
// fallback) when the icon can't be found — callers should hide the image
// rather than show a broken link.
export function lookupIconUrl(
    maps: TftNameMaps | null,
    category: 'champions' | 'items',
    apiName: string | undefined,
): string | undefined {
    if (!apiName || !maps) return undefined;

    const entries = category === 'champions' ? maps.championIcons : maps.itemIcons;
    const direct = entries[apiName];
    if (direct) return direct;

    const normalizedInput = normalizeLookupKey(apiName);
    const guess = guessDisplayName(category, apiName);
    const normalizedGuess = normalizeLookupKey(guess);

    for (const [key, resolved] of Object.entries(entries)) {
        if (key === apiName || key === guess) return resolved;

        const normalizedKey = normalizeLookupKey(key);
        if (normalizedKey && (normalizedKey === normalizedInput || normalizedKey === normalizedGuess)) {
            return resolved;
        }
    }

    return undefined;
}

// Resolves an augment apiName to its trait-style tier number (see
// TftNameMaps.augmentTiers). Returns 0 (unstyled) when unknown.
export function lookupAugmentTier(maps: TftNameMaps | null, apiName: string | undefined): number {
    if (!apiName || !maps) return 0;

    const entries = maps.augmentTiers;
    const direct = entries[apiName];
    if (direct) return direct;

    const normalizedInput = normalizeLookupKey(apiName);
    const guess = guessDisplayName('items', apiName);
    const normalizedGuess = normalizeLookupKey(guess);

    for (const [key, resolved] of Object.entries(entries)) {
        if (key === apiName || key === guess) return resolved;

        const normalizedKey = normalizeLookupKey(key);
        if (normalizedKey && (normalizedKey === normalizedInput || normalizedKey === normalizedGuess)) {
            return resolved;
        }
    }

    return 0;
}
