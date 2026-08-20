#!/usr/bin/env node
/**
 * Multi-machine convergence, end to end, with real git.
 *
 * Nothing is stubbed. Each "machine" is its own WIFE_HOME with its own clone of
 * a bare repo, and every sync shells out to the real `wife sync`. The point is
 * to prove the claim that matters: two people-worth of divergence converges
 * without losing anything, and it keeps working past two machines.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'wife.js');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wife-sync-'));
const bare = path.join(sandbox, 'memory.git');

let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  \u001b[32m✓\u001b[0m ${label}`); }
  else { failed++; failures.push(`${label}${detail ? `\n      ${detail}` : ''}`); console.log(`  \u001b[31m✗\u001b[0m ${label}${detail ? `\n      ${detail}` : ''}`); }
}
function section(t) { console.log(`\n\u001b[1m${t}\u001b[0m`); }
const gitAt = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

// Every WIFE_HOME is deliberately nested under an unrelated repository. Git
// discovery must not make Wife operate on that ancestor by mistake.
spawnSync('git', ['init', '-b', 'main', sandbox], { encoding: 'utf8' });
spawnSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8' });

/** One machine: its own WIFE_HOME, its own repos, its own clone of the remote. */
function machine(name) {
  const home = path.join(sandbox, name, '.wife');
  const repos = {};
  for (const r of ['api', 'web', 'mobile']) {
    repos[r] = path.join(sandbox, name, r);
    fs.mkdirSync(path.join(repos[r], '.git'), { recursive: true });
  }
  const env = {
    ...process.env, WIFE_HOME: home,
    CLAUDE_CONFIG_DIR: path.join(sandbox, name, '.claude'),
    CODEX_HOME: path.join(sandbox, name, '.codex'),
    WIFE_NO_COLOR: '1', NO_COLOR: '1',
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@test`,
    GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@test`,
  };
  const run = (args, { cwd = repos.api, input } = {}) =>
    spawnSync(process.execPath, [BIN, ...args], { env, cwd, input, encoding: 'utf8' });
  const say = (prompt, { repo = 'api', session = Math.random().toString(36).slice(2, 8) } = {}) => {
    run(['capture'], { cwd: repos[repo], input: JSON.stringify({ session_id: session, cwd: repos[repo], prompt }) });
    run(['harvest', '--quiet'], { cwd: repos[repo], input: JSON.stringify({ session_id: session }) });
  };
  const md = () => {
    try { return fs.readFileSync(path.join(home, 'identity.md'), 'utf8'); } catch { return ''; }
  };
  const projectMd = () => {
    const dir = path.join(home, 'projects');
    try {
      return fs.readdirSync(dir)
        .map((k) => { try { return fs.readFileSync(path.join(dir, k, 'project.md'), 'utf8'); } catch { return ''; } })
        .join('\n');
    } catch { return ''; }
  };
  return { name, home, repos, env, run, say, md, projectMd };
}

// ---------------------------------------------------------------------------
section('laptop — first machine, pushes up');
const laptop = machine('laptop');
laptop.run(['init']);
fs.writeFileSync(path.join(laptop.home, '.gitignore'),
  'custom-local.tmp\nsessions/\n!sessions/\n.state.lock\n!.state.lock\n');
fs.writeFileSync(path.join(laptop.home, '.gitattributes'),
  '*.custom merge=union\n*.index.json    merge=wife\n*.index.json merge=text\n*.md merge=wife-md\n*.md merge=text\n');
laptop.say('recuerda que trabajo siempre en español');
laptop.say('recuerda que prefiero respuestas cortas');

let r = laptop.run(['sync', 'setup', bare]);
check('sync setup exits 0', r.status === 0, (r.stderr || r.stdout).trim());
check('makes ~/.wife a git repo', fs.existsSync(path.join(laptop.home, '.git')));
const driver = spawnSync('git', ['config', '--get', 'merge.wife.driver'], { cwd: laptop.home, encoding: 'utf8' }).stdout || '';
const mdDriver = spawnSync('git', ['config', '--get', 'merge.wife-md.driver'], { cwd: laptop.home, encoding: 'utf8' }).stdout || '';
check('registers the semantic merge driver', /merge-driver/.test(driver), driver);
check('passes Git logical path %P to the semantic driver', /%P/.test(driver), driver);
check('registers the markdown no-op driver (merge=ours is NOT a git built-in)',
  mdDriver.trim() === 'true', mdDriver);
check('marks index files for the driver in .gitattributes',
  fs.readFileSync(path.join(laptop.home, '.gitattributes'), 'utf8').includes('*.index.json    merge=wife'));
check('repairs .gitattributes without erasing user rules',
  fs.readFileSync(path.join(laptop.home, '.gitattributes'), 'utf8').includes('*.custom merge=union'));
check('the repaired index rule wins over a later user override',
  /merge: wife\s*$/.test(gitAt(laptop.home, ['check-attr', 'merge', '--', 'identity.index.json']).stdout));
check('the repaired markdown rule wins over a later user override',
  /merge: wife-md\s*$/.test(gitAt(laptop.home, ['check-attr', 'merge', '--', 'identity.md']).stdout));
check('ignores sessions/, so raw prompts never leave the machine',
  gitAt(laptop.home, ['check-ignore', '--no-index', 'sessions/private.jsonl']).status === 0);
check('repairs .gitignore without erasing user rules or exposing the state lock', (() => {
  const ignore = fs.readFileSync(path.join(laptop.home, '.gitignore'), 'utf8');
  return ignore.includes('custom-local.tmp') &&
    gitAt(laptop.home, ['check-ignore', '--no-index', '.state.lock']).status === 0;
})());

// Simulate a legacy/newly staged raw buffer. It has not reached history yet, so
// Wife can safely untrack it while leaving the local working copy untouched.
const stagedSession = path.join(laptop.home, 'sessions', 'staged-private.jsonl');
fs.mkdirSync(path.dirname(stagedSession), { recursive: true });
fs.writeFileSync(stagedSession, '{"prompt":"password = must-stay-local"}\n');
gitAt(laptop.home, ['add', '-f', 'sessions/staged-private.jsonl']);

r = laptop.run(['sync']);
check('first sync pushes', r.status === 0, (r.stderr || r.stdout).trim());
check('a newly staged private session is removed from Git without deleting it locally',
  fs.existsSync(stagedSession) && !gitAt(laptop.home, ['ls-files', '--', 'sessions']).stdout.trim());
check('neither sessions nor the live state lock reached the remote tip',
  !gitAt(bare, ['ls-tree', '-r', '--name-only', 'main', '--', 'sessions', '.state.lock']).stdout.trim());

// ---------------------------------------------------------------------------
section('desktop — second machine, clones');
const desktop = machine('desktop');
r = desktop.run(['clone', bare]);
check('clone exits 0', r.status === 0, (r.stderr || r.stdout).trim());
check('the laptop\'s facts arrived', /español/i.test(desktop.md()) && /cortas/i.test(desktop.md()), desktop.md());
check('no session buffers travelled', !fs.existsSync(path.join(desktop.home, 'sessions')) ||
  fs.readdirSync(path.join(desktop.home, 'sessions')).length === 0);

// ---------------------------------------------------------------------------
section('both machines diverge — the case the git trick cannot handle');
laptop.say('recuerda que nunca hago deploy los viernes');
laptop.say('este proyecto usa Postgres y Fastify', { repo: 'api' });
laptop.say('este proyecto usa Postgres y Fastify', { repo: 'api' });

desktop.say('recuerda que uso pnpm en vez de npm');
desktop.say('recuerda que odio las explicaciones largas');
desktop.say('este proyecto usa Postgres y Fastify', { repo: 'web' });
desktop.say('este proyecto usa Postgres y Fastify', { repo: 'web' });

check('laptop learned something the desktop has not seen', /viernes/i.test(laptop.md()));
check('desktop learned something the laptop has not seen', /pnpm/i.test(desktop.md()));
check('and neither knows about the other yet',
  !/pnpm/i.test(laptop.md()) && !/viernes/i.test(desktop.md()));

r = laptop.run(['sync']);
check('laptop pushes its half', r.status === 0, (r.stderr || r.stdout).trim());
r = desktop.run(['sync']);
check('desktop syncs and merges', r.status === 0, (r.stderr || r.stdout).trim());

const d = desktop.md();
check('DESKTOP NOW HAS BOTH SIDES', /viernes/i.test(d) && /pnpm/i.test(d) && /español/i.test(d) && /odio|gusta/i.test(d), d);

r = laptop.run(['sync']);
check('laptop syncs back', r.status === 0, (r.stderr || r.stdout).trim());
const l = laptop.md();
check('LAPTOP NOW HAS BOTH SIDES TOO', /viernes/i.test(l) && /pnpm/i.test(l), l);

const factsOf = (md) => md.split('\n').filter((x) => x.startsWith('- ')).map((x) => x.trim()).sort();
check('the two machines are identical, fact for fact',
  JSON.stringify(factsOf(l)) === JSON.stringify(factsOf(d)),
  `laptop:\n${factsOf(l).join('\n')}\n\ndesktop:\n${factsOf(d).join('\n')}`);
check('project memory converged too',
  /Postgres/i.test(desktop.projectMd()), desktop.projectMd());
let journalRows = [], journalError = '';
try {
  journalRows = fs.readFileSync(path.join(desktop.home, 'journal.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
} catch (error) {
  journalError = error.message;
}
check('journal conflicts use the JSONL union driver instead of becoming an empty index',
  !journalError && journalRows.length > 0 && !Object.hasOwn(journalRows[0], 'facts'), journalError);
const journalText = JSON.stringify(journalRows);
check('the merged journal keeps events from both machines',
  /viernes/i.test(journalText) && /pnpm/i.test(journalText), journalText.slice(0, 500));

let ledger = null;
try { ledger = JSON.parse(fs.readFileSync(path.join(desktop.home, 'cross-project.json'), 'utf8')); } catch { /* checked below */ }
const sharedLedgerEntry = Object.values(ledger?.facts || {}).find((entry) => /Postgres/i.test(entry.text));
check('cross-project conflicts union repo sightings with the ledger driver',
  sharedLedgerEntry?.projects?.length === 2,
  JSON.stringify(sharedLedgerEntry || ledger));

// ---------------------------------------------------------------------------
section('a third machine — nothing here is limited to two');
const work = machine('work');
r = work.run(['clone', bare]);
check('third machine clones', r.status === 0, (r.stderr || r.stdout).trim());
check('and gets everything both others learned',
  /viernes/i.test(work.md()) && /pnpm/i.test(work.md()) && /español/i.test(work.md()), work.md());

work.say('recuerda que reviso los PR por la mañana');
work.run(['sync']);
laptop.run(['sync']);
desktop.run(['sync']);
check('a fact from machine three reaches machine one',
  /PR|revis/i.test(laptop.md()), laptop.md());
check('all three converge',
  JSON.stringify(factsOf(laptop.md())) === JSON.stringify(factsOf(desktop.md())) &&
  JSON.stringify(factsOf(desktop.md())) === JSON.stringify(factsOf(work.md())));

// ---------------------------------------------------------------------------
section('deleting a fact on one machine must stick');
fs.writeFileSync(path.join(laptop.home, 'identity.md'),
  laptop.md().split('\n').filter((line) => !/pnpm/i.test(line)).join('\n'));
check('the laptop forgot it', !/pnpm/i.test(laptop.md()));
laptop.run(['sync']);
desktop.run(['sync']);
check('AND IT STAYS FORGOTTEN ON THE OTHER MACHINE', !/pnpm/i.test(desktop.md()),
  `a deliberate deletion was resurrected by the sync:\n${desktop.md()}`);
work.run(['sync']);
check('and on the third', !/pnpm/i.test(work.md()));

// ---------------------------------------------------------------------------
section('the promotion gate now spans machines');
const l2 = machine('laptop2');
l2.run(['clone', bare]);
const d2 = machine('desktop2');
d2.run(['clone', bare]);

l2.say('prefiero trabajar de noche sin interrupciones');   // soft, one sighting
check('one sighting on one machine is not stored', !/noche/i.test(l2.md()), l2.md());
l2.run(['sync']);
d2.run(['sync']);
d2.say('prefiero trabajar de noche sin interrupciones');   // second sighting, other machine
check('A SECOND SIGHTING ON A DIFFERENT MACHINE PROMOTES IT', /noche/i.test(d2.md()),
  `the candidate\'s sessions did not merge across machines:\n${d2.md()}`);

// ---------------------------------------------------------------------------
section('contradicting yourself on the other machine');
l2.run(['sync']);
l2.run(['remember', 'Usa Redis para la caché']);
l2.run(['sync']);
d2.run(['sync']);
check('both machines have the fact', /Redis/i.test(l2.md()) && /Redis/i.test(d2.md()));
d2.say('recuerda que nunca uso Redis');
d2.run(['sync']);
l2.run(['sync']);
const both = l2.md();
const positive = /^- Usa Redis/m.test(both);
check('the newer statement won and the old one is gone',
  !positive && /Redis/i.test(both), both);

// ---------------------------------------------------------------------------
section('sync status reports honestly');
r = laptop.run(['sync', 'status']);
check('sync status exits 0', r.status === 0, (r.stderr || r.stdout).trim());
check('reports the remote and drift', /remote/i.test(r.stdout) && /ahead/i.test(r.stdout), r.stdout);

// ---------------------------------------------------------------------------
section('resilience');
const unsafe = machine('unsafe-history');
unsafe.run(['init']);
unsafe.run(['sync', 'setup', bare]);
const committedSession = path.join(unsafe.home, 'sessions', 'committed-private.jsonl');
fs.mkdirSync(path.dirname(committedSession), { recursive: true });
fs.writeFileSync(committedSession, '{"prompt":"token = must-never-be-pushed"}\n');
gitAt(unsafe.home, ['add', '-f', 'sessions/committed-private.jsonl']);
gitAt(unsafe.home, ['-c', 'user.email=wife@localhost', '-c', 'user.name=wife',
  'commit', '-m', 'legacy private session']);
const remoteBeforeUnsafe = gitAt(bare, ['rev-parse', 'main']).stdout.trim();
r = unsafe.run(['sync']);
check('sync refuses committed private session history instead of uploading it',
  r.status === 1 && /Git history/i.test(`${r.stdout}\n${r.stderr}`), `${r.stdout}\n${r.stderr}`);
check('the refused sync keeps the private file and leaves the remote unchanged',
  fs.existsSync(committedSession) && gitAt(bare, ['rev-parse', 'main']).stdout.trim() === remoteBeforeUnsafe);

const corruptDir = path.join(sandbox, 'corrupt-merge-input');
fs.mkdirSync(corruptDir, { recursive: true });
const baseIndex = path.join(corruptDir, 'base');
const ourIndex = path.join(corruptDir, 'ours');
const theirIndex = path.join(corruptDir, 'theirs');
const validIndex = JSON.stringify({ version: 2, facts: {}, pending: {}, tombstones: {} });
fs.writeFileSync(baseIndex, validIndex);
fs.writeFileSync(ourIndex, validIndex);
fs.writeFileSync(theirIndex, '{ broken json');
const beforeCorruptMerge = fs.readFileSync(ourIndex, 'utf8');
r = laptop.run(['merge-driver', baseIndex, ourIndex, theirIndex, 'identity.index.json']);
check('a corrupt merge input stops git instead of becoming a deletion', r.status === 1, r.stderr);
check('and leaves the current index byte-for-byte untouched',
  fs.readFileSync(ourIndex, 'utf8') === beforeCorruptMerge);

const malformedFactIndex = JSON.parse(fs.readFileSync(path.join(laptop.home, 'identity.index.json'), 'utf8'));
const [sampleId, originalSampleFact] = Object.entries(malformedFactIndex.facts)[0];
const sampleFact = { ...originalSampleFact };
delete malformedFactIndex.facts[sampleId].section;
fs.writeFileSync(ourIndex, validIndex);
fs.writeFileSync(theirIndex, JSON.stringify(malformedFactIndex));
r = laptop.run(['merge-driver', baseIndex, ourIndex, theirIndex, 'identity.index.json']);
check('a structurally incomplete fact stops the merge before Store can lose it',
  r.status === 1 && fs.readFileSync(ourIndex, 'utf8') === validIndex, r.stderr);

const malformedPending = {
  version: 2, facts: {}, tombstones: {}, pending: {
    [sampleId]: {
      text: sampleFact.text, section: sampleFact.section, kind: sampleFact.kind,
      confidence: 0.5, sessions: [], first: sampleFact.first, last: 'not-a-date', evidence: null,
    },
  },
};
fs.writeFileSync(ourIndex, validIndex);
fs.writeFileSync(theirIndex, JSON.stringify(malformedPending));
r = laptop.run(['merge-driver', baseIndex, ourIndex, theirIndex, 'identity.index.json']);
check('invalid pending metadata and timestamps stop the merge',
  r.status === 1 && fs.readFileSync(ourIndex, 'utf8') === validIndex, r.stderr);

fs.writeFileSync(ourIndex, validIndex);
fs.writeFileSync(theirIndex, JSON.stringify({ version: 99, facts: {}, pending: {}, tombstones: {} }));
r = laptop.run(['merge-driver', baseIndex, ourIndex, theirIndex, 'identity.index.json']);
check('an unknown index version is not merged under unsupported semantics',
  r.status === 1 && fs.readFileSync(ourIndex, 'utf8') === validIndex, r.stderr);

const fresh = machine('fresh');
r = fresh.run(['sync']);
check('sync before setup does not crash', r.status === 0, (r.stderr || r.stdout).trim());
r = fresh.run(['sync', 'setup']);
check('setup with no url fails cleanly', r.status === 1);
r = fresh.run(['clone']);
check('clone with no url fails cleanly', r.status === 1);
r = laptop.run(['clone', bare]);
check('clone over existing memory refuses instead of destroying it', r.status === 1,
  'a clone onto a populated ~/.wife must never overwrite it');
check('and the existing memory survived', /viernes/i.test(laptop.md()));

// ---------------------------------------------------------------------------
fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${'─'.repeat(58)}`);
if (failed === 0) { console.log(`\u001b[32m${passed} checks passed, 0 failed.\u001b[0m`); process.exit(0); }
console.log(`\u001b[31m${failed} failed\u001b[0m, ${passed} passed:\n`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(1);
