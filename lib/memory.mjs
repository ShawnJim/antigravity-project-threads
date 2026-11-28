import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { getStateDir } from './ls-client.mjs';

export const THIN_INDEX_SOFT_MAX_LINES = 60;
export const THIN_INDEX_SOFT_MAX_BYTES = 4096;

export const MERGE_CONVENTIONS_MARKER = '<!-- project-threads:merge-conventions -->';
export const MERGE_HYGIENE_VERSION = 2;
export const MERGE_HYGIENE_START_MARKER = `<!-- pt:managed:merge-hygiene:v${MERGE_HYGIENE_VERSION} -->`;
export const MERGE_HYGIENE_END_MARKER = '<!-- /pt:managed:merge-hygiene -->';

export const TOPIC_INDEX_SECTION_HEADING = '## Topic Knowledge Index';
export const TOPIC_INDEX_START_MARKER = '<!-- pt:managed:topic-index:start -->';
export const TOPIC_INDEX_END_MARKER = '<!-- pt:managed:topic-index:end -->';

export const REPO_MEMORY_EXCLUDE_PATTERNS = [
  '.agents/rules/project-memory.md',
  '.agents/memory/',
];

export const WORKTREE_MEMORY_EXCLUDE_PATTERNS = [
  '.agents/rules/worker-thread-context.md',
  '.agents/rules/project-memory.md',
  '.agents/memory/',
];

export const MERGE_CONVENTIONS_HEADING_RE =
  /^#{1,6}\s+.*(?:worktree\s+merge|merge\s*(?:&|and|\/)?\s*(?:archive|cleanup)?\s*(?:conventions?|rules?|policy|workflow|guidelines?)|(?:merge|cherry[- ]?pick)\s+(?:conventions?|rules?|policy|workflow)|合并规范|合入规范|合并与归档|合入与归档|分支合并|工作树合并)/im;

const TOPIC_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const WINDOWS_RESERVED_TOPIC_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const RESERVED_TOPIC_NAMES = new Set([
  'index',
  'project-memory',
  'worker-thread-context',
  'all',
  '__index__',
]);

const TOPIC_META_LINE_RE = /^\s*<!--\s*pt:topic:meta\s+(\{[\s\S]*?\})\s*-->\s*(?:\r?\n)?/;
const MANAGED_MERGE_BLOCK_RE =
  /<!--\s*pt:managed:merge-hygiene:v(\d+)\s*-->([\s\S]*?)<!--\s*\/pt:managed:merge-hygiene\s*-->/;
const MANAGED_TOPIC_INDEX_BLOCK_RE =
  /<!--\s*pt:managed:topic-index:start\s*-->[\s\S]*?<!--\s*pt:managed:topic-index:end\s*-->/;
const TOPIC_INDEX_HEADING_RE =
  /^##\s+(?:Topic\s+Knowledge\s+Index|专题知识索引|專題知識索引|Topic\s+Index)\s*$/im;

const MEMORY_LOCK_TIMEOUT_MS = 4000;
const MEMORY_LOCK_STALE_MS = 15000;
const activeMemoryLocks = new Map();
const SLEEP_ARR = new Int32Array(new SharedArrayBuffer(4));

function sleepSyncMs(ms) {
  try {
    Atomics.wait(SLEEP_ARR, 0, 0, Math.max(1, ms));
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Fallback busy wait
    }
  }
}

export function withMemoryLock(targetKey, fn) {
  const normKey = String(targetKey || '').trim();
  if (!normKey) return fn();
  const lockHash = createHash('sha1')
    .update(process.platform === 'win32' ? normKey.toLowerCase() : normKey)
    .digest('hex')
    .slice(0, 16);

  // Allow safe re-entrant calls within the same Node process
  const depth = activeMemoryLocks.get(lockHash) || 0;
  if (depth > 0) {
    activeMemoryLocks.set(lockHash, depth + 1);
    try {
      return fn();
    } finally {
      activeMemoryLocks.set(lockHash, depth);
    }
  }

  const locksDir = join(getStateDir(), 'locks');
  mkdirSync(locksDir, { recursive: true });
  const lockPath = join(locksDir, `mem-${lockHash}.lock`);
  const deadline = Date.now() + MEMORY_LOCK_TIMEOUT_MS;
  let fd = -1;

  while (fd < 0) {
    try {
      fd = openSync(lockPath, 'wx');
      writeFileSync(fd, `${process.pid}:${Date.now()}\n`, 'utf8');
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') break;
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > MEMORY_LOCK_STALE_MS) {
          try {
            unlinkSync(lockPath);
            continue;
          } catch {
            // Lost stale-cleanup race
          }
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        try {
          unlinkSync(lockPath);
          fd = openSync(lockPath, 'wx');
          writeFileSync(fd, `${process.pid}:${Date.now()}\n`, 'utf8');
        } catch {
          // Proceed best-effort after lock timeout
        }
        break;
      }
      sleepSyncMs(15);
    }
  }

  activeMemoryLocks.set(lockHash, 1);
  try {
    return fn();
  } finally {
    activeMemoryLocks.delete(lockHash);
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // Ignore unlink errors
      }
    }
  }
}

function normalizeEol(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function writeMemoryFileAtomic(filePath, content) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.pt-mem-${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(tmpPath, content, 'utf8');
  try {
    renameSync(tmpPath, filePath);
  } catch {
    try {
      writeFileSync(filePath, content, 'utf8');
    } finally {
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        // Ignore temp cleanup failure
      }
    }
  }
}

const writeFileAtomic = writeMemoryFileAtomic;

export function validateTopicId(rawTopic) {
  const raw = String(rawTopic ?? '').trim();
  if (!raw) {
    throw new Error('Topic ID is required (use lowercase kebab-case, e.g. "ls-rpc").');
  }
  if (
    raw.includes('/') ||
    raw.includes('\\') ||
    raw.includes('..') ||
    raw.includes('\0') ||
    /[\r\n\t\s]/.test(raw)
  ) {
    throw new Error(`Invalid topic ID "${raw}": path separators, traversal sequences, and whitespace are forbidden.`);
  }
  if (!/^[a-zA-Z0-9-]+$/.test(raw)) {
    throw new Error(
      `Invalid topic ID "${raw}": only lowercase letters, digits, and single hyphens are allowed (e.g. "ls-rpc").`,
    );
  }
  const normalized = raw.toLowerCase();
  if (normalized.includes('--') || !TOPIC_ID_RE.test(normalized)) {
    throw new Error(
      `Invalid topic ID "${raw}": must be 1-64 chars of lowercase kebab-case without leading, trailing, or consecutive hyphens.`,
    );
  }
  if (WINDOWS_RESERVED_TOPIC_RE.test(normalized) || RESERVED_TOPIC_NAMES.has(normalized)) {
    throw new Error(`Invalid topic ID "${raw}": reserved name cannot be used as a topic ID.`);
  }
  return normalized;
}

export function normalizeKeywords(rawKeywords) {
  const items = Array.isArray(rawKeywords)
    ? rawKeywords
    : typeof rawKeywords === 'string'
      ? rawKeywords.split(/[,，;；\n]+/)
      : [];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const clean = String(item ?? '')
      .replace(/^`+|`+$/g, '')
      .replace(/\|/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= 20) break;
  }
  return out;
}

function sanitizeInlineMeta(str, maxLen = 180) {
  return String(str ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function sanitizeScopeFilename(scopeKey) {
  return String(scopeKey || '').replace(/[^a-z0-9_-]+/gi, '_');
}

export function getMemoryFilePath(baseDir, scopeKey = '') {
  if (baseDir) {
    return join(baseDir, '.agents', 'rules', 'project-memory.md');
  }
  if (scopeKey) {
    const safeName = `${sanitizeScopeFilename(scopeKey)}.md`;
    return join(getStateDir(), 'memories', safeName);
  }
  return '';
}

export function getMemoryTopicsDir(baseDir, scopeKey = '') {
  if (baseDir) {
    return join(baseDir, '.agents', 'memory');
  }
  if (scopeKey) {
    const safeName = `${sanitizeScopeFilename(scopeKey)}.topics`;
    return join(getStateDir(), 'memories', safeName);
  }
  return '';
}

export function getTopicRelativePath(topicId, baseDir = '') {
  const id = validateTopicId(topicId);
  return baseDir ? `.agents/memory/${id}.md` : `topics/${id}.md`;
}

export function getTopicFilePath(baseDir, scopeKey = '', topicId = '') {
  const id = validateTopicId(topicId);
  const topicsDir = getMemoryTopicsDir(baseDir, scopeKey);
  if (!topicsDir) return '';
  const resolvedDir = resolve(topicsDir);
  const target = resolve(resolvedDir, `${id}.md`);
  const dirPrefix = resolvedDir.endsWith(sep) ? resolvedDir : `${resolvedDir}${sep}`;
  const cmpTarget = process.platform === 'win32' ? target.toLowerCase() : target;
  const cmpPrefix = process.platform === 'win32' ? dirPrefix.toLowerCase() : dirPrefix;
  if (!cmpTarget.startsWith(cmpPrefix)) {
    throw new Error(`Topic path escaped memory directory for "${id}".`);
  }
  return target;
}

export function resolveGitExcludePathSync(repoOrWorktreeDir) {
  if (!repoOrWorktreeDir || !existsSync(repoOrWorktreeDir)) return '';
  try {
    const dotGit = join(repoOrWorktreeDir, '.git');
    if (!existsSync(dotGit)) return '';
    const st = statSync(dotGit);
    if (st.isDirectory()) {
      return join(dotGit, 'info', 'exclude');
    }
    if (st.isFile()) {
      const raw = readFileSync(dotGit, 'utf8');
      const m = raw.match(/^\s*gitdir:\s*(.+?)\s*$/im);
      if (!m) return '';
      const gitDir = resolve(repoOrWorktreeDir, m[1].trim());
      const commonDirFile = join(gitDir, 'commondir');
      if (existsSync(commonDirFile)) {
        const commonRel = readFileSync(commonDirFile, 'utf8').trim();
        if (commonRel) {
          const commonDir = resolve(gitDir, commonRel);
          return join(commonDir, 'info', 'exclude');
        }
      }
      return join(gitDir, 'info', 'exclude');
    }
  } catch {
    return '';
  }
  return '';
}

export function ensureGitExcludeSync(repoOrWorktreeDir, patterns = REPO_MEMORY_EXCLUDE_PATTERNS) {
  const excludePath = resolveGitExcludePathSync(repoOrWorktreeDir);
  if (!excludePath) return { ok: false, path: '', added: [] };
  try {
    mkdirSync(dirname(excludePath), { recursive: true });
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    const existingLines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
    const linesToAdd = (patterns || []).filter((p) => p && !existingLines.has(p));
    if (linesToAdd.length > 0) {
      const eol = existing.includes('\r\n') ? '\r\n' : '\n';
      const prefix = existing && !existing.endsWith('\n') ? eol : '';
      writeFileSync(excludePath, `${existing}${prefix}${linesToAdd.join(eol)}${eol}`, 'utf8');
    }
    return { ok: true, path: excludePath, added: linesToAdd };
  } catch {
    return { ok: false, path: excludePath, added: [] };
  }
}

export function buildLegacyV1MergeConventionsSection() {
  return [
    '## Worktree Merge & Archive Conventions',
    MERGE_CONVENTIONS_MARKER,
    '- **Worktree Isolation**: Perform all edits, checks, and commits strictly inside the assigned worktree directory and branch (`thread/<id>-<slug>`). Never edit files directly in the main repository checkout.',
    '- **Pre-Merge Verification**: Before integrating changes into the base branch, verify `git status` is clean inside the worktree and commit only scoped changes (do not `git push` unless explicitly instructed).',
    '- **Merge / Cherry-Pick Workflow**: Integrate committed worktree changes into the target branch from the main checkout according to project preference — either `git cherry-pick <commit>` (recommended for linear history) or `git merge --no-ff <thread-branch>` (or fast-forward merge).',
    '- **Archive & Auto-Cleanup**: After changes are merged or cherry-picked into the target branch, archive the thread via `archive_thread` (or the Project Threads Archive action). Cleanup automatically recognizes both ancestor merges and `cherry-pick` equivalent commits (`git cherry`) and safely removes the clean worktree and source branch (dirty or unmerged worktrees are preserved unless forced).',
  ].join('\n');
}

export function buildDefaultMergeConventionsSection() {
  return [
    MERGE_HYGIENE_START_MARKER,
    '## Worktree Merge & Archive Conventions',
    MERGE_CONVENTIONS_MARKER,
    '- **Worktree Isolation**: Perform all edits, checks, and commits strictly inside the assigned worktree directory and branch (`thread/<id>-<slug>`). Never edit files directly in the main repository checkout.',
    '- **Pre-Merge & Post-Merge Verification**: Before integrating or pushing, run `git fetch` when a remote is configured, verify `git status` is clean inside the worktree, commit only scoped changes (do not `git push` unless explicitly instructed), and run the full test/build suite after integrating parallel branches into the target branch (never rely on syntax checks alone).',
    '- **Merge / Cherry-Pick Workflow**: Integrate committed worktree changes into the target branch from the main checkout via `git cherry-pick <commit>` (recommended for linear history) or `git merge --no-ff <thread-branch>`; when parallel branches bump a monotonic version or migration sequence, re-increment on the later merge rather than reusing the same number.',
    '- **Archive & Auto-Cleanup**: Keep code-editing worktree threads open after merging or cherry-picking until the user confirms acceptance or requests archiving, then run `archive_thread` (or the Project Threads Archive action). Cleanup recognizes both ancestor merges and `cherry-pick` equivalent commits (`git cherry`) and safely removes clean worktrees and source branches (dirty or unmerged worktrees are preserved unless forced).',
    MERGE_HYGIENE_END_MARKER,
  ].join('\n');
}

function normalizeSectionTextForMatch(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

const KNOWN_UNMODIFIED_LEGACY_MERGE_SECTIONS = new Set([
  normalizeSectionTextForMatch(buildLegacyV1MergeConventionsSection()),
]);

export function hasMergeConventionsSection(markdownText) {
  const text = String(markdownText || '');
  if (!text) return false;
  return (
    MANAGED_MERGE_BLOCK_RE.test(text) ||
    text.includes(MERGE_CONVENTIONS_MARKER) ||
    MERGE_CONVENTIONS_HEADING_RE.test(text)
  );
}

export function upgradeManagedMergeConventions(markdownText) {
  const raw = String(markdownText || '');
  if (!raw.trim()) {
    return { changed: false, content: raw, status: 'empty' };
  }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const latestBlock = buildDefaultMergeConventionsSection().replace(/\n/g, eol);

  // Case 1: Existing managed block with explicit version marker
  const managedMatch = raw.match(MANAGED_MERGE_BLOCK_RE);
  if (managedMatch) {
    const version = Number(managedMatch[1]) || 0;
    if (version >= MERGE_HYGIENE_VERSION) {
      return { changed: false, content: raw, status: 'up_to_date' };
    }
    const innerNorm = normalizeSectionTextForMatch(managedMatch[2]);
    if (KNOWN_UNMODIFIED_LEGACY_MERGE_SECTIONS.has(innerNorm)) {
      const updated = raw.replace(managedMatch[0], latestBlock);
      return { changed: updated !== raw, content: updated, status: 'upgraded_managed' };
    }
    return { changed: false, content: raw, status: 'customized' };
  }

  // Case 2: Legacy unmarked default `## Worktree Merge & Archive Conventions` section
  const normRaw = raw.replace(/\r\n/g, '\n');
  const headingMatch = normRaw.match(/^## Worktree Merge & Archive Conventions[ \t]*$/m);
  if (headingMatch && typeof headingMatch.index === 'number') {
    const startIdx = headingMatch.index;
    const afterStart = normRaw.slice(startIdx + headingMatch[0].length);
    const nextHeadingOffset = afterStart.search(/\n##\s+|\n<!--\s*pt:managed:/);
    const endIdx =
      nextHeadingOffset >= 0
        ? startIdx + headingMatch[0].length + nextHeadingOffset
        : normRaw.length;
    const existingSection = normRaw.slice(startIdx, endIdx);
    const existingNorm = normalizeSectionTextForMatch(existingSection);
    if (KNOWN_UNMODIFIED_LEGACY_MERGE_SECTIONS.has(existingNorm)) {
      const trailingGap = existingSection.slice(existingSection.trimEnd().length);
      const replacedNorm =
        normRaw.slice(0, startIdx) +
        buildDefaultMergeConventionsSection() +
        trailingGap +
        normRaw.slice(endIdx);
      const restored = eol === '\r\n' ? replacedNorm.replace(/\n/g, '\r\n') : replacedNorm;
      return { changed: restored !== raw, content: restored, status: 'upgraded_legacy_v1' };
    }
    return { changed: false, content: raw, status: 'customized' };
  }

  if (hasMergeConventionsSection(raw)) {
    return { changed: false, content: raw, status: 'customized' };
  }
  return { changed: false, content: raw, status: 'missing' };
}

export function buildInitialProjectMemory(
  projectName = 'Project',
  { injectMergeConventions = true } = {},
) {
  const parts = [
    `# ${projectName} Shared Memory`,
    '',
    '> Auto-shared thin index across the Project Coordinator and all Worker Threads (keep concise <= 60 lines; store module details in `.agents/memory/<topic>.md`).',
    '',
    '## Architecture & Conventions',
    "- Keep changes scoped to each thread's assigned module and branch.",
    '',
    '## Active Decisions & Constraints',
    '- (Record cross-cutting decisions here via `update_project_memory`; put domain details in `.agents/memory/<topic>.md`.)',
  ];
  if (injectMergeConventions) {
    parts.push('', buildDefaultMergeConventionsSection());
  }
  return `${parts.join('\n')}\n`;
}

export function ensureProjectMemoryFile(
  baseDir,
  projectName = 'Project',
  scopeKey = '',
  { injectMergeConventions = true } = {},
) {
  const memPath = getMemoryFilePath(baseDir, scopeKey);
  if (!memPath) return '';
  const parent = dirname(memPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  // Layer 1 automatic hygiene: ensure .agents/memory/ dir and .git/info/exclude exist for repos
  if (baseDir) {
    const topicsDir = getMemoryTopicsDir(baseDir, scopeKey);
    if (topicsDir && !existsSync(topicsDir)) {
      mkdirSync(topicsDir, { recursive: true });
    }
    ensureGitExcludeSync(baseDir, REPO_MEMORY_EXCLUDE_PATTERNS);
  }

  if (!existsSync(memPath)) {
    writeFileAtomic(
      memPath,
      buildInitialProjectMemory(projectName, { injectMergeConventions }),
    );
    return memPath;
  }

  if (injectMergeConventions) {
    const existing = readFileSync(memPath, 'utf8');
    if (!existing.trim()) {
      writeFileAtomic(
        memPath,
        buildInitialProjectMemory(projectName, { injectMergeConventions: true }),
      );
    } else {
      const upgrade = upgradeManagedMergeConventions(existing);
      if (upgrade.changed) {
        writeFileAtomic(memPath, upgrade.content);
      } else if (upgrade.status === 'missing') {
        const eol = existing.includes('\r\n') ? '\r\n' : '\n';
        const mergeBlock = buildDefaultMergeConventionsSection().replace(/\n/g, eol);
        writeFileAtomic(memPath, `${existing.trimEnd()}${eol}${eol}${mergeBlock}${eol}`);
      }
    }
  }
  return memPath;
}

export function refreshExistingProjectMemoryHygiene(baseDir, scopeKey = '') {
  const memPath = getMemoryFilePath(baseDir, scopeKey);
  if (!memPath || !existsSync(memPath)) {
    return { upgraded: false, excluded: false };
  }
  let excluded = false;
  if (baseDir) {
    const topicsDir = getMemoryTopicsDir(baseDir, scopeKey);
    if (topicsDir && !existsSync(topicsDir)) {
      mkdirSync(topicsDir, { recursive: true });
    }
    const ex = ensureGitExcludeSync(baseDir, REPO_MEMORY_EXCLUDE_PATTERNS);
    excluded = ex.added.length > 0;
  }
  const existing = readFileSync(memPath, 'utf8');
  const upgrade = upgradeManagedMergeConventions(existing);
  if (upgrade.changed) {
    writeFileAtomic(memPath, upgrade.content);
    return { upgraded: true, excluded };
  }
  return { upgraded: false, excluded };
}

export function countMarkdownLines(text) {
  const s = String(text || '');
  if (!s) return 0;
  return s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length;
}

export function evaluateIndexBudget(content) {
  const text = String(content || '');
  const lineCount = countMarkdownLines(text);
  const byteSize = Buffer.byteLength(text, 'utf8');
  const overLines = lineCount > THIN_INDEX_SOFT_MAX_LINES;
  const overBytes = byteSize > THIN_INDEX_SOFT_MAX_BYTES;
  const overBudget = overLines || overBytes;
  const budgetWarning = overBudget
    ? `Thin index exceeds recommended soft budget (${lineCount} lines / ${byteSize} bytes; target <= ${THIN_INDEX_SOFT_MAX_LINES} lines and ~${THIN_INDEX_SOFT_MAX_BYTES} bytes). Prefer calling update_project_memory(mode="read"), moving module-specific details into topic files via update_project_memory(topic="<id>", ...), and consolidating project-memory.md with mode="replace".`
    : '';
  return {
    lineCount,
    byteSize,
    softMaxLines: THIN_INDEX_SOFT_MAX_LINES,
    softMaxBytes: THIN_INDEX_SOFT_MAX_BYTES,
    overLines,
    overBytes,
    overBudget,
    budgetWarning,
  };
}

function inferTitleFromBody(body, fallbackId) {
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*#\s+(.+?)\s*$/);
    if (m && m[1].trim()) return sanitizeInlineMeta(m[1], 100);
  }
  return fallbackId;
}

function inferSummaryFromBody(body) {
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith('<!--') || line.startsWith('|') || line.startsWith('```')) {
      continue;
    }
    const clean = line
      .replace(/^[-*+]\s+/, '')
      .replace(/^>\s+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1');
    if (clean.trim()) return sanitizeInlineMeta(clean, 160);
  }
  return '';
}

export function parseTopicDocument(rawText, topicId) {
  const raw = String(rawText || '');
  const m = raw.match(TOPIC_META_LINE_RE);
  let meta = {};
  let body = raw;
  if (m) {
    body = raw.slice(m[0].length);
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed && typeof parsed === 'object') meta = parsed;
    } catch {
      meta = {};
    }
  }
  const title = sanitizeInlineMeta(meta.title || '', 100) || inferTitleFromBody(body, topicId);
  const summary = sanitizeInlineMeta(meta.summary || '', 180) || inferSummaryFromBody(body);
  const keywords = normalizeKeywords(meta.keywords);
  return {
    id: topicId,
    title,
    keywords: keywords.length > 0 ? keywords : [topicId],
    summary,
    body,
    raw,
    lineCount: countMarkdownLines(raw),
    byteSize: Buffer.byteLength(raw, 'utf8'),
  };
}

export function formatTopicDocument({ id, title = '', keywords = [], summary = '', body = '' }) {
  const cleanId = validateTopicId(id);
  // Strip any leading existing meta comment from body to prevent duplicates
  const strippedBody = String(body || '').replace(TOPIC_META_LINE_RE, '');
  const resolvedTitle = sanitizeInlineMeta(title, 100) || inferTitleFromBody(strippedBody, cleanId);
  const resolvedSummary = sanitizeInlineMeta(summary, 180) || inferSummaryFromBody(strippedBody);
  const resolvedKeywords = normalizeKeywords(keywords);
  const finalKeywords = resolvedKeywords.length > 0 ? resolvedKeywords : [cleanId];
  const metaPayload = {
    title: resolvedTitle,
    keywords: finalKeywords,
    summary: resolvedSummary,
  };
  const metaLine = `<!-- pt:topic:meta ${JSON.stringify(metaPayload)} -->`;
  const normalizedBody = strippedBody.replace(/\r\n/g, '\n').replace(/^\n+/, '');
  const bodyPart = normalizedBody
    ? normalizedBody.endsWith('\n')
      ? normalizedBody
      : `${normalizedBody}\n`
    : `# ${resolvedTitle}\n`;
  return `${metaLine}\n${bodyPart}`;
}

function splitMarkdownTableCells(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('|')) return [];
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\' && inner[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (inner[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += inner[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

function escapeTableCell(str) {
  return String(str ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

export function parseTopicIndexTable(markdown) {
  const text = String(markdown || '');
  if (!text) return { hasTable: false, entries: [] };

  const managedMatch = text.match(MANAGED_TOPIC_INDEX_BLOCK_RE);
  const searchRegion = managedMatch ? managedMatch[0] : text;
  const lines = searchRegion.replace(/\r\n/g, '\n').split('\n');
  const entries = [];
  const seen = new Set();
  let hasTable = Boolean(managedMatch);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) continue;
    const cells = splitMarkdownTableCells(line);
    if (cells.length < 5) continue;
    // Skip separator row
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    // Detect header row
    if (/topic/i.test(cells[0]) && /(?:file|path|文件|路径|路徑)/i.test(cells[4])) {
      hasTable = true;
      continue;
    }
    const rawId = cells[0].replace(/^`+|`+$/g, '').trim();
    const rawFile = cells[4].replace(/^`+|`+$/g, '').trim();
    if (!rawId || (!rawFile.includes('.agents/memory/') && !rawFile.startsWith('topics/'))) {
      continue;
    }
    let validId = '';
    try {
      validId = validateTopicId(rawId);
    } catch {
      continue;
    }
    if (seen.has(validId)) continue;
    seen.add(validId);
    hasTable = true;
    const keywords = normalizeKeywords(cells[2]);
    entries.push({
      id: validId,
      title: sanitizeInlineMeta(cells[1], 100) || validId,
      keywords: keywords.length > 0 ? keywords : [validId],
      summary: sanitizeInlineMeta(cells[3], 180),
      relativePath: rawFile,
    });
  }

  return { hasTable, entries };
}

export function renderTopicIndexSection(topics = [], baseDir = '') {
  if (!Array.isArray(topics) || topics.length === 0) return '';
  const sorted = [...topics].sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
  const rows = sorted.map((t) => {
    const id = validateTopicId(t.id);
    const title = escapeTableCell(t.title || id);
    const kwList = normalizeKeywords(t.keywords);
    const kwCell = (kwList.length ? kwList : [id]).map((k) => `\`${escapeTableCell(k)}\``).join(', ');
    const summary = escapeTableCell(t.summary || '-');
    const relPath = escapeTableCell(t.relativePath || getTopicRelativePath(id, baseDir));
    return `| \`${id}\` | ${title} | ${kwCell} | ${summary} | \`${relPath}\` |`;
  });

  return [
    TOPIC_INDEX_START_MARKER,
    TOPIC_INDEX_SECTION_HEADING,
    '',
    '| `topic` ID | Topic | Keywords / Paths | Summary | File |',
    '| :--- | :--- | :--- | :--- | :--- |',
    ...rows,
    TOPIC_INDEX_END_MARKER,
  ].join('\n');
}

export function upsertTopicIndexSection(markdown, topics = [], baseDir = '') {
  const raw = String(markdown || '');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const rendered = renderTopicIndexSection(topics, baseDir);
  const renderedEol = rendered ? rendered.replace(/\n/g, eol) : '';

  // 1. Existing managed block
  if (MANAGED_TOPIC_INDEX_BLOCK_RE.test(raw)) {
    if (!renderedEol) {
      const cleaned = raw
        .replace(MANAGED_TOPIC_INDEX_BLOCK_RE, '')
        .replace(/(?:\r?\n){3,}/g, `${eol}${eol}`)
        .trimEnd();
      return cleaned ? `${cleaned}${eol}` : '';
    }
    return raw.replace(MANAGED_TOPIC_INDEX_BLOCK_RE, renderedEol);
  }

  // 2. Existing unmarked heading block (## Topic Knowledge Index / ## 专题知识索引)
  const normRaw = raw.replace(/\r\n/g, '\n');
  const hMatch = normRaw.match(TOPIC_INDEX_HEADING_RE);
  if (hMatch && typeof hMatch.index === 'number') {
    const startIdx = hMatch.index;
    const afterStart = normRaw.slice(startIdx + hMatch[0].length);
    const nextHeadingOffset = afterStart.search(/\n##\s+|\n<!--\s*pt:managed:/);
    const endIdx =
      nextHeadingOffset >= 0
        ? startIdx + hMatch[0].length + nextHeadingOffset
        : normRaw.length;
    const before = normRaw.slice(0, startIdx).trimEnd();
    const after = normRaw.slice(endIdx).replace(/^\n+/, '');
    const parts = [before, rendered, after].filter((p) => p && p.trim());
    const joined = parts.join('\n\n') + '\n';
    return eol === '\r\n' ? joined.replace(/\n/g, '\r\n') : joined;
  }

  // 3. No existing index block
  if (!renderedEol) return raw;
  const base = raw.trimEnd();
  if (!base) return `${renderedEol}${eol}`;
  return `${base}${eol}${eol}${renderedEol}${eol}`;
}

export function listMemoryTopics(baseDir, scopeKey = '', { indexMarkdown = null } = {}) {
  const topicsDir = getMemoryTopicsDir(baseDir, scopeKey);
  const memPath = getMemoryFilePath(baseDir, scopeKey);
  const idxText =
    indexMarkdown !== null
      ? String(indexMarkdown || '')
      : memPath && existsSync(memPath)
        ? readFileSync(memPath, 'utf8')
        : '';
  const { entries: idxEntries } = parseTopicIndexTable(idxText);
  const idxMap = new Map(idxEntries.map((e) => [e.id, e]));

  const topics = [];
  if (topicsDir && existsSync(topicsDir)) {
    let files = [];
    try {
      files = readdirSync(topicsDir);
    } catch {
      files = [];
    }
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const stem = file.slice(0, -3);
      let id = '';
      try {
        id = validateTopicId(stem);
      } catch {
        continue;
      }
      if (id !== stem) continue;
      const fullPath = join(topicsDir, file);
      let st;
      try {
        st = statSync(fullPath);
        if (!st.isFile()) continue;
      } catch {
        continue;
      }
      const raw = readFileSync(fullPath, 'utf8');
      const parsed = parseTopicDocument(raw, id);
      const fromIdx = idxMap.get(id);
      const hasExplicitMeta = TOPIC_META_LINE_RE.test(raw);
      const mergedTitle = hasExplicitMeta ? parsed.title : fromIdx?.title || parsed.title;
      const mergedKeywords = hasExplicitMeta
        ? parsed.keywords
        : fromIdx?.keywords?.length
          ? fromIdx.keywords
          : parsed.keywords;
      const mergedSummary = hasExplicitMeta
        ? parsed.summary
        : fromIdx?.summary || parsed.summary;
      topics.push({
        id,
        title: mergedTitle,
        keywords: mergedKeywords,
        summary: mergedSummary,
        relativePath: getTopicRelativePath(id, baseDir),
        path: fullPath,
        lineCount: parsed.lineCount,
        byteSize: parsed.byteSize,
        updatedAt: st.mtime ? st.mtime.toISOString() : '',
      });
    }
  }

  topics.sort((a, b) => a.id.localeCompare(b.id));
  return topics;
}

export function resolveNextLegacyTopicId(baseDir, scopeKey = '') {
  const topicsDir = getMemoryTopicsDir(baseDir, scopeKey);
  if (!topicsDir || !existsSync(topicsDir)) return 'legacy';
  if (!existsSync(join(topicsDir, 'legacy.md'))) return 'legacy';
  for (let i = 2; i <= 999; i++) {
    const candidate = `legacy-${i}`;
    if (!existsSync(join(topicsDir, `${candidate}.md`))) return candidate;
  }
  return `legacy-${Date.now()}`;
}

export function inspectMemoryMigrationStatus(
  baseDir,
  scopeKey = '',
  { content = null, topics = null } = {},
) {
  const memPath = getMemoryFilePath(baseDir, scopeKey);
  const text =
    content !== null
      ? String(content || '')
      : memPath && existsSync(memPath)
        ? readFileSync(memPath, 'utf8')
        : '';
  const budget = evaluateIndexBudget(text);
  const topicList = Array.isArray(topics)
    ? topics
    : listMemoryTopics(baseDir, scopeKey, { indexMarkdown: text });
  const { hasTable: hasTopicIndexTable } = parseTopicIndexTable(text);
  const exceedsFlatThreshold =
    budget.lineCount > THIN_INDEX_SOFT_MAX_LINES ||
    budget.byteSize > THIN_INDEX_SOFT_MAX_BYTES;
  const needsMigration = Boolean(
    text.trim() && exceedsFlatThreshold && topicList.length === 0 && !hasTopicIndexTable,
  );
  return {
    needsMigration,
    reason: needsMigration ? 'flat_oversized_memory' : '',
    lineCount: budget.lineCount,
    byteSize: budget.byteSize,
    softMaxLines: budget.softMaxLines,
    softMaxBytes: budget.softMaxBytes,
    overBudget: budget.overBudget,
    topicCount: topicList.length,
    hasTopicIndexTable,
    suggestedLegacyTopicId: resolveNextLegacyTopicId(baseDir, scopeKey),
  };
}

export function readProjectMemory(baseDir, scopeKey = '') {
  const memPath = getMemoryFilePath(baseDir, scopeKey);
  const topicsDir = getMemoryTopicsDir(baseDir, scopeKey);
  const content = memPath && existsSync(memPath) ? readFileSync(memPath, 'utf8') : '';
  const topics = listMemoryTopics(baseDir, scopeKey, { indexMarkdown: content });
  const budget = evaluateIndexBudget(content);
  const migration = inspectMemoryMigrationStatus(baseDir, scopeKey, { content, topics });
  return {
    path: memPath || '',
    content,
    topicsDir: topicsDir || '',
    topics,
    budget,
    budgetWarning: budget.budgetWarning,
    migration,
  };
}

export function readMemoryTopic(baseDir, scopeKey = '', topicId = '') {
  const id = validateTopicId(topicId);
  const filePath = getTopicFilePath(baseDir, scopeKey, id);
  const relativePath = getTopicRelativePath(id, baseDir);
  if (!filePath || !existsSync(filePath)) {
    return {
      exists: false,
      id,
      title: id,
      keywords: [id],
      summary: '',
      content: '',
      raw: '',
      path: filePath || '',
      relativePath,
      lineCount: 0,
      byteSize: 0,
      updatedAt: '',
    };
  }
  const raw = readFileSync(filePath, 'utf8');
  const parsed = parseTopicDocument(raw, id);
  const st = statSync(filePath);
  const memPath = getMemoryFilePath(baseDir, scopeKey);
  const idxText = memPath && existsSync(memPath) ? readFileSync(memPath, 'utf8') : '';
  const { entries } = parseTopicIndexTable(idxText);
  const idxEntry = entries.find((e) => e.id === id);
  const hasExplicitMeta = TOPIC_META_LINE_RE.test(raw);
  return {
    exists: true,
    id,
    title: hasExplicitMeta ? parsed.title : idxEntry?.title || parsed.title,
    keywords: hasExplicitMeta
      ? parsed.keywords
      : idxEntry?.keywords?.length
        ? idxEntry.keywords
        : parsed.keywords,
    summary: hasExplicitMeta ? parsed.summary : idxEntry?.summary || parsed.summary,
    content: parsed.body,
    raw,
    path: filePath,
    relativePath,
    lineCount: parsed.lineCount,
    byteSize: parsed.byteSize,
    updatedAt: st.mtime ? st.mtime.toISOString() : '',
  };
}

export function syncTopicIndexInThinMemory(baseDir, scopeKey = '', projectName = 'Project') {
  const memPath = ensureProjectMemoryFile(baseDir, projectName, scopeKey);
  if (!memPath) return readProjectMemory(baseDir, scopeKey);
  return withMemoryLock(memPath, () => {
    const current = existsSync(memPath) ? readFileSync(memPath, 'utf8') : '';
    const topics = listMemoryTopics(baseDir, scopeKey, { indexMarkdown: current });
    const next = upsertTopicIndexSection(current, topics, baseDir);
    if (next !== current) {
      writeFileAtomic(memPath, next);
    }
    return readProjectMemory(baseDir, scopeKey);
  });
}

export function writeMemoryTopic({
  baseDir,
  scopeKey = '',
  projectName = 'Project',
  topic,
  title = '',
  keywords,
  summary = '',
  content = '',
  mode = 'replace',
  section = '',
  createOnly = false,
}) {
  const id = validateTopicId(topic);
  const memPath = ensureProjectMemoryFile(baseDir, projectName, scopeKey);
  const topicsDir = getMemoryTopicsDir(baseDir, scopeKey);
  if (!topicsDir) {
    throw new Error('Unable to resolve project memory topics directory.');
  }
  mkdirSync(topicsDir, { recursive: true });
  if (baseDir) {
    ensureGitExcludeSync(baseDir, REPO_MEMORY_EXCLUDE_PATTERNS);
  }

  return withMemoryLock(memPath || topicsDir, () => {
    const filePath = getTopicFilePath(baseDir, scopeKey, id);
    const alreadyExists = existsSync(filePath);
    if (createOnly && alreadyExists) {
      const err = new Error(
        `Topic "${id}" already exists. Choose a different topic ID or edit the existing topic instead.`,
      );
      err.code = 'TOPIC_ALREADY_EXISTS';
      throw err;
    }
    const existing = alreadyExists ? readMemoryTopic(baseDir, scopeKey, id) : null;

    let nextBody = String(content ?? '');
    const hasIncomingMeta = TOPIC_META_LINE_RE.test(nextBody);
    const parsedIncoming = hasIncomingMeta ? parseTopicDocument(nextBody, id) : null;
    if (parsedIncoming) {
      nextBody = parsedIncoming.body;
    }

    const normMode = String(mode || 'replace').trim().toLowerCase();
    if (normMode === 'append' && existing?.exists) {
      const trimmedAdd = nextBody.trim();
      if (trimmedAdd) {
        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
        const bullet = trimmedAdd.startsWith('-') || trimmedAdd.startsWith('#')
          ? trimmedAdd
          : `- [${stamp}] ${trimmedAdd}`;
        const baseBody = existing.content || '';
        if (section && section.trim()) {
          const header = `## ${section.trim()}`;
          if (baseBody.includes(header)) {
            nextBody = baseBody.replace(header, `${header}\n${bullet}`);
          } else {
            nextBody = `${baseBody.trimEnd()}\n\n${header}\n${bullet}\n`;
          }
        } else {
          nextBody = `${baseBody.trimEnd()}\n${bullet}\n`;
        }
      } else {
        nextBody = existing.content || '';
      }
    }

    const resolvedTitle =
      sanitizeInlineMeta(title, 100) ||
      (parsedIncoming ? parsedIncoming.title : '') ||
      (existing?.exists ? existing.title : '') ||
      inferTitleFromBody(nextBody, id);
    const hasKeywordsArg = keywords !== undefined && keywords !== null && keywords !== '';
    const resolvedKeywords = hasKeywordsArg
      ? normalizeKeywords(keywords)
      : parsedIncoming?.keywords?.length
        ? parsedIncoming.keywords
        : existing?.exists && existing.keywords?.length
          ? existing.keywords
          : [id];
    const resolvedSummary =
      sanitizeInlineMeta(summary, 180) ||
      (parsedIncoming ? parsedIncoming.summary : '') ||
      (existing?.exists ? existing.summary : '') ||
      inferSummaryFromBody(nextBody);

    const formatted = formatTopicDocument({
      id,
      title: resolvedTitle,
      keywords: resolvedKeywords,
      summary: resolvedSummary,
      body: nextBody,
    });

    writeFileAtomic(filePath, formatted);
    const memory = syncTopicIndexInThinMemory(baseDir, scopeKey, projectName);
    const savedTopic = readMemoryTopic(baseDir, scopeKey, id);
    return {
      topic: savedTopic,
      memory,
      topics: memory.topics,
      budget: memory.budget,
      budgetWarning: memory.budgetWarning,
      migration: memory.migration,
    };
  });
}

export function deleteMemoryTopic({
  baseDir,
  scopeKey = '',
  projectName = 'Project',
  topic,
}) {
  const id = validateTopicId(topic);
  const memPath = getMemoryFilePath(baseDir, scopeKey);
  const filePath = getTopicFilePath(baseDir, scopeKey, id);
  return withMemoryLock(memPath || filePath, () => {
    let deleted = false;
    if (filePath && existsSync(filePath)) {
      unlinkSync(filePath);
      deleted = true;
    }
    const memory = syncTopicIndexInThinMemory(baseDir, scopeKey, projectName);
    return {
      deleted,
      id,
      path: filePath || '',
      memory,
      topics: memory.topics,
      budget: memory.budget,
      budgetWarning: memory.budgetWarning,
      migration: memory.migration,
    };
  });
}

export function archiveMemoryToLegacyTopic({
  baseDir,
  scopeKey = '',
  projectName = 'Project',
  _verifyPersisted = null,
}) {
  const memPath = getMemoryFilePath(baseDir, scopeKey);
  if (!memPath || !existsSync(memPath)) {
    throw new Error('No existing project-memory.md found to archive.');
  }

  return withMemoryLock(memPath, () => {
    if (!existsSync(memPath)) {
      throw new Error('No existing project-memory.md found to archive.');
    }
    const originalRaw = readFileSync(memPath, 'utf8');
    if (!originalRaw.trim()) {
      throw new Error('Existing project-memory.md is empty; nothing to archive.');
    }

    const topicsDir = getMemoryTopicsDir(baseDir, scopeKey);
    if (!topicsDir) {
      throw new Error('Unable to resolve project memory topics directory.');
    }
    mkdirSync(topicsDir, { recursive: true });
    if (baseDir) {
      ensureGitExcludeSync(baseDir, REPO_MEMORY_EXCLUDE_PATTERNS);
    }

    const legacyId = resolveNextLegacyTopicId(baseDir, scopeKey);
    const legacyPath = getTopicFilePath(baseDir, scopeKey, legacyId);
    if (existsSync(legacyPath)) {
      throw new Error(`Refusing to overwrite existing topic file: ${legacyPath}`);
    }

    const originalLineCount = countMarkdownLines(originalRaw);
    const originalByteSize = Buffer.byteLength(originalRaw, 'utf8');
    const legacyTitle =
      legacyId === 'legacy' ? 'Legacy Project Memory Archive' : `Legacy Project Memory Archive (${legacyId})`;
    const legacySummary = `Lossless archive of previous flat project-memory.md (${originalLineCount} lines).`;
    const legacyDoc = formatTopicDocument({
      id: legacyId,
      title: legacyTitle,
      keywords: [legacyId, 'archive', 'history', 'project-memory'],
      summary: legacySummary,
      body: originalRaw,
    });

    const expectedStripped = normalizeEol(originalRaw)
      .replace(TOPIC_META_LINE_RE, '')
      .replace(/^\n+/, '');
    const expectedNormalizedBody = expectedStripped
      ? expectedStripped.endsWith('\n')
        ? expectedStripped
        : `${expectedStripped}\n`
      : '';

    let wroteLegacy = false;
    try {
      // Stage 1: Atomically write legacy topic and verify EOL-normalized content BEFORE touching project-memory.md
      writeFileAtomic(legacyPath, legacyDoc);
      wroteLegacy = true;

      if (!existsSync(legacyPath)) {
        throw new Error(`Failed to persist legacy topic archive at ${legacyPath}.`);
      }
      const persistedRaw = readFileSync(legacyPath, 'utf8');
      const parsedPersisted = parseTopicDocument(persistedRaw, legacyId);
      const persistedNormalizedBody = normalizeEol(parsedPersisted.body);
      const verified =
        typeof _verifyPersisted === 'function'
          ? Boolean(_verifyPersisted({ persistedRaw, persistedNormalizedBody, expectedNormalizedBody, legacyPath }))
          : persistedNormalizedBody === expectedNormalizedBody;
      if (!verified) {
        throw new Error(
          'Legacy topic verification failed: persisted content did not match source memory after EOL normalization.',
        );
      }
    } catch (err) {
      // Roll back the orphaned legacy file so project-memory.md, topic count, and migration banner stay intact
      if (wroteLegacy && existsSync(legacyPath)) {
        try {
          unlinkSync(legacyPath);
        } catch {
          // Best-effort rollback cleanup
        }
      }
      throw err;
    }

    // Stage 2: Rewrite project-memory.md to concise thin index linked to the archived legacy topic
    const thinBase = buildInitialProjectMemory(projectName, { injectMergeConventions: true });
    const topics = listMemoryTopics(baseDir, scopeKey, { indexMarkdown: '' });
    const thinWithIndex = upsertTopicIndexSection(thinBase, topics, baseDir);
    writeFileAtomic(memPath, thinWithIndex);

    const memory = readProjectMemory(baseDir, scopeKey);
    const legacyTopic = readMemoryTopic(baseDir, scopeKey, legacyId);
    return {
      legacyTopic,
      originalLineCount,
      originalByteSize,
      memory,
      topics: memory.topics,
      budget: memory.budget,
      budgetWarning: memory.budgetWarning,
      migration: memory.migration,
    };
  });
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchKeywordInText(kwLower, textLower) {
  if (!kwLower || !textLower) return false;
  const hasCjk = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(kwLower);
  const isPathLike = kwLower.includes('/') || kwLower.includes('\\') || /\.[a-z0-9]{1,5}$/.test(kwLower);
  if (hasCjk || isPathLike) {
    return textLower.includes(kwLower);
  }
  // ASCII identifier / token: require non-alphanumeric boundaries so short keywords don't false-match
  const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(kwLower)}(?=$|[^a-z0-9])`, 'i');
  return re.test(textLower);
}

export function recommendTopicsForTask({
  title = '',
  taskPrompt = '',
  topics = [],
  indexMarkdown = '',
  maxTopics = 2,
} = {}) {
  const titleNorm = String(title || '').replace(/\\/g, '/').toLowerCase();
  const promptNorm = String(taskPrompt || '').replace(/\\/g, '/').toLowerCase();
  if (!titleNorm.trim() && !promptNorm.trim()) return [];

  // Merge disk topics with any entries from indexMarkdown (deduped by id)
  const mergedMap = new Map();
  if (indexMarkdown) {
    const { entries } = parseTopicIndexTable(indexMarkdown);
    for (const e of entries) {
      mergedMap.set(e.id, { ...e });
    }
  }
  for (const t of Array.isArray(topics) ? topics : []) {
    if (!t || !t.id) continue;
    const prev = mergedMap.get(t.id);
    mergedMap.set(t.id, {
      id: t.id,
      title: t.title || prev?.title || t.id,
      keywords: normalizeKeywords([...(t.keywords || []), ...(prev?.keywords || [])]),
      summary: t.summary || prev?.summary || '',
      relativePath: t.relativePath || prev?.relativePath || `.agents/memory/${t.id}.md`,
      path: t.path || '',
    });
  }

  const scored = [];
  for (const topic of mergedMap.values()) {
    let score = 0;
    const matchedKeywords = [];
    const matchedSet = new Set();
    const recordMatch = (kw, pts) => {
      score += pts;
      const k = kw.toLowerCase();
      if (!matchedSet.has(k)) {
        matchedSet.add(k);
        matchedKeywords.push(kw);
      }
    };

    const idLower = String(topic.id || '').toLowerCase();
    if (idLower && idLower !== 'legacy') {
      if (matchKeywordInText(idLower, titleNorm)) recordMatch(topic.id, 7);
      else if (matchKeywordInText(idLower, promptNorm)) recordMatch(topic.id, 5);
    }

    const topicTitle = String(topic.title || '').trim();
    const topicTitleLower = topicTitle.toLowerCase();
    if (topicTitleLower && topicTitleLower !== idLower && topicTitleLower.length >= 2) {
      if (matchKeywordInText(topicTitleLower, titleNorm)) recordMatch(topicTitle, 5);
      else if (matchKeywordInText(topicTitleLower, promptNorm)) recordMatch(topicTitle, 3);
    }

    for (const kw of topic.keywords || []) {
      const kwNorm = String(kw || '').replace(/\\/g, '/').trim();
      const kwLower = kwNorm.toLowerCase();
      if (!kwLower || kwLower.length < 2) continue;
      const isPathLike =
        kwLower.includes('/') || /\.(?:mjs|cjs|js|ts|tsx|jsx|css|html|json|md|py|go|rs|sql|sh|cmd)$/.test(kwLower);
      const inTitle = matchKeywordInText(kwLower, titleNorm);
      const inPrompt = matchKeywordInText(kwLower, promptNorm);
      if (inTitle || inPrompt) {
        const basePts = isPathLike ? 6 : /[\u4e00-\u9fff]/.test(kwLower) ? 4 : 4;
        const titleBonus = inTitle ? 2 : 0;
        recordMatch(kwNorm, basePts + titleBonus);
      }
    }

    if (score > 0) {
      scored.push({
        id: topic.id,
        title: topic.title || topic.id,
        summary: topic.summary || '',
        relativePath: topic.relativePath || `.agents/memory/${topic.id}.md`,
        path: topic.path || '',
        matchedKeywords,
        score,
      });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.matchedKeywords.length !== a.matchedKeywords.length) {
      return b.matchedKeywords.length - a.matchedKeywords.length;
    }
    return a.id.localeCompare(b.id);
  });

  const limit = Math.max(0, Math.min(5, Number(maxTopics) || 2));
  return scored.slice(0, limit);
}

export function syncMemoryFilesToWorktree({ repoRoot = '', scopeKey = '', worktreePath = '' }) {
  if (!worktreePath || !existsSync(worktreePath)) return { syncedIndex: false, syncedTopics: 0 };
  const rulesDir = join(worktreePath, '.agents', 'rules');
  const dstTopicsDir = join(worktreePath, '.agents', 'memory');
  mkdirSync(rulesDir, { recursive: true });
  mkdirSync(dstTopicsDir, { recursive: true });

  let syncedIndex = false;
  const srcMem = getMemoryFilePath(repoRoot, scopeKey);
  if (srcMem && existsSync(srcMem)) {
    copyFileSync(srcMem, join(rulesDir, 'project-memory.md'));
    syncedIndex = true;
  }

  const srcTopicsDir = getMemoryTopicsDir(repoRoot, scopeKey);
  const activeTopicFiles = new Set();
  let syncedTopics = 0;
  if (srcTopicsDir && existsSync(srcTopicsDir)) {
    let entries = [];
    try {
      entries = readdirSync(srcTopicsDir);
    } catch {
      entries = [];
    }
    for (const file of entries) {
      if (!file.endsWith('.md')) continue;
      const stem = file.slice(0, -3);
      try {
        if (validateTopicId(stem) !== stem) continue;
      } catch {
        continue;
      }
      const srcFile = join(srcTopicsDir, file);
      try {
        if (!statSync(srcFile).isFile()) continue;
      } catch {
        continue;
      }
      copyFileSync(srcFile, join(dstTopicsDir, file));
      activeTopicFiles.add(file);
      syncedTopics += 1;
    }
  }

  // Remove deleted topic files from worktree so deletions propagate cleanly
  try {
    for (const existingFile of readdirSync(dstTopicsDir)) {
      if (!existingFile.endsWith('.md')) continue;
      if (!activeTopicFiles.has(existingFile)) {
        try {
          unlinkSync(join(dstTopicsDir, existingFile));
        } catch {
          // Non-fatal
        }
      }
    }
  } catch {
    // Non-fatal
  }

  ensureGitExcludeSync(worktreePath, WORKTREE_MEMORY_EXCLUDE_PATTERNS);
  return { syncedIndex, syncedTopics };
}
