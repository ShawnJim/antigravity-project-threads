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
    .replace(/(?:^|[^a-z0-9])extra[\s_-]*high(?=$|[^a-z0-9])/g, ' xhigh ')
    .replace(/(?:^|[^a-z0-9])x[\s_-]+high(?=$|[^a-z0-9])/g, ' xhigh ')
    .replace(/\(thinking\)|[-_]thinking\b/g, ' ')
    .replace(/\btiered\b|\bdisabled\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasThinkingVariantMarker(str) {
  return /\(\s*thinking\s*\)|(?:^|[^a-z0-9])thinking(?=$|[^a-z0-9])/i.test(String(str || ''));
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

/**
 * Strict variant matcher for catalog lookup: requires identical comparable tokens AND matching
 * Thinking / non-Thinking marker so e.g. "Claude Sonnet 4.6 (Thinking)" never aliases "Claude Sonnet 4.6".
 */
export function isSameModelVariant(a, b) {
  if (!isSameModelFamily(a, b)) return false;
  return hasThinkingVariantMarker(a) === hasThinkingVariantMarker(b);
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
 * Groups selectable concrete models and optional dispatch modes (Follow Global, Follow Coordinator)
 * into two-level Model (family) + Effort descriptors.
 */
export function buildModelFamilyGroups(catalogModels = [], options = {}) {
  const {
    includeFollowGlobal = false,
    followGlobalLabel = 'Follow Global Default',
    followGlobalTierLabel = '—',
    includeInherit = true,
    inheritLabel = 'Follow Coordinator (inherit)',
    inheritTierLabel = '—',
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
      tagTitle: String(m.tagTitle || '').trim(),
      tagDescription: String(m.tagDescription || '').trim(),
      description: String(m.description || '').trim(),
      quotaInfo: m.quotaInfo && typeof m.quotaInfo === 'object' ? m.quotaInfo : null,
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
            tagTitle: only.tagTitle,
            tagDescription: only.tagDescription,
            description: only.description,
            quotaInfo: only.quotaInfo,
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
      tagTitle: it.tagTitle,
      tagDescription: it.tagDescription,
      description: it.description,
      quotaInfo: it.quotaInfo,
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

function pickPreferredTierForLegacyAlias(group, matchedTier = null) {
  const tiers = Array.isArray(group?.tiers) ? group.tiers : [];
  return (
    tiers.find((t) => t.isDefault) ||
    tiers.find((t) => t.value === group?.defaultValue) ||
    matchedTier ||
    tiers[0] ||
    null
  );
}

/**
 * Resolves a legacy alias ("pro" / "flash" / "flash_lite") to the closest concrete catalog family + effort tier
 * so Settings / Modal selectors never display synthetic Auto Tier (Pro / Flash / Flash Lite) entries.
 */
function findConcreteModelForLegacyAlias(tierKey, familyGroups = []) {
  const list = Array.isArray(familyGroups) ? familyGroups : [];
  if (!list.length) return null;

  const pickMatch = (predicate) => {
    for (const g of list) {
      for (const t of g.tiers || []) {
        const text = `${g.label || ''} ${t.rawLabel || ''} ${t.modelId || ''} ${t.value || ''}`.toLowerCase();
        if (predicate(g, t, text)) {
          const tier = pickPreferredTierForLegacyAlias(g, t);
          if (tier) return { group: g, tier };
        }
      }
    }
    return null;
  };

  if (tierKey === 'flash_lite') {
    const lite = pickMatch((_g, _t, text) => /\bflash[-_\s]*lite\b|\blite\b/.test(text));
    if (lite) return lite;
  }
  if (tierKey === 'flash_lite' || tierKey === 'flash') {
    const flash = pickMatch(
      (_g, _t, text) => /\bflash\b/.test(text) && !/\b(?:flash[-_\s]*lite|lite)\b/.test(text),
    );
    if (flash) return flash;
  }

  // 'pro' (or fallback from flash / flash_lite): default concrete model -> Gemini concrete model -> "pro" -> first family
  const catalogDefault = pickMatch((_g, t) => Boolean(t.isDefault));
  if (catalogDefault) return catalogDefault;
  const geminiConcrete = pickMatch(
    (g, _t, text) => /\bgemini\b/.test(String(g.label || text).toLowerCase()) && !/\b(?:flash|lite)\b/.test(text),
  );
  if (geminiConcrete) return geminiConcrete;
  const namedPro = pickMatch((_g, _t, text) => /\bpro\b/.test(text));
  if (namedPro) return namedPro;

  const firstGroup = list[0];
  const firstTier = pickPreferredTierForLegacyAlias(firstGroup, firstGroup?.tiers?.[0] || null);
  return firstGroup && firstTier ? { group: firstGroup, tier: firstTier } : null;
}

/**
 * Resolves any stored or canonical model identifier ("" | "inherit" | legacy alias | modelId |
 * tiered slug | MODEL_* enum | display label | offline value) back to its Model group + Effort.
 */
export function resolveModelFamilySelection(rawValue, groups = [], options = {}) {
  const { savedLabels = {}, defaultTierLabel = 'Default', fallbackValue = 'inherit' } = options || {};
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

  const familyGroups = list.filter((g) => g.kind === 'family');
  const tierKey = canonicalizeTierAliasKey(raw);
  if (tierKey) {
    const concreteMatch = findConcreteModelForLegacyAlias(tierKey, familyGroups);
    if (concreteMatch) {
      return {
        groups: list,
        groupKey: concreteMatch.group.key,
        value: concreteMatch.tier.value,
        group: concreteMatch.group,
        tier: concreteMatch.tier,
        isFallback: false,
      };
    }
    if (fallbackValue === '') {
      const followGlobalGroup = list.find((g) => g.kind === 'follow_global');
      if (followGlobalGroup) {
        return {
          groups: list,
          groupKey: followGlobalGroup.key,
          value: '',
          group: followGlobalGroup,
          tier: followGlobalGroup.tiers[0] || null,
          isFallback: true,
        };
      }
    }
    const inheritGroup = list.find((g) => g.kind === 'inherit');
    if (inheritGroup) {
      return {
        groups: list,
        groupKey: inheritGroup.key,
        value: 'inherit',
        group: inheritGroup,
        tier: inheritGroup.tiers[0] || null,
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

    // Pass 3: strict semantic family + effort + thinking-variant match (only when unambiguous)
    if (!/^MODEL_PLACEHOLDER_/i.test(raw)) {
      const variantMatches = [];
      for (const g of familyGroups) {
        for (const t of g.tiers || []) {
          if (
            isSameModelVariant(raw, t.modelId || t.value || t.rawLabel) ||
            (t.rawLabel && isSameModelVariant(raw, t.rawLabel))
          ) {
            variantMatches.push({ group: g, tier: t });
          }
        }
      }
      if (variantMatches.length === 1) {
        const { group: g, tier: t } = variantMatches[0];
        return { groups: list, groupKey: g.key, value: t.value, group: g, tier: t, isFallback: false };
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
