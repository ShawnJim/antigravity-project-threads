const TIER_LABELS = {
  pro: 'Gemini Pro',
  'gemini pro': 'Gemini Pro',
  'gemini-pro': 'Gemini Pro',
  auto: 'Gemini Pro',
  inherit: 'Follow Coordinator (inherit)',
  flash: 'Gemini Flash',
  'gemini flash': 'Gemini Flash',
  'gemini-flash': 'Gemini Flash',
  flash_lite: 'Gemini Flash Lite',
  'flash-lite': 'Gemini Flash Lite',
  lite: 'Gemini Flash Lite',
  'gemini flash lite': 'Gemini Flash Lite',
  'gemini-flash-lite': 'Gemini Flash Lite',
};

const EFFORT_LABELS = {
  xhigh: 'XHigh',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  thinking: 'Thinking',
};

/** Returns true when the raw value is an abstract tier alias rather than a concrete model ID/name. */
export function isTierAlias(model) {
  const s = String(model || '').trim().toLowerCase();
  return !s || s === 'pro' || s === 'flash' || s === 'flash_lite' || s === 'flash-lite' || s === 'lite' || s === 'auto' || s === 'inherit';
}

/**
 * Formats a concrete model display name, slug, or tier alias into a human-readable label.
 * Concrete display names (e.g. "Gemini 4 Hydrogen (XHigh)", "Gemini 3.8 Flash (High)") are
 * preserved verbatim while raw slugs and tier aliases are formatted cleanly.
 */
export function formatModelDisplay(input) {
  const raw =
    input && typeof input === 'object'
      ? String(input.modelDisplayName || input.resolvedModel || input.model || '').trim()
      : String(input || '').trim();
  if (!raw) return 'Gemini Pro';

  const lower = raw.toLowerCase();
  if (TIER_LABELS[lower]) return TIER_LABELS[lower];
  if (/^MODEL_PLACEHOLDER_/i.test(raw)) return 'Gemini Pro';

  // Preserve already-formatted human-readable names verbatim (e.g. "Gemini 4 Neon Low")
  if (!/^MODEL_[A-Z0-9_]+$/i.test(raw) && (/\s/.test(raw) || /[A-Z]/.test(raw))) {
    return raw;
  }

  let slug = raw.replace(/^MODEL_(?:GOOGLE_|ANTHROPIC_|OPENAI_)?/i, '');
  slug = slug.replace(/-tiered-/gi, '-').replace(/[-_](?:tiered|disabled)$/gi, '');

  const tokens = slug.split(/[-_]+/).filter(Boolean);
  if (!tokens.length) return 'Gemini Pro';

  let effortSuffix = '';
  const lastTok = tokens[tokens.length - 1].toLowerCase();
  if (tokens.length > 1 && EFFORT_LABELS[lastTok]) {
    effortSuffix = EFFORT_LABELS[lastTok];
    tokens.pop();
  }

  const words = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const tokLow = tok.toLowerCase();
    if (/^\d{1,2}$/.test(tok) && i + 1 < tokens.length && /^\d{1,2}$/.test(tokens[i + 1])) {
      words.push(`${tok}.${tokens[i + 1]}`);
      i++;
      continue;
    }
    if (tokLow === 'gpt' && i + 1 < tokens.length && tokens[i + 1].toLowerCase() === 'oss') {
      words.push('GPT-OSS');
      i++;
      continue;
    }
    if (tokLow === 'gpt') words.push('GPT');
    else if (tokLow === 'oss') words.push('OSS');
    else if (tokLow === 'xhigh') words.push('XHigh');
    else if (/^\d+[bkmt]$/i.test(tok)) words.push(tok.toUpperCase());
    else if (/^\d+(?:\.\d+)*$/.test(tok)) words.push(tok);
    else words.push(tok[0].toUpperCase() + tok.slice(1).toLowerCase());
  }

  const baseName = words.join(' ').trim();
  if (!baseName) return 'Gemini Pro';
  return effortSuffix ? `${baseName} (${effortSuffix})` : baseName;
}

function normalizeComparableTokens(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/\(thinking\)|[-_]thinking\b/g, ' ')
    .replace(/\btiered\b|\bdisabled\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Checks whether a human-readable display name (e.g. from <USER_SETTINGS_CHANGE>) corresponds
 * to the same concrete model & effort variant as a PLANNER_RESPONSE model slug.
 */
export function isSameModelFamily(displayName, slug) {
  const a = normalizeComparableTokens(displayName);
  const b = normalizeComparableTokens(slug);
  if (!a.length || a.length !== b.length) return false;
  return a.every((tok, idx) => tok === b[idx]);
}

const TIER_SORT_RANK = {
  minimal: 10,
  low: 20,
  standard: 25,
  default: 25,
  none: 25,
  medium: 30,
  high: 40,
  xhigh: 50,
  'extra high': 50,
  max: 60,
  thinking: 70,
};

function canonicalizeTierAliasKey(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'pro' || s === 'gemini pro' || s === 'gemini-pro') return 'pro';
  if (s === 'flash' || s === 'gemini flash' || s === 'gemini-flash') return 'flash';
  if (
    s === 'flash_lite' ||
    s === 'flash-lite' ||
    s === 'lite' ||
    s === 'gemini flash lite' ||
    s === 'gemini-flash-lite'
  ) {
    return 'flash_lite';
  }
  return '';
}

/**
 * Groups selectable concrete models and special dispatch modes (Follow Global, Follow Coordinator,
 * and Auto Tier aliases) into two-level Model (family) + Tier/Effort descriptors.
 */
export function buildModelFamilyGroups(catalogModels = [], options = {}) {
  const {
    includeFollowGlobal = false,
    followGlobalLabel = 'Follow Global Default',
    followGlobalTierLabel = '—',
    includeInherit = true,
    inheritLabel = 'Follow Coordinator (inherit)',
    inheritTierLabel = '—',
    includeTierAliases = true,
    tierAliasGroupLabel = 'Auto Tier',
    tierLabels = { pro: 'Pro', flash: 'Flash', flash_lite: 'Flash Lite' },
    defaultTierLabel = 'Default',
    standardTierLabel = 'Standard',
  } = options || {};

  const groups = [];

  if (includeFollowGlobal) {
    groups.push({
      key: '__follow_global__',
      label: followGlobalLabel,
      kind: 'follow_global',
      hasTiers: false,
      defaultValue: '',
      tiers: [
        {
          value: '',
          label: followGlobalTierLabel,
          rawLabel: followGlobalLabel,
          modelId: '',
          modelEnum: '',
          modelAlias: '',
          isDefault: false,
        },
      ],
    });
  }

  if (includeInherit) {
    groups.push({
      key: '__inherit__',
      label: inheritLabel,
      kind: 'inherit',
      hasTiers: false,
      defaultValue: 'inherit',
      tiers: [
        {
          value: 'inherit',
          label: inheritTierLabel,
          rawLabel: inheritLabel,
          modelId: '',
          modelEnum: '',
          modelAlias: '',
          isDefault: false,
        },
      ],
    });
  }

  if (includeTierAliases) {
    groups.push({
      key: '__tier__',
      label: tierAliasGroupLabel,
      kind: 'tier',
      hasTiers: true,
      defaultValue: 'pro',
      tiers: [
        {
          value: 'pro',
          label: tierLabels.pro || 'Pro',
          rawLabel: 'Gemini Pro',
          modelId: '',
          modelEnum: '',
          modelAlias: 'pro',
          isDefault: false,
        },
        {
          value: 'flash',
          label: tierLabels.flash || 'Flash',
          rawLabel: 'Gemini Flash',
          modelId: '',
          modelEnum: '',
          modelAlias: 'flash',
          isDefault: false,
        },
        {
          value: 'flash_lite',
          label: tierLabels.flash_lite || 'Flash Lite',
          rawLabel: 'Gemini Flash Lite',
          modelId: '',
          modelEnum: '',
          modelAlias: 'flash_lite',
          isDefault: false,
        },
      ],
    });
  }

  const buckets = [];
  const bucketByKey = new Map();

  for (const m of Array.isArray(catalogModels) ? catalogModels : []) {
    if (!m || typeof m !== 'object') continue;
    const val = String(m.id || m.modelId || m.modelEnum || m.modelAlias || '').trim();
    if (!val) continue;
    const rawLabel = String(m.label || formatModelDisplay(val)).trim();
    const parenMatch = rawLabel.match(/^(.+?)\s*\(([^()]+)\)\s*$/);
    const famName = String(m.familyName || '').trim();

    let baseName = '';
    let tierCandidate = '';
    if (famName) {
      baseName = famName;
      if (parenMatch && parenMatch[1].trim().toLowerCase() === famName.toLowerCase()) {
        tierCandidate = parenMatch[2].trim();
      } else if (m.thinkingLevel) {
        tierCandidate = String(m.thinkingLevel).trim();
      } else if (parenMatch) {
        tierCandidate = parenMatch[2].trim();
      }
    } else if (parenMatch) {
      baseName = parenMatch[1].trim();
      tierCandidate = parenMatch[2].trim();
    } else {
      baseName = rawLabel;
      tierCandidate = '';
    }

    const bucketKey = `family:${baseName.toLowerCase()}`;
    let bucket = bucketByKey.get(bucketKey);
    if (!bucket) {
      bucket = {
        key: bucketKey,
        baseName,
        items: [],
      };
      bucketByKey.set(bucketKey, bucket);
      buckets.push(bucket);
    }
    bucket.items.push({
      value: val,
      tierCandidate,
      rawLabel,
      modelId: String(m.modelId || '').trim(),
      modelEnum: String(m.modelEnum || '').trim(),
      modelAlias: String(m.modelAlias || '').trim(),
      isDefault: Boolean(m.isDefault),
      idx: bucket.items.length,
    });
  }

  for (const bucket of buckets) {
    if (bucket.items.length === 1) {
      const only = bucket.items[0];
      groups.push({
        key: bucket.key,
        label: only.rawLabel,
        kind: 'family',
        hasTiers: false,
        defaultValue: only.value,
        tiers: [
          {
            value: only.value,
            label: defaultTierLabel,
            rawLabel: only.rawLabel,
            modelId: only.modelId,
            modelEnum: only.modelEnum,
            modelAlias: only.modelAlias,
            isDefault: only.isDefault,
          },
        ],
      });
      continue;
    }

    const sorted = [...bucket.items].sort((a, b) => {
      const ak = (a.tierCandidate || 'standard').toLowerCase();
      const bk = (b.tierCandidate || 'standard').toLowerCase();
      const ar = TIER_SORT_RANK[ak] ?? 100 + a.idx;
      const br = TIER_SORT_RANK[bk] ?? 100 + b.idx;
      return ar !== br ? ar - br : a.idx - b.idx;
    });
    const tiers = sorted.map((it) => ({
      value: it.value,
      label: it.tierCandidate || standardTierLabel,
      rawLabel: it.rawLabel,
      modelId: it.modelId,
      modelEnum: it.modelEnum,
      modelAlias: it.modelAlias,
      isDefault: it.isDefault,
    }));
    const defaultValue =
      tiers.find((t) => t.isDefault)?.value ||
      tiers.find((t) => /^high$/i.test(t.label))?.value ||
      tiers.find((t) => /^medium$/i.test(t.label))?.value ||
      tiers[0].value;
    groups.push({
      key: bucket.key,
      label: bucket.baseName,
      kind: 'family',
      hasTiers: true,
      defaultValue,
      tiers,
    });
  }

  return groups;
}

/**
 * Resolves any stored or canonical model identifier ("" | "inherit" | tier alias | modelId |
 * tiered slug | MODEL_* enum | display label | offline value) back to its Model group + Tier.
 */
export function resolveModelFamilySelection(rawValue, groups = [], options = {}) {
  const { savedLabels = {}, defaultTierLabel = 'Default', fallbackValue = 'pro' } = options || {};
  const list = Array.isArray(groups) ? groups : [];
  const raw = String(rawValue || '').trim();
  const low = raw.toLowerCase();

  if (!raw || low === 'default' || low === 'auto') {
    const followGlobalGroup = list.find((g) => g.kind === 'follow_global');
    if (followGlobalGroup) {
      return {
        groups: list,
        groupKey: followGlobalGroup.key,
        value: '',
        group: followGlobalGroup,
        tier: followGlobalGroup.tiers[0] || null,
        isFallback: false,
      };
    }
    if (fallbackValue && fallbackValue !== raw) {
      return resolveModelFamilySelection(fallbackValue, list, options);
    }
  }

  if (low === 'inherit') {
    const inheritGroup = list.find((g) => g.kind === 'inherit');
    if (inheritGroup) {
      return {
        groups: list,
        groupKey: inheritGroup.key,
        value: 'inherit',
        group: inheritGroup,
        tier: inheritGroup.tiers[0] || null,
        isFallback: false,
      };
    }
  }

  const tierKey = canonicalizeTierAliasKey(raw);
  if (tierKey) {
    const tierGroup = list.find((g) => g.kind === 'tier');
    const matchedTier = tierGroup?.tiers?.find((t) => t.value === tierKey);
    if (tierGroup && matchedTier) {
      return {
        groups: list,
        groupKey: tierGroup.key,
        value: matchedTier.value,
        group: tierGroup,
        tier: matchedTier,
        isFallback: false,
      };
    }
  }

  const familyGroups = list.filter((g) => g.kind === 'family');
  if (raw) {
    // Pass 1: exact match on canonical value, modelId, modelEnum, modelAlias, or rawLabel
    for (const g of familyGroups) {
      for (const t of g.tiers || []) {
        if (
          t.value === raw ||
          (t.modelId && t.modelId === raw) ||
          (t.modelEnum && t.modelEnum === raw) ||
          (t.modelAlias && t.modelAlias === raw) ||
          (t.rawLabel && t.rawLabel === raw)
        ) {
          return { groups: list, groupKey: g.key, value: t.value, group: g, tier: t, isFallback: false };
        }
      }
    }

    // Pass 2: case-insensitive & -tiered- stripped match
    const untiered = low.replace(/-tiered-/g, '-');
    for (const g of familyGroups) {
      for (const t of g.tiers || []) {
        const valLow = String(t.value || '').toLowerCase();
        const idLow = String(t.modelId || '').toLowerCase();
        const lblLow = String(t.rawLabel || '').toLowerCase();
        if (
          valLow === low ||
          idLow === low ||
          (idLow && idLow.replace(/-tiered-/g, '-') === untiered) ||
          (valLow && valLow.replace(/-tiered-/g, '-') === untiered) ||
          lblLow === low
        ) {
          return { groups: list, groupKey: g.key, value: t.value, group: g, tier: t, isFallback: false };
        }
      }
    }

    // Pass 3: semantic family + effort match (handles e.g. display label vs slug differences)
    if (!/^MODEL_PLACEHOLDER_/i.test(raw)) {
      for (const g of familyGroups) {
        for (const t of g.tiers || []) {
          if (isSameModelFamily(raw, t.modelId || t.value || t.rawLabel)) {
            return { groups: list, groupKey: g.key, value: t.value, group: g, tier: t, isFallback: false };
          }
        }
      }
    }
  }

  // Fallback synthetic single-variant group for offline/unlisted stored values
  if (raw) {
    const customLabel =
      (savedLabels && savedLabels[raw]) ||
      (/^MODEL_PLACEHOLDER_/i.test(raw) ? raw : formatModelDisplay(raw));
    const customGroup = {
      key: `custom:${raw}`,
      label: customLabel,
      kind: 'family',
      hasTiers: false,
      defaultValue: raw,
      tiers: [
        {
          value: raw,
          label: defaultTierLabel,
          rawLabel: customLabel,
          modelId: /^MODEL_/i.test(raw) ? '' : raw,
          modelEnum: /^MODEL_(?!ALIAS_)/i.test(raw) ? raw : '',
          modelAlias: '',
          isDefault: false,
        },
      ],
    };
    return {
      groups: [...list, customGroup],
      groupKey: customGroup.key,
      value: raw,
      group: customGroup,
      tier: customGroup.tiers[0],
      isFallback: true,
    };
  }

  const firstGroup = list[0] || null;
  const firstTier = firstGroup?.tiers?.[0] || null;
  return {
    groups: list,
    groupKey: firstGroup?.key || '',
    value: firstGroup?.defaultValue ?? firstTier?.value ?? '',
    group: firstGroup,
    tier: firstTier,
    isFallback: true,
  };
}
