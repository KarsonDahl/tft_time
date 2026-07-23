/**
 * Best-effort regex-based display-name formatters for Riot's TFT apiName
 * ids (e.g. "TFT17_ShieldTank", "TFT13_Augment_BruiserCrown").
 *
 * These are only a FALLBACK for when the real name isn't available from
 * CommunityDragon (see lib/tftData.ts) — many apiNames have no textual
 * relationship to their actual in-client display name (e.g.
 * "TFT17_ShieldTank" is really called "Vanguard"), so this formatting is
 * frequently wrong. It's kept only so the app degrades gracefully instead of
 * showing raw ids when the CommunityDragon lookup is unavailable.
 */

export function formatChampionName(characterId?: string) {
    if (!characterId) return 'Unknown';
    return characterId
        .replace(/^TFT[0-9]+_/, '')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatItemName(itemId?: string) {
    if (!itemId) return 'Unknown Item';
    return itemId
        .replace(/^TFT[0-9]*_Item_/, '')
        .replace(/_/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .trim();
}

export function formatAugmentName(augmentId?: string) {
    if (!augmentId) return 'Unknown Augment';
    return augmentId
        .replace(/^TFT[0-9]*_Augment_/, '')
        .replace(/_/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .trim();
}

export function formatTraitName(traitId?: string) {
    if (!traitId) return 'Unknown Trait';
    return traitId
        .replace(/^TFT[0-9]*_/, '')
        .replace(/_/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .trim();
}

export function formatRoundLabel(round?: number) {
    if (typeof round !== 'number' || !Number.isFinite(round) || round < 1) {
        return 'Unknown';
    }

    const stage = Math.floor((round - 1) / 4) + 1;
    const roundInStage = ((round - 1) % 4) + 1;
    return `${stage}-${roundInStage}`;
}
