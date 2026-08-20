import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wife.js');

let sandbox, repo;
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wife-guards-'));
  repo = path.join(sandbox, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  process.env.WIFE_HOME = path.join(sandbox, '.wife');
  process.env.CLAUDE_CONFIG_DIR = path.join(sandbox, '.claude');
  process.env.CODEX_HOME = path.join(sandbox, '.codex');
  process.env.CURSOR_HOME = path.join(sandbox, '.cursor-home');
});
afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.WIFE_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.CURSOR_HOME;
});

const { proposals, evaluate, addGuard, loadGuards, removeGuard, activeGuards } = await import('../src/core/guards.js');
const { wifeHooks, attachClaude, claudeStatus } = await import('../src/agents/claude.js');
const { attachCodex, codexStatus } = await import('../src/agents/codex.js');
const { attachCursor, cursorStatus } = await import('../src/agents/cursor.js');

const fact = (text) => ({ id: text, text });
const guardFor = (text) => proposals([fact(text)])[0]?.guard;
const bash = (command, cwd = repo) => ({ tool_name: 'Bash', tool_input: { command }, cwd });
const edit = (file_path) => ({ tool_name: 'Edit', tool_input: { file_path }, cwd: repo });
const wife = (args) => spawnSync(process.execPath, [BIN, ...args], {
  cwd: repo,
  env: { ...process.env, WIFE_NO_COLOR: '1', NO_COLOR: '1' },
  encoding: 'utf8',
});

function gitRepoOnBranch(branch) {
  spawnSync('git', ['init', '-b', branch, repo], { encoding: 'utf8' });
  spawnSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
  spawnSync('git', ['-C', repo, 'config', 'user.name', 't']);
}

describe('detection — only real prohibitions become guards', () => {
  const rules = [
    ['Nunca hagas commit directo a main', 'git-commit-protected-branch'],
    ['Never commit directly to main', 'git-commit-protected-branch'],
    ['No hagas push a main', 'git-push-protected-branch'],
    ['Nunca hagas force push', 'git-force-push'],
    ['Never force push to any branch', 'git-force-push'],
    ['No uses npm, usa pnpm', 'package-manager'],
    ['Never use yarn in this project', 'package-manager'],
    ['Nunca borres archivos con rm -rf', 'destructive-rm'],
    ['No toques el .env nunca', 'protected-files'],
  ];
  for (const [text, detector] of rules) {
    test(`"${text}" → ${detector}`, () => {
      const g = guardFor(text);
      assert.ok(g, `no guard proposed for: ${text}`);
      assert.equal(g.detector, detector);
    });
  }
});

describe('detection — descriptions must NEVER become guards', () => {
  // This is the failure that matters. A guard invented from a statement the
  // user never meant as a hard rule blocks work they asked for.
  const descriptions = [
    'Usa pnpm en vez de npm',                      // states a preference, forbids nothing
    'Prefiere respuestas cortas',
    'Trabaja sobre todo en backend',
    'El deploy es por GitHub Actions',
    'Usa Postgres, Fastify y Vitest',
    'Corre las migraciones antes de los tests',
    'Hace commit con conventional commits',
    'Responde siempre en español',
    'Vive en Berlin',
    'Escribe tests con Vitest',
    'Uses main as the default branch',
    'Deploys to production on Thursdays',
  ];
  for (const text of descriptions) {
    test(`no guard from: "${text}"`, () => {
      assert.equal(proposals([fact(text)]).length, 0,
        `a description was turned into a blocking rule: "${text}"`);
    });
  }

  test('a preference for pnpm alone does not block npm', () => {
    assert.equal(proposals([fact('Usa pnpm')]).length, 0);
  });

  test('but "no uses npm" does', () => {
    assert.equal(proposals([fact('No uses npm')]).length, 1);
  });
});

describe('enforcement — blocks what it should', () => {
  test('force push is blocked', () => {
    const g = guardFor('Nunca hagas force push');
    assert.equal(evaluate(bash('git push --force origin main'), [g]).deny, true);
    assert.equal(evaluate(bash('git push -f'), [g]).deny, true);
  });

  test('--force-with-lease is still allowed', () => {
    const g = guardFor('Nunca hagas force push');
    assert.equal(evaluate(bash('git push --force-with-lease origin main'), [g]).deny, false,
      'the safe form of force push must not be blocked');
  });

  test('rm -rf is blocked in either flag order', () => {
    const g = guardFor('Nunca borres archivos con rm -rf');
    assert.equal(evaluate(bash('rm -rf node_modules'), [g]).deny, true);
    assert.equal(evaluate(bash('rm -fr build'), [g]).deny, true);
  });

  test('a plain rm is not blocked', () => {
    const g = guardFor('Nunca borres archivos con rm -rf');
    assert.equal(evaluate(bash('rm build/output.js'), [g]).deny, false,
      'deleting one file is not a recursive delete');
  });

  test('the banned package manager is blocked, the rest are not', () => {
    const g = guardFor('No uses npm, usa pnpm');
    assert.equal(evaluate(bash('npm install lodash'), [g]).deny, true);
    assert.equal(evaluate(bash('pnpm install lodash'), [g]).deny, false);
    assert.equal(evaluate(bash('yarn add lodash'), [g]).deny, false);
  });

  test('editing a protected file is blocked', () => {
    const g = guardFor('No toques el .env nunca');
    assert.equal(evaluate(edit('/app/.env'), [g]).deny, true);
    assert.equal(evaluate(edit('/app/.env.production'), [g]).deny, true);
    assert.equal(evaluate(edit('/app/src/environment.ts'), [g]).deny, false,
      'a file whose name merely contains "environment" is not .env');
  });

  test('the deny reason names the rule it came from', () => {
    const g = guardFor('Nunca hagas force push');
    const v = evaluate(bash('git push --force'), [g]);
    assert.ok(v.reason && v.reason.length > 10);
    assert.equal(v.guard.from, 'Nunca hagas force push');
  });
});

describe('branch guards — the command alone is not enough', () => {
  test('commit on main is blocked', () => {
    gitRepoOnBranch('main');
    const g = guardFor('Nunca hagas commit directo a main');
    const v = evaluate(bash('git commit -m "fix"'), [g]);
    assert.equal(v.deny, true, 'a commit while on main must be blocked');
    assert.match(v.reason, /main/);
  });

  test('THE SAME COMMIT ON A FEATURE BRANCH IS ALLOWED', () => {
    gitRepoOnBranch('feature/login');
    const g = guardFor('Nunca hagas commit directo a main');
    assert.equal(evaluate(bash('git commit -m "fix"'), [g]).deny, false,
      'blocking every commit everywhere would make the guard unusable');
  });

  test('outside a git repo nothing is blocked', () => {
    const outside = path.join(sandbox, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    // An invalid local gitdir marker makes Git stop discovery here, keeping the
    // test hermetic even if a developer has versioned their whole home folder.
    fs.writeFileSync(path.join(outside, '.git'), 'gitdir: missing-repository\n');
    const g = guardFor('Nunca hagas commit directo a main');
    assert.equal(evaluate(bash('git commit -m "x"', outside), [g]).deny, false,
      'with no branch there is no basis to block');
  });
});

describe('fail open — a broken guard must never block work', () => {
  test('a malformed pattern is skipped, not fatal', () => {
    const broken = { id: 'x', from: 'broken', kind: 'command', tool: 'Bash', pattern: '([unclosed', reason: 'r' };
    assert.doesNotThrow(() => evaluate(bash('ls'), [broken]));
    assert.equal(evaluate(bash('ls'), [broken]).deny, false);
  });

  test('one broken guard does not disable the good ones', () => {
    const broken = { id: 'x', from: 'b', kind: 'command', tool: 'Bash', pattern: '([bad', reason: 'r' };
    const good = guardFor('Nunca hagas force push');
    assert.equal(evaluate(bash('git push --force'), [broken, good]).deny, true);
  });

  test('an empty or malformed payload allows', () => {
    const g = guardFor('Nunca hagas force push');
    assert.equal(evaluate({}, [g]).deny, false);
    assert.equal(evaluate({ tool_name: 'Bash' }, [g]).deny, false);
    assert.equal(evaluate(null, [g]).deny, false);
  });

  test('a guard for a different tool is ignored', () => {
    const g = guardFor('No toques el .env nunca');
    assert.equal(evaluate(bash('cat .env'), [g]).deny, false,
      'a path guard must not fire on a Bash command');
  });

  test('no guards at all means nothing is ever blocked', () => {
    assert.equal(evaluate(bash('rm -rf /'), []).deny, false);
  });
});

describe('opt-in — nothing is enforced without being asked for', () => {
  test('proposing does not enforce', () => {
    proposals([fact('Nunca hagas force push')]);
    assert.equal(activeGuards().length, 0, 'a proposal must never enforce itself');
  });

  test('adding is explicit and idempotent', () => {
    const g = guardFor('Nunca hagas force push');
    assert.equal(addGuard(g), true);
    assert.equal(addGuard(g), false, 'the same guard must not be added twice');
    assert.equal(activeGuards().length, 1);
  });

  test('a guard can be removed by quoting the rule', () => {
    addGuard(guardFor('Nunca hagas force push'));
    assert.equal(removeGuard('force push'), true);
    assert.equal(activeGuards().length, 0);
  });

  test('a paused guard stops firing but stays on file', () => {
    addGuard(guardFor('Nunca hagas force push'));
    const state = loadGuards();
    state.guards[0].enabled = false;
    fs.writeFileSync(path.join(process.env.WIFE_HOME, 'guards.json'), JSON.stringify(state));
    assert.equal(activeGuards().length, 0);
    assert.equal(loadGuards().guards.length, 1);
  });

  test('already-enforced rules are not proposed again', () => {
    const g = guardFor('Nunca hagas force push');
    addGuard(g);
    const again = proposals([fact('Nunca hagas force push')]);
    const existing = new Set(loadGuards().guards.map((x) => x.id));
    assert.equal(again.filter((p) => !existing.has(p.guard.id)).length, 0);
  });

  test('manual guards reject credentials without persisting or echoing them', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz1234';
    const result = wife(['guards', '--add', `Never expose ${secret}`, '--blocks', 'git push --force']);
    assert.equal(result.status, 1);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
    assert.equal(activeGuards().length, 0);
    assert.equal(fs.existsSync(path.join(process.env.WIFE_HOME, 'journal.jsonl')), false);
  });

  test('manual guards also reject configured denyPatterns in either field', () => {
    fs.mkdirSync(process.env.WIFE_HOME, { recursive: true });
    fs.writeFileSync(path.join(process.env.WIFE_HOME, 'config.json'), JSON.stringify({ denyPatterns: ['acme-codename'] }));
    const result = wife(['guards', '--add', 'Never deploy this target', '--blocks', 'deploy acme-codename']);
    assert.equal(result.status, 1);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /acme-codename/i);
    assert.equal(activeGuards().length, 0);
  });
});

describe('hook registration', () => {
  test('PreToolUse is NOT registered when there is nothing to enforce', () => {
    assert.equal(Object.hasOwn(wifeHooks('/usr/bin/node'), 'PreToolUse'), false,
      'a hook on every tool call that never blocks is pure latency');
  });

  test('PreToolUse appears once a guard exists', () => {
    addGuard(guardFor('Nunca hagas force push'));
    const hooks = wifeHooks('/usr/bin/node');
    assert.ok(hooks.PreToolUse, 'the guard cannot run without its hook');
    assert.match(hooks.PreToolUse[0].matcher, /Bash/);
    assert.deepEqual(hooks.PreToolUse[0].hooks[0].args.slice(-1), ['guard']);
  });

  test('attaching with guards registers all four events', () => {
    addGuard(guardFor('Nunca hagas force push'));
    attachClaude();
    assert.deepEqual(claudeStatus().events.sort(),
      ['PreToolUse', 'SessionEnd', 'SessionStart', 'UserPromptSubmit']);
  });

  test('adding and removing a guard refreshes every integration already attached', () => {
    attachClaude();
    attachCodex({ cwd: repo });
    attachCursor({ project: true, cwd: repo });
    assert.equal(claudeStatus().events.includes('PreToolUse'), false);
    assert.equal(codexStatus().events.includes('PreToolUse'), false);
    assert.equal(cursorStatus({ project: true, cwd: repo }).events.includes('beforeShellExecution'), false);

    const added = wife(['guards', '--add', 'Nunca hagas force push', '--blocks', 'git push --force']);
    assert.equal(added.status, 0, added.stderr);
    assert.equal(claudeStatus().events.includes('PreToolUse'), true);
    assert.equal(codexStatus().events.includes('PreToolUse'), true);
    assert.equal(cursorStatus({ project: true, cwd: repo }).events.includes('beforeShellExecution'), true);

    const removed = wife(['guards', '--off', 'force push']);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(claudeStatus().events.includes('PreToolUse'), false);
    assert.equal(codexStatus().events.includes('PreToolUse'), false);
    assert.equal(cursorStatus({ project: true, cwd: repo }).events.includes('beforeShellExecution'), false);
  });
});
