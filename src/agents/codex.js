import path from 'node:path';
import { codexHome, findProjectRoot } from '../util/paths.js';
import { readText, writeAtomic, exists, ensureDir } from '../util/fsx.js';
import { compileContext } from '../core/compile.js';

export const BEGIN = '<!-- wife:begin — managed block, edited by `wife sync`. Your own text is safe outside it. -->';
export const END = '<!-- wife:end -->';

/**
 * Codex reads AGENTS.md at ~/.codex/AGENTS.md and at the project root. wife
 * owns exactly the region between its two markers and never touches a byte
 * outside it, so your own instructions in the same file survive every sync.
 *
 * Codex has gained a hook system since, mirroring Claude Code's protocol. When
 * your version supports it, wiring `wife inject` to SessionStart gives you
 * the same live behaviour as Claude Code; the managed block below works on
 * every version and needs no configuration.
 */
export function agentsPath({ project = false, cwd = process.cwd() } = {}) {
  return project ? path.join(findProjectRoot(cwd), 'AGENTS.md') : path.join(codexHome(), 'AGENTS.md');
}

export function renderBlock({ cwd = process.cwd(), includeProject = true } = {}) {
  const { text, empty } = compileContext({ cwd, includeProject });
  const body = empty
    ? '_No memory recorded yet. Run `wife remember "..."` or let wife learn from your prompts._'
    : text.trim();
  return [
    BEGIN,
    '',
    body,
    '',
    `_Regenerate with \`wife sync\`. Last updated ${new Date().toISOString().slice(0, 10)}._`,
    '',
    END,
  ].join('\n');
}

export function upsertBlock(existing, block) {
  const current = existing || '';
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (start !== -1 && end !== -1 && end > start) {
    return `${current.slice(0, start)}${block}${current.slice(end + END.length)}`;
  }
  const prefix = current.trim() ? `${current.trimEnd()}\n\n` : '';
  return `${prefix}${block}\n`;
}

export function attachCodex({ project = false, cwd = process.cwd(), includeProject = true } = {}) {
  const file = agentsPath({ project, cwd });
  ensureDir(path.dirname(file));
  const existed = exists(file);
  const current = readText(file, '');
  const next = upsertBlock(current, renderBlock({ cwd, includeProject }));
  writeAtomic(file, next.endsWith('\n') ? next : `${next}\n`);
  return { file, existed, bytes: next.length };
}

export function detachCodex({ project = false, cwd = process.cwd() } = {}) {
  const file = agentsPath({ project, cwd });
  if (!exists(file)) return { file, removed: false, missing: true };
  const current = readText(file, '');
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (start === -1 || end === -1 || end < start) return { file, removed: false, missing: false };
  const next = `${current.slice(0, start).trimEnd()}\n${current.slice(end + END.length).trimStart()}`;
  writeAtomic(file, next.trim() ? next : '');
  return { file, removed: true, missing: false };
}

export function codexStatus({ project = false, cwd = process.cwd() } = {}) {
  const file = agentsPath({ project, cwd });
  const current = readText(file, null);
  return { file, attached: Boolean(current && current.includes(BEGIN)) };
}
