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
 * Older cached matches went through a couple of different name formats
 * before this display-name fix existed:
 *   1. The very oldest matches stored the raw Riot apiName verbatim (e.g.
 *      "TFT17_ShieldTank") — traits in particular were persisted completely
 *      unformatted for a long time.
 *   2. Slightly newer matches stored a regex-guessed name (e.g.
 *      "Shield Tank") from a brief period after formatting was added but
 *      before the CommunityDragon lookup existed.
 * Neither stored the original apiName *and* a formatted guess side by side,
 * so there's no single field to recover the real name from — but both the
 * raw apiName and the regex guess are deterministic, recoverable strings, so
 * we map BOTH of them to the real name here.
 * The frontend uses this map to patch up old cached matches purely for
 * display, without needing to touch Redis or re-fetch from Riot.
 */
function buildReverseMap(
    entries: Record<string, string>,
    guessFn: (id: string) => string,
): Record<string, string> {
    const reverse: Record<string, string> = {};
    for (const [apiName, realName] of Object.entries(entries)) {
        if (apiName !== realName && !(apiName in reverse)) {
            reverse[apiName] = realName;
        }
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
