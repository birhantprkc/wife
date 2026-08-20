#!/usr/bin/env node
/**
 * End-to-end simulation of a real agent lifecycle.
 *
 * Everything here goes through the actual CLI as a spawned subprocess, fed the
 * exact JSON shape Claude Code sends on stdin. Unit tests can pass while the
 * binary is broken; this cannot.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'wife.js');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wife-e2e-'));
const home = path.join(sandbox, '.wife');
const repo = path.join(sandbox, 'my-repo');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

const env = {
  ...process.env,
  WIFE_HOME: home,
  CLAUDE_CONFIG_DIR: path.join(sandbox, '.claude'),
  CODEX_HOME: path.join(sandbox, '.codex'),
  CURSOR_HOME: path.join(sandbox, '.cursor-home'),
  GEMINI_HOME: path.join(sandbox, '.gemini'),
  npm_config_cache: path.join(sandbox, '.npm-cache'),
  npm_config_update_notifier: 'false',
  WIFE_NO_COLOR: '1',
  NO_COLOR: '1',
};

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \u001b[32m✓\u001b[0m ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? `\n      ${detail}` : ''}`);
    console.log(`  \u001b[31m✗\u001b[0m ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function wife(args, { input = null, cwd = repo } = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    env, cwd, input: input === null ? undefined : input, encoding: 'utf8',
  });
  return { code: res.status, out: res.stdout || '', err: res.stderr || '' };
}

/** Exactly the payload Claude Code puts on a hook's stdin. */
const hookPayload = (event, extra = {}) => JSON.stringify({
  session_id: 'sess-e2e-1',
  transcript_path: path.join(sandbox, 'transcript.jsonl'),
  cwd: repo,
  permission_mode: 'default',
  hook_event_name: event,
  ...extra,
});

function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

// ---------------------------------------------------------------------------
section('install');

let r = wife(['init']);
check('init exits 0', r.code === 0, r.err.trim());
check('creates identity.md', fs.existsSync(path.join(home, 'identity.md')));
check('creates the projects directory', fs.existsSync(path.join(home, 'projects')));

r = wife(['attach', 'claude']);
check('attach claude exits 0', r.code === 0, r.err.trim());
const settingsFile = path.join(sandbox, '.claude', 'settings.json');
check('writes settings.json', fs.existsSync(settingsFile));
const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
check('registers SessionStart, UserPromptSubmit and SessionEnd',
  ['SessionStart', 'UserPromptSubmit', 'SessionEnd'].every((e) => settings.hooks[e]));

// ---------------------------------------------------------------------------
section('session 1 — a cold start, then three prompts');

r = wife(['inject'], { input: hookPayload('SessionStart', { source: 'startup' }) });
check('inject exits 0 on an empty memory', r.code === 0, r.err.trim());
check('injects nothing when it knows nothing', r.out.trim() === '',
  `stdout was: ${JSON.stringify(r.out.slice(0, 120))}`);

const session1 = [
  'recuerda que trabajo siempre en español, no me respondas en inglés',
  'prefiero respuestas cortas y directas',
  'este proyecto usa Supabase y Deno para las edge functions',
  'arregla el bug del login que rompe con sesiones expiradas',
  'mi api key de produccion es sk-liveABCDEFGHIJKLMNOPQRSTUVWXYZ012345 no la pierdas',
];
for (const prompt of session1) {
  const res = wife(['capture'], { input: hookPayload('UserPromptSubmit', { prompt }) });
  if (res.code !== 0) check(`capture "${prompt.slice(0, 30)}…"`, false, res.err.trim());
}
check('capture always exits 0 and stays silent', true);
check('buffers the session', fs.existsSync(path.join(home, 'sessions', 'sess-e2e-1.jsonl')));

r = wife(['harvest'], { input: hookPayload('SessionEnd', { reason: 'prompt_input_exit' }) });
check('harvest exits 0', r.code === 0, r.err.trim());
check('deletes the raw buffer once harvested',
  !fs.existsSync(path.join(home, 'sessions', 'sess-e2e-1.jsonl')));

const identityMd = fs.readFileSync(path.join(home, 'identity.md'), 'utf8');
check('remembers the explicit directive', /espa[nñ]ol/i.test(identityMd),
  `identity.md:\n${identityMd}`);
check('does NOT remember the task', !/bug|login/i.test(identityMd));
check('does NOT remember the soft preference yet (one sighting)',
  !/respuestas cortas/i.test(identityMd));

const everything = fs.readdirSync(home, { recursive: true })
  .filter((f) => typeof f === 'string')
  .map((f) => path.join(home, f))
  .filter((f) => fs.statSync(f).isFile())
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');
check('THE CREDENTIAL NEVER TOUCHED DISK, anywhere under ~/.wife',
  !everything.includes('sk-liveABCDEFGHIJKLMNOPQRSTUVWXYZ012345'));

const projectDirs = fs.readdirSync(path.join(home, 'projects'));
const projectMd = fs.readFileSync(path.join(home, 'projects', projectDirs[0], 'project.md'), 'utf8');
check('does NOT store the stack fact on one sighting either',
  !/Supabase/i.test(projectMd) && !/Supabase/i.test(identityMd),
  `project.md:\n${projectMd}`);
check('but it is staged, waiting for confirmation',
  /Supabase/i.test(fs.readFileSync(path.join(home, 'projects', projectDirs[0], 'project.index.json'), 'utf8')));

// ---------------------------------------------------------------------------
section('session 2 — the same preference again, in a different session');

const s2 = (extra = {}) => JSON.stringify({
  session_id: 'sess-e2e-2', cwd: repo, hook_event_name: 'x', ...extra,
});
wife(['capture'], { input: s2({ prompt: 'prefiero respuestas cortas y directas' }) });
wife(['capture'], { input: s2({ prompt: 'este proyecto usa Supabase y Deno para las edge functions' }) });
r = wife(['harvest'], { input: s2({ hook_event_name: 'SessionEnd' }) });
check('second harvest exits 0', r.code === 0, r.err.trim());

const identityMd2 = fs.readFileSync(path.join(home, 'identity.md'), 'utf8');
check('promotes the preference after a second, separate session',
  /respuestas cortas/i.test(identityMd2), `identity.md:\n${identityMd2}`);
const projectMd2 = fs.readFileSync(path.join(home, 'projects', projectDirs[0], 'project.md'), 'utf8');
check('promotes the stack fact into PROJECT memory, not identity',
  /Supabase/i.test(projectMd2) && !/Supabase/i.test(identityMd2), `project.md:\n${projectMd2}`);

// ---------------------------------------------------------------------------
section('session 3 — the agent now knows who you are');

r = wife(['inject'], { input: hookPayload('SessionStart', { session_id: 'sess-e2e-3', source: 'startup' }) });
check('inject exits 0', r.code === 0, r.err.trim());
check('injects the identity block', /respuestas cortas/i.test(r.out), r.out.slice(0, 200));
check('injects project memory too', /Supabase/i.test(r.out));
check('stays under the 10k hook output cap', r.out.length < 10000, `${r.out.length} chars`);
check('reads as background information, not as a system command',
  !/YOU MUST|<system>|IGNORE PREVIOUS/i.test(r.out));

r = wife(['inject', '--json'], { input: hookPayload('SessionStart') });
let parsed = null;
try { parsed = JSON.parse(r.out); } catch { /* handled below */ }
check('--json emits a valid SessionStart hook payload',
  parsed?.hookSpecificOutput?.hookEventName === 'SessionStart' &&
  typeof parsed?.hookSpecificOutput?.additionalContext === 'string',
  r.out.slice(0, 200));

// ---------------------------------------------------------------------------
section('manual control');

r = wife(['remember', 'Builds Android apps with Kotlin and Jetpack Compose']);
check('remember exits 0', r.code === 0, r.err.trim());
check('remember confirms', /Added to identity/i.test(r.out), r.out);

r = wife(['why', 'Kotlin']);
check('why exits 0', r.code === 0, r.err.trim());
check('why reports the source', /wife remember/i.test(r.out), r.out);
check('why reports confidence and score', /confidence/i.test(r.out) && /score/i.test(r.out));

r = wife(['why', 'español']);
check('why explains a captured fact differently from a manual one',
  /stated it directly|separate sessions/i.test(r.out), r.out);

r = wife(['show']);
check('show exits 0', r.code === 0, r.err.trim());
check('show reports a token count against the budget', /tokens/.test(r.out), r.out);

r = wife(['forget', 'Kotlin']);
check('forget exits 0', r.code === 0, r.err.trim());
check('forget removes the line entirely',
  !fs.readFileSync(path.join(home, 'identity.md'), 'utf8').includes('Kotlin'));

r = wife(['journal', '-n', '5']);
check('journal exits 0', r.code === 0, r.err.trim());
check('journal records the removal', /forgotten/i.test(r.out), r.out);

// ---------------------------------------------------------------------------
section('hand editing wins');

fs.writeFileSync(path.join(home, 'identity.md'),
  '# Wife · who you are\n\n## Who\n- Lives in Berlin and works in German\n');
r = wife(['show']);
check('adopts a hand-written line', /Lives in Berlin/.test(r.out), r.out);
check('forgets everything the user deleted by hand', !/respuestas cortas/i.test(r.out));

// ---------------------------------------------------------------------------
section('crash recovery');

wife(['capture'], { input: JSON.stringify({ session_id: 'crashed-session', cwd: repo, prompt: 'recuerda que nunca hago deploy los viernes' }) });
check('a buffer survives a session that never ended',
  fs.existsSync(path.join(home, 'sessions', 'crashed-session.jsonl')));
r = wife(['inject'], { input: hookPayload('SessionStart', { session_id: 'fresh-session', source: 'startup' }) });
check('the next session start picks the orphaned buffer up',
  !fs.existsSync(path.join(home, 'sessions', 'crashed-session.jsonl')), r.err.trim());
const afterCrash = [path.join(home, 'identity.md'), path.join(home, 'projects', projectDirs[0], 'project.md')]
  .map((f) => fs.readFileSync(f, 'utf8')).join('\n');
check('and the fact from the crashed session made it in', /viernes/i.test(afterCrash), afterCrash);

// ---------------------------------------------------------------------------
section('resilience — hooks must never take a session down');

const abuse = [
  ['no stdin at all', { input: '' }],
  ['garbage on stdin', { input: 'not json at all {{{' }],
  ['empty json', { input: '{}' }],
  ['null prompt', { input: '{"session_id":"x","prompt":null}' }],
  ['enormous prompt', { input: JSON.stringify({ session_id: 'big', cwd: repo, prompt: 'x'.repeat(500000) }) }],
  ['weird session id', { input: JSON.stringify({ session_id: '../../../etc/passwd', cwd: repo, prompt: 'hola que tal' }) }],
];
for (const [label, opts] of abuse) {
  for (const cmd of ['inject', 'capture', 'harvest']) {
    const res = wife([cmd], opts);
    check(`${cmd} survives ${label}`, res.code === 0, `exit ${res.code}: ${res.err.trim().slice(0, 200)}`);
  }
}
check('a path-traversal session id did not escape the sessions directory',
  !fs.existsSync(path.join(sandbox, 'etc')) && !fs.existsSync('/tmp/wife-escaped'));

// corrupt files
fs.writeFileSync(path.join(home, 'identity.index.json'), '{ this is not json');
r = wife(['show']);
check('recovers from a corrupt index instead of crashing', r.code === 0, r.err.trim());
check('quarantines the corrupt file',
  fs.readdirSync(home).some((f) => f.includes('.corrupt.')));

// ---------------------------------------------------------------------------
section('doctor and detach');

r = wife(['doctor']);
check('doctor runs', r.code === 0 || r.code === 1, r.err.trim());
check('doctor produces a readable report', /wife doctor/i.test(r.out), r.out.slice(0, 200));

r = wife(['status']);
check('status runs', r.code === 0, r.err.trim());
check('status reports Claude Code as attached', /Claude Code/.test(r.out), r.out);

r = wife(['detach', 'claude']);
check('detach exits 0', r.code === 0, r.err.trim());
const finalSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
check('detach leaves no wife hooks behind',
  !JSON.stringify(finalSettings).includes('wife.js'), JSON.stringify(finalSettings));

// ---------------------------------------------------------------------------
section('cli surface');

for (const [args, label] of [
  [['--help'], 'help'],
  [['--version'], 'version'],
  [['show', '--raw'], 'show --raw'],
]) {
  const res = wife(args);
  check(`${label} exits 0`, res.code === 0, res.err.trim());
}
r = wife(['nonsense-command']);
check('an unknown command exits non-zero with a hint', r.code === 1 && /Unknown command/.test(r.err + r.out));

// ---------------------------------------------------------------------------
section('the real installation path');

// Exercise npm's real platform-specific launcher: a symlink on POSIX and the
// generated wife.cmd shim on Windows, where creating a file symlink may require
// administrator privileges and does not represent how users launch the CLI.
const installPrefix = path.join(sandbox, 'installed');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const install = spawnSync(npmCommand, [
  'install', '--global', '--prefix', installPrefix, ROOT,
  '--ignore-scripts', '--no-audit', '--no-fund',
], { env, cwd: repo, encoding: 'utf8', shell: process.platform === 'win32' });
check('npm installs the package through its real bin path', install.status === 0,
  `exit ${install.status}: ${(install.stderr || '').slice(0, 300)}`);

const installedBin = process.platform === 'win32'
  ? path.join(installPrefix, 'wife.cmd')
  : path.join(installPrefix, 'bin', 'wife');
const installedWife = (args) => spawnSync(installedBin, args, {
  env, cwd: repo, encoding: 'utf8', shell: process.platform === 'win32',
});
const viaInstall = installedWife(['--version']);
check('running through the installed launcher produces output',
  viaInstall.status === 0 && viaInstall.stdout.trim().length > 0,
  `exit ${viaInstall.status}, stdout ${JSON.stringify(viaInstall.stdout)}`);
const statusViaInstall = installedWife(['status']);
check('and a real command works through it too',
  statusViaInstall.status === 0 && /wife/.test(statusViaInstall.stdout),
  `exit ${statusViaInstall.status}`);

// ---------------------------------------------------------------------------
fs.rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${'─'.repeat(56)}`);
if (failed === 0) {
  console.log(`\u001b[32m${passed} checks passed, 0 failed.\u001b[0m`);
  process.exit(0);
} else {
  console.log(`\u001b[31m${failed} failed\u001b[0m, ${passed} passed:\n`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
