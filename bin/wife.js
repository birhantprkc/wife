#!/usr/bin/env node
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cmdInject, cmdCapture, cmdHarvest } from '../src/commands/hooks.js';
import { cmdRemember, cmdForget, cmdPin, cmdWhy } from '../src/commands/memory.js';
import { cmdShow, cmdStatus, cmdJournal, cmdEdit } from '../src/commands/inspect.js';
import { cmdInit, cmdAttach, cmdDetach, cmdSync, cmdDoctor, cmdConfig } from '../src/commands/setup.js';
import { c, say, fail } from '../src/util/out.js';

export const VERSION = '1.0.0';

const BOOLEAN_FLAGS = new Set([
  'help', 'version', 'verbose', 'quiet', 'json', 'raw', 'stdin', 'fix', 'force',
  'project', 'user', 'all', 'no-claude', 'no-codex',
]);

/** Minimal argv parser. No dependency is worth taking for this. */
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') { args._.push(...argv.slice(i + 1)); break; }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const key = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();
      if (eq !== -1) { args[normalizeKey(key)] = token.slice(eq + 1); continue; }
      if (BOOLEAN_FLAGS.has(key)) {
        if (key.startsWith('no-')) args[normalizeKey(key.slice(3))] = false;
        else args[normalizeKey(key)] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[normalizeKey(key)] = next; i++; }
      else args[normalizeKey(key)] = true;
      continue;
    }
    if (/^-[a-zA-Z]$/.test(token)) {
      const map = { v: 'verbose', q: 'quiet', h: 'help', n: 'limit', p: 'project' };
      const key = map[token[1]];
      if (key === 'limit') { args.limit = argv[++i]; continue; }
      if (key) { args[key] = true; continue; }
    }
    args._.push(token);
  }
  return args;
}

const normalizeKey = (k) => k.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());

const HELP = `${c.bold('wife')} ${c.gray(`v${VERSION}`)} — local memory for coding agents

${c.bold('Setup')}
  init                     create ~/.wife and attach whatever is installed
  attach claude|codex      wire wife into an agent  ${c.gray('[--project]')}
  detach claude|codex      remove it cleanly
  sync                     refresh the block wife writes into AGENTS.md

${c.bold('Memory')}
  remember "<fact>"        store something now  ${c.gray('[--project] [--section X]')}
  forget "<text>"          remove it completely  ${c.gray('[--all]')}
  pin "<text>"             exempt from decay and budget eviction
  unpin "<text>"           undo that
  why "<text>"             where a fact came from, and what it replaced
  edit                     open the memory file in $EDITOR  ${c.gray('[--project]')}

${c.bold('Inspect')}
  show                     what the agent will be given  ${c.gray('[--raw] [--verbose]')}
  status                   memory size, wiring, pending buffers
  journal                  audit trail of every change  ${c.gray('[-n 30] [--event added]')}
  doctor                   find duplicates, drift, broken wiring  ${c.gray('[--fix]')}
  config [key] [value]     read or change settings

${c.bold('Lifecycle')} ${c.gray('(these are what the hooks call; you rarely run them by hand)')}
  inject                   print the memory block  ${c.gray('[--json]')}
  capture                  buffer a prompt from hook stdin
  harvest                  curate buffered sessions into memory  ${c.gray('[--verbose]')}

${c.gray('Memory lives in ~/.wife. It is plain markdown. Edit it, grep it, git it.')}
`;

const ROUTES = {
  init: cmdInit,
  attach: cmdAttach,
  detach: cmdDetach,
  sync: cmdSync,
  remember: cmdRemember,
  forget: cmdForget,
  pin: (a) => cmdPin(a),
  unpin: (a) => cmdPin(a, { unpin: true }),
  why: cmdWhy,
  edit: cmdEdit,
  show: cmdShow,
  status: cmdStatus,
  journal: cmdJournal,
  log: cmdJournal,
  doctor: cmdDoctor,
  config: cmdConfig,
  inject: cmdInject,
  capture: cmdCapture,
  harvest: cmdHarvest,
};

/** Hook-facing commands must never take the session down with them. */
const HOOK_COMMANDS = new Set(['inject', 'capture', 'harvest']);

export async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._.shift();

  if (args.version || command === 'version') { say(VERSION); return 0; }
  if (!command || args.help || command === 'help') { say(HELP); return command || args.help ? 0 : 1; }

  const handler = ROUTES[command];
  if (!handler) {
    fail(`Unknown command "${command}".`);
    const near = Object.keys(ROUTES).filter((k) => k.startsWith(command[0]));
    if (near.length) say(c.gray(`Did you mean: ${near.join(', ')}?`));
    say(c.gray('Run `wife help` for the full list.'));
    return 1;
  }

  try {
    return (await handler(args)) ?? 0;
  } catch (error) {
    if (HOOK_COMMANDS.has(command)) {
      process.stderr.write(`wife: ${error.message}\n`);
      return 0;
    }
    fail(error.message);
    if (args.verbose) console.error(error.stack);
    return 1;
  }
}

/**
 * `npm link` and `npm i -g` install a symlink named `wife`, not `wife.js`,
 * so process.argv[1] is the link path. Matching on the filename left the whole
 * CLI silently doing nothing once installed the normal way — the unit tests
 * never saw it because they invoke the .js file directly. Resolve both sides
 * through realpath and compare.
 */
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return path.basename(entry).replace(/\.js$/, '') === 'wife';
  }
}

if (invokedDirectly()) {
  run().then((code) => { process.exitCode = code; });
}
