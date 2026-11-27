const TIER_LABELS = {
  pro: 'Gemini Pro',
  'gemini pro': 'Gemini Pro',
  'gemini-pro': 'Gemini Pro',
  auto: 'Gemini Pro',
  inherit: 'Gemini Pro',
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
