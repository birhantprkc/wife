import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * Root of all wife state. Overridable with WIFE_HOME, which is what the
 * test suite uses so it never touches a real user's memory.
 */
export function wifeHome() {
  return process.env.WIFE_HOME || path.join(os.homedir(), '.wife');
}

export const paths = {
  home: () => wifeHome(),
  config: () => path.join(wifeHome(), 'config.json'),
  identity: () => path.join(wifeHome(), 'identity.md'),
  identityIndex: () => path.join(wifeHome(), 'identity.index.json'),
  journal: () => path.join(wifeHome(), 'journal.jsonl'),
  sessions: () => path.join(wifeHome(), 'sessions'),
  session: (id) => path.join(wifeHome(), 'sessions', `${safeId(id)}.jsonl`),
  projects: () => path.join(wifeHome(), 'projects'),
  projectDir: (key) => path.join(wifeHome(), 'projects', key),
  projectMd: (key) => path.join(wifeHome(), 'projects', key, 'project.md'),
  projectIndex: (key) => path.join(wifeHome(), 'projects', key, 'project.index.json'),
  projectMeta: (key) => path.join(wifeHome(), 'projects', key, 'meta.json'),
  projectCheckpoint: (key) => path.join(wifeHome(), 'projects', key, 'checkpoint.json'),
  projectEvidence: (key) => path.join(wifeHome(), 'projects', key, 'evidence.jsonl'),
};

export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/** Strip anything that could escape the sessions directory. */
export function safeId(id) {
  return String(id || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown';
}

const ROOT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', '.hg', '.svn'];

/**
 * Walk up from `start` looking for a project root marker.
 * Falls back to `start` itself so wife always has somewhere to put project memory.
 */
export function findProjectRoot(start = process.cwd()) {
  let dir;
  try {
    dir = fs.realpathSync(start);
  } catch {
    dir = path.resolve(start);
  }
  const stopAt = path.parse(dir).root;
  let current = dir;
  for (let i = 0; i < 64; i++) {
    for (const marker of ROOT_MARKERS) {
      try {
        fs.accessSync(path.join(current, marker));
        return current;
      } catch {
        /* keep looking */
      }
    }
    if (current === stopAt) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dir;
}

export function slugify(name) {
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';
}

/**
 * Stable per-project key. Slug is for humans reading ~/.wife/projects/,
 * the hash makes it collision-proof across two repos with the same folder name.
 */
export function projectKey(root) {
  const abs = path.resolve(root);
  const hash = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 8);
  return `${slugify(path.basename(abs))}-${hash}`;
}

export function homeRelative(p) {
  const h = os.homedir();
  return p.startsWith(h) ? `~${p.slice(h.length)}` : p;
}
