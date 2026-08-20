import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexHome, findProjectRoot } from '../util/paths.js';
import { readText, inspectJSON, readJSONStrict, writeJSON, writeAtomic, exists, ensureDir } from '../util/fsx.js';
import { hasManagedBlock, removeManagedBlock, upsertManagedBlock } from '../util/managed.js';
import { compileContext } from '../core/compile.js';
import { activeGuards } from '../core/guards.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BIN = path.resolve(HERE, '..', '..', 'bin', 'wife.js');

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function schemaProblem(value) {
  if (!isRecord(value)) return 'expected the document root to be an object';
  if (value.hooks !== undefined && !isRecord(value.hooks)) return 'expected "hooks" to be an object';
  for (const [event, groups] of Object.entries(value.hooks || {})) {
    if (!Array.isArray(groups)) return `expected hooks.${event} to be an array`;
    for (let i = 0; i < groups.length; i++) {
      if (!isRecord(groups[i])) return `expected hooks.${event}[${i}] to be an object`;
      if (!Array.isArray(groups[i].hooks)) return `expected hooks.${event}[${i}].hooks to be an array`;
    }
  }
  return null;
}

function readHooksDocument(file) {
  const value = readJSONStrict(file, null);
  const problem = schemaProblem(value);
  if (problem) throw new Error(`Invalid JSON structure in ${file}: ${problem}`);
  return value;
}

export const BEGIN = '<!-- wife:begin — managed block, edited by `wife sync-codex`. Your own text is safe outside it. -->';
export const END = '<!-- wife:end -->';

/**
 * Codex CLI integration.
 *
 * Codex's hook engine went stable in v0.124.0 and uses the same event names as
 * Claude Code — SessionStart, UserPromptSubmit, PreToolUse — so wife's existing
 * lifecycle commands work unchanged. Three differences are load-bearing:
 *
 *   - the session ends on `Stop`, not `SessionEnd`
 *   - a PreToolUse hook blocks by exiting 2 with the reason on stderr, where
 *     Claude Code expects a permissionDecision object on stdout
 *   - older builds need `[features] codex_hooks = true` in config.toml
 *
 * The AGENTS.md block is kept as a fallback for versions predating the hook
 * engine. It only injects; it never learns.
 */

export function hooksPath({ project = false, cwd = process.cwd() } = {}) {
  return project
    ? path.join(findProjectRoot(cwd), '.codex', 'hooks.json')
    : path.join(codexHome(), 'hooks.json');
}

export function agentsPath({ project = false, cwd = process.cwd() } = {}) {
  return project ? path.join(findProjectRoot(cwd), 'AGENTS.md') : path.join(codexHome(), 'AGENTS.md');
}

export function codexHooks(nodeBin = process.execPath) {
  const cmd = (args) => `"${nodeBin}" "${BIN}" ${args}`;
  const hooks = {
    SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: cmd('inject --agent codex'), timeout: 15, statusMessage: 'Loading wife memory' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('capture --agent codex'), timeout: 10 }] }],
    Stop: [{ hooks: [{ type: 'command', command: cmd('harvest --stdin --quiet'), timeout: 30 }] }],
  };
  if (hasGuards()) {
    hooks.PreToolUse = [{ matcher: '.*', hooks: [{ type: 'command', command: cmd('guard --style codex'), timeout: 10 }] }];
  }
  return hooks;
}

const hasGuards = () => { try { return activeGuards().length > 0; } catch { return false; } };

export function isWifeHandler(handler) {
  const c = typeof handler?.command === 'string' ? handler.command : '';
  return /(?:^|[\\/])wife\.js(?:$|["'\s])/.test(c);
}

function removeWifeHooks(hooks) {
  for (const [event, groups] of Object.entries(hooks || {})) {
    if (!Array.isArray(groups)) continue;
    const cleaned = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isWifeHandler(h)) }))
      .filter((g) => (g.hooks || []).length > 0);
    if (cleaned.length) hooks[event] = cleaned;
    else delete hooks[event];
  }
}

/**
 * Older Codex builds gate the hook engine behind a feature flag. Appending it
 * is harmless on versions where hooks are already stable, and without it the
 * hooks are silently ignored on the versions that still need it.
 */
function ensureFeatureFlag() {
  const file = path.join(codexHome(), 'config.toml');
  const current = readText(file, '');
  if (/codex_hooks\s*=\s*true/.test(current)) return false;
  ensureDir(path.dirname(file));
  const block = '\n[features]\ncodex_hooks = true\n';
  if (/^\[features\]/m.test(current)) {
    // Anchor tightly: `^\s*` swallowed the blank line above the table and
    // reformatted the user's config for no reason. Touch only the line itself.
    writeAtomic(file, current.replace(/^\[features\][ \t]*$/m, '[features]\ncodex_hooks = true'));
  } else {
    writeAtomic(file, `${current.trimEnd()}${current.trim() ? '\n' : ''}${block}`);
  }
  return true;
}

export function attachCodex({ project = false, cwd = process.cwd(), nodeBin = process.execPath, includeProject = project } = {}) {
  const file = hooksPath({ project, cwd });
  const existing = exists(file) ? readHooksDocument(file) : { version: 1, hooks: {} };
  const preparedFallback = prepareAttachCodexBlock({ project, cwd, includeProject });
  existing.hooks = existing.hooks || {};
  removeWifeHooks(existing.hooks);

  const wanted = codexHooks(nodeBin);
  const events = [];
  for (const [event, groups] of Object.entries(wanted)) {
    const prior = Array.isArray(existing.hooks[event]) ? existing.hooks[event] : [];
    existing.hooks[event] = [...prior, ...groups];
    events.push(event);
  }
  existing.version = existing.version || 1;
  ensureDir(path.dirname(file));
  writeJSON(file, existing);

  const flagged = ensureFeatureFlag();
  const fallback = commitAttachCodexBlock(preparedFallback);
  return { file, events, flagged, fallback: fallback.file };
}

export function detachCodex({ project = false, cwd = process.cwd() } = {}) {
  const file = hooksPath({ project, cwd });
  let removed = 0;
  const existing = exists(file) ? readHooksDocument(file) : null;
  const preparedBlock = prepareDetachCodexBlock({ project, cwd });
  if (existing?.hooks) {
    for (const [event, groups] of Object.entries(existing.hooks)) {
      if (!Array.isArray(groups)) continue;
      const cleaned = groups
        .map((g) => {
          const kept = (g.hooks || []).filter((h) => { if (isWifeHandler(h)) { removed++; return false; } return true; });
          return { ...g, hooks: kept };
        })
        .filter((g) => (g.hooks || []).length > 0);
      if (cleaned.length) existing.hooks[event] = cleaned;
      else delete existing.hooks[event];
    }
    writeJSON(file, existing);
  }
  const block = commitDetachCodexBlock(preparedBlock);
  return { file, removed, missing: !existing, block: block.file };
}

export function codexStatus({ project = false, cwd = process.cwd() } = {}) {
  const file = hooksPath({ project, cwd });
  const inspected = inspectJSON(file, null);
  const invalid = Boolean(inspected.error || (!inspected.missing && schemaProblem(inspected.value)));
  const existing = invalid ? null : inspected.value;
  const events = existing?.hooks
    ? Object.entries(existing.hooks)
        .filter(([, g]) => Array.isArray(g) && g.some((x) => (x.hooks || []).some(isWifeHandler)))
        .map(([e]) => e)
    : [];
  const md = readText(agentsPath({ project, cwd }), null);
  return {
    file,
    attached: events.length > 0,
    events,
    blockOnly: events.length === 0 && Boolean(md && hasManagedBlock(md)),
    invalid,
  };
}

/* ---- AGENTS.md fallback, for builds older than the hook engine ---- */

export function renderBlock({ cwd = process.cwd(), includeProject = true } = {}) {
  const { text, empty } = compileContext({ cwd, includeProject });
  const body = empty
    ? '_No memory recorded yet. Run `wife remember "..."` or let wife learn from your prompts._'
    : text.trim();
  return [BEGIN, '', body, '', `_Regenerate with \`wife sync-codex\`. Last updated ${new Date().toISOString().slice(0, 10)}._`, '', END].join('\n');
}

export function upsertBlock(existing, block) {
  return upsertManagedBlock(existing, block);
}

function prepareAttachCodexBlock({ project = false, cwd = process.cwd(), includeProject = project } = {}) {
  const file = agentsPath({ project, cwd });
  const existed = exists(file);
  const next = upsertBlock(readText(file, ''), renderBlock({ cwd, includeProject }));
  return { file, existed, next };
}

function commitAttachCodexBlock(prepared) {
  ensureDir(path.dirname(prepared.file));
  writeAtomic(prepared.file, prepared.next.endsWith('\n') ? prepared.next : `${prepared.next}\n`);
  return { file: prepared.file, existed: prepared.existed, bytes: prepared.next.length };
}

export function attachCodexBlock({ project = false, cwd = process.cwd(), includeProject = project } = {}) {
  return commitAttachCodexBlock(prepareAttachCodexBlock({ project, cwd, includeProject }));
}

function prepareDetachCodexBlock({ project = false, cwd = process.cwd() } = {}) {
  const file = agentsPath({ project, cwd });
  if (!exists(file)) return { file, removed: false, missing: true, write: false };
  const result = removeManagedBlock(readText(file, ''));
  return { file, removed: result.removed, missing: false, write: result.removed, next: result.text };
}

function commitDetachCodexBlock(prepared) {
  if (prepared.write) writeAtomic(prepared.file, prepared.next.trim() ? prepared.next : '');
  return { file: prepared.file, removed: prepared.removed, missing: prepared.missing };
}

export function detachCodexBlock({ project = false, cwd = process.cwd() } = {}) {
  return commitDetachCodexBlock(prepareDetachCodexBlock({ project, cwd }));
}
