import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { findProjectRoot } from '../util/paths.js';
import { inspectJSON, readJSONStrict, writeJSON, writeAtomic, readText, exists, ensureDir, removeFile } from '../util/fsx.js';
import { compileContext } from '../core/compile.js';
import { activeGuards } from '../core/guards.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BIN = path.resolve(HERE, '..', '..', 'bin', 'wife.js');

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function schemaProblem(value) {
  if (!isRecord(value)) return 'expected the document root to be an object';
  if (value.hooks !== undefined && !isRecord(value.hooks)) return 'expected "hooks" to be an object';
  for (const [event, handlers] of Object.entries(value.hooks || {})) {
    if (!Array.isArray(handlers)) return `expected hooks.${event} to be an array`;
  }
  return null;
}

function readHooksDocument(file) {
  const value = readJSONStrict(file, null);
  const problem = schemaProblem(value);
  if (problem) throw new Error(`Invalid JSON structure in ${file}: ${problem}`);
  return value;
}

/**
 * Cursor integration.
 *
 * Cursor's hooks (1.7+) cover capture and blocking well, but there is no
 * session-start event whose output becomes context — the closest,
 * beforeSubmitPrompt, gates prompts rather than adding to them.
 *
 * So injection goes through a rules file instead, and the `stop` hook
 * regenerates it at the end of every session. The loop still closes: what you
 * said today is written to the rules file when the session ends, and Cursor
 * loads it at the start of the next one. One session behind on brand new facts,
 * current on everything else.
 *
 * Payload names differ from the other agents and this matters: Cursor sends
 * `conversation_id` where the others send `session_id`, and `text` where they
 * send `prompt`. Blocking is `{ permission: "deny" }`, not an exit code.
 */

export function cursorHome() {
  return process.env.CURSOR_HOME || path.join(os.homedir(), '.cursor');
}

export function hooksPath({ project = false, cwd = process.cwd() } = {}) {
  return project
    ? path.join(findProjectRoot(cwd), '.cursor', 'hooks.json')
    : path.join(cursorHome(), 'hooks.json');
}

/** Cursor reads persistent context from .cursor/rules/*.mdc, always applied when `alwaysApply` is set. */
export function rulesPath(cwd = process.cwd()) {
  return path.join(findProjectRoot(cwd), '.cursor', 'rules', 'wife-memory.mdc');
}

const hasGuards = () => { try { return activeGuards().length > 0; } catch { return false; } };

export function cursorHooks(nodeBin = process.execPath) {
  const cmd = (args) => `"${nodeBin}" "${BIN}" ${args}`;
  const hooks = {
    beforeSubmitPrompt: [{ command: cmd('capture --agent cursor'), timeout: 10 }],
    stop: [{ command: cmd('harvest --stdin --quiet --refresh-cursor'), timeout: 30 }],
  };
  if (hasGuards()) {
    hooks.beforeShellExecution = [{ command: cmd('guard --style cursor'), timeout: 10 }];
  }
  return hooks;
}

export function isWifeHandler(handler) {
  return typeof handler?.command === 'string' && /(?:^|[\\/])wife\.js(?:$|["'\s])/.test(handler.command);
}

function removeWifeHooks(hooks) {
  for (const [event, handlers] of Object.entries(hooks || {})) {
    if (!Array.isArray(handlers)) continue;
    const kept = handlers.filter((h) => !isWifeHandler(h));
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
}

export function attachCursor({ project = true, cwd = process.cwd(), nodeBin = process.execPath } = {}) {
  const file = hooksPath({ project, cwd });
  ensureDir(path.dirname(file));
  const existing = exists(file) ? readHooksDocument(file) : { version: 1, hooks: {} };
  existing.version = existing.version || 1;
  existing.hooks = existing.hooks || {};
  removeWifeHooks(existing.hooks);

  const wanted = cursorHooks(nodeBin);
  const events = [];
  for (const [event, handlers] of Object.entries(wanted)) {
    const prior = Array.isArray(existing.hooks[event]) ? existing.hooks[event] : [];
    existing.hooks[event] = [...prior, ...handlers];
    events.push(event);
  }
  writeJSON(file, existing);
  const rules = writeRules(cwd);
  return { file, events, rules };
}

export function detachCursor({ project = true, cwd = process.cwd() } = {}) {
  const file = hooksPath({ project, cwd });
  let removed = 0;
  const existing = exists(file) ? readHooksDocument(file) : null;
  if (existing?.hooks) {
    for (const [event, handlers] of Object.entries(existing.hooks)) {
      if (!Array.isArray(handlers)) continue;
      const kept = handlers.filter((h) => { if (isWifeHandler(h)) { removed++; return false; } return true; });
      if (kept.length) existing.hooks[event] = kept;
      else delete existing.hooks[event];
    }
    writeJSON(file, existing);
  }
  const rules = rulesPath(cwd);
  const hadRules = exists(rules);
  if (hadRules) removeFile(rules);
  return { file, removed, missing: !existing, rulesRemoved: hadRules };
}

export function cursorStatus({ project = true, cwd = process.cwd() } = {}) {
  const file = hooksPath({ project, cwd });
  const inspected = inspectJSON(file, null);
  const invalid = Boolean(inspected.error || (!inspected.missing && schemaProblem(inspected.value)));
  const existing = invalid ? null : inspected.value;
  const events = existing?.hooks
    ? Object.entries(existing.hooks).filter(([, h]) => Array.isArray(h) && h.some(isWifeHandler)).map(([e]) => e)
    : [];
  return { file, attached: events.length > 0, events, rules: exists(rulesPath(cwd)), invalid };
}

/**
 * Write the memory as an always-applied Cursor rule.
 * Regenerated by the `stop` hook so it never drifts from the real memory.
 */
export function writeRules(cwd = process.cwd()) {
  const file = rulesPath(cwd);
  const { text, empty } = compileContext({ cwd });
  if (empty) {
    if (exists(file)) removeFile(file);
    return { file, written: false };
  }
  ensureDir(path.dirname(file));
  writeAtomic(file, [
    '---',
    'description: What wife has learned about this user. Regenerated automatically.',
    'alwaysApply: true',
    '---',
    '',
    text.trim(),
    '',
  ].join('\n'));
  return { file, written: true };
}

export function readRules(cwd = process.cwd()) {
  return readText(rulesPath(cwd), null);
}
