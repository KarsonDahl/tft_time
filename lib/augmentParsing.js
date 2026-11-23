function isAugmentHint(key) {
  const lower = (key ?? '').toLowerCase();
  return lower.includes('augment') || lower.includes('selection') || lower.includes('choice');
}

function normalizeAugmentValue(value, keyHint = '') {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^(TFT|Augment|augment)/i.test(trimmed) || isAugmentHint(keyHint)) {
      return trimmed;
    }
    return null;
  }

  if (!value || typeof value !== 'object') return null;

  const record = value;
  const maybeApiName = typeof record.apiName === 'string' ? record.apiName : undefined;
  const maybeName = typeof record.name === 'string' ? record.name : undefined;
  const maybeId = typeof record.id === 'string' ? record.id : undefined;
  const maybeAugmentId = typeof record.augmentId === 'string' ? record.augmentId : undefined;
  const maybeAugmentName = typeof record.augmentName === 'string' ? record.augmentName : undefined;
  const maybeDisplayName = typeof record.displayName === 'string' ? record.displayName : undefined;
  const maybeFullName = typeof record.fullName === 'string' ? record.fullName : undefined;
  const maybeLabel = typeof record.label === 'string' ? record.label : undefined;

  if (maybeApiName) return maybeApiName;
  if (maybeAugmentId) return maybeAugmentId;
  if (maybeId) return maybeId;
  if (maybeAugmentName) return maybeAugmentName;
  if (maybeDisplayName) return maybeDisplayName;
  if (maybeFullName) return maybeFullName;

  if (isAugmentHint(keyHint) && (maybeName || maybeLabel)) {
    return maybeName || maybeLabel || null;
  }

  return null;
}

// Bump when the augment extraction logic changes so matches cached by an older
// version are re-parsed from Riot once (and then left alone, even when Riot
// legitimately returns no augments for a match).
export const AUGMENTS_VERSION = 2;

export function shouldBackfillAugments(match) {
  if (!match) return false;
  return (
    match.augmentsVersion !== AUGMENTS_VERSION ||
    match.augments === undefined ||
    match.augmentIcons === undefined ||
    match.augmentTiers === undefined
  );
}

// `rootHint` lets callers pass a known-augment field (e.g. participant.augments)
// so plain string ids that lack a "TFT"/"Augment" prefix (Set 18 uses "DA_...")
// are still accepted.
export function normalizeAugmentApiNames(value, rootHint = '') {
  const seen = new Set();
  const values = [];

  const visit = (entry, keyHint = '') => {
    if (entry == null) return;

    if (typeof entry === 'string') {
      const normalized = normalizeAugmentValue(entry, keyHint);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        values.push(normalized);
      }
      return;
    }

    if (Array.isArray(entry)) {
      for (const item of entry) {
        visit(item, keyHint);
      }
      return;
    }

    if (typeof entry !== 'object') return;

    const normalized = normalizeAugmentValue(entry, keyHint);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      values.push(normalized);
    }

    if (!normalized) {
      for (const [key, child] of Object.entries(entry)) {
        const nextHint = isAugmentHint(key) ? key.toLowerCase() : keyHint;
        visit(child, nextHint);
      }
    }
  };

  visit(value, rootHint);
  return values;
}
