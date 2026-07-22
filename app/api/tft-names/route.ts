import { NextResponse } from 'next/server';
import { getTftNameMaps } from '@/lib/tftData';
import { formatChampionName, formatItemName, formatAugmentName, formatTraitName } from '@/lib/tftFormat';

// Always dynamic: this depends on a live (or Redis-cached) fetch to
// CommunityDragon, which Next.js can't statically prerender.
export const dynamic = 'force-dynamic';

export type NameFixMap = {
    champions: Record<string, string>;
    items: Record<string, string>;
    augments: Record<string, string>;
    traits: Record<string, string>;
};

/**
 * Older cached matches (fetched before lib/tftData.ts existed) stored the
 * regex-guessed name instead of the real CommunityDragon display name, e.g.
 * "Shield Tank" instead of "Vanguard" — and only the guessed string was
 * persisted, not the original apiName, so there's no way to re-derive the
 * real name from stored data alone.
 *
 * Since the regex guess is a deterministic function of the apiName, we can
 * still recover a correction table by re-running that same guess function
 * over every known apiName and recording guess → real wherever they differ.
 * The frontend uses this map to patch up old cached matches purely for
 * display, without needing to touch Redis or re-fetch from Riot.
 */
function buildReverseMap(
    entries: Record<string, string>,
    guessFn: (id: string) => string,
): Record<string, string> {
    const reverse: Record<string, string> = {};
    for (const [apiName, realName] of Object.entries(entries)) {
        const guess = guessFn(apiName);
        if (guess && guess !== realName && !(guess in reverse)) {
            reverse[guess] = realName;
        }
    }
    return reverse;
}

export async function GET() {
    const maps = await getTftNameMaps().catch(() => null);

    const empty: NameFixMap = { champions: {}, items: {}, augments: {}, traits: {} };
    if (!maps) {
        return NextResponse.json(empty, { headers: { 'Cache-Control': 'public, max-age=300' } });
    }

    const fixMap: NameFixMap = {
        champions: buildReverseMap(maps.champions, (id) => formatChampionName(id)),
        items: buildReverseMap(maps.items, (id) => formatItemName(id)),
        augments: buildReverseMap(maps.items, (id) => formatAugmentName(id)),
        traits: buildReverseMap(maps.traits, (id) => formatTraitName(id)),
    };

    // This only changes when a patch reshuffles trait/item/champion names, so
    // it's safe to let browsers/CDNs cache it fairly aggressively.
    return NextResponse.json(fixMap, { headers: { 'Cache-Control': 'public, max-age=3600' } });
}
