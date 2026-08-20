import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wife.js');

let sandbox;
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wife-agents-'));
  process.env.WIFE_HOME = path.join(sandbox, '.wife');
  process.env.CLAUDE_CONFIG_DIR = path.join(sandbox, '.claude');
  process.env.CODEX_HOME = path.join(sandbox, '.codex');
  process.env.CURSOR_HOME = path.join(sandbox, '.cursor-home');
  process.env.GEMINI_HOME = path.join(sandbox, '.gemini');
});
afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.WIFE_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.CURSOR_HOME;
  delete process.env.GEMINI_HOME;
});

const { attachClaude, detachClaude, claudeStatus, isWifeHandler, wifeHooks } = await import('../src/agents/claude.js');
const { attachCodex, detachCodex, detachCodexBlock, codexStatus, upsertBlock, codexHooks, hooksPath,
  isWifeHandler: isWifeCodexHandler, BEGIN, END } = await import('../src/agents/codex.js');
const { attachCursor, detachCursor, cursorStatus, hooksPath: cursorHooksPath } = await import('../src/agents/cursor.js');
const { attachGemini, geminiPath } = await import('../src/agents/gemini.js');
const { refines, contradicts } = await import('../src/util/text.js');
const { openIdentity, openProject } = await import('../src/core/memory.js');

describe('regression: merging must not collapse different facts', () => {
  test('one differing word keeps two facts apart, however long they are', () => {
    const a = 'Deploys to production every Friday afternoon after the tests pass';
    const b = 'Deploys to staging every Friday afternoon after the tests pass';
    assert.equal(refines(a, b), 0, 'these say different things and must both survive');
    assert.equal(contradicts(a, b), false);
  });

  test('a strictly more detailed restatement does merge', () => {
    assert.equal(refines('Prefers short answers', 'Prefers short direct answers'), 1);
    assert.equal(refines('Prefers short direct answers', 'Prefers short answers'), -1);
  });

  test('different technologies never merge', () => {
    assert.equal(refines('Uses Postgres for storage', 'Uses MySQL for storage'), 0);
    assert.equal(refines('Writes Kotlin', 'Writes Swift'), 0);
  });

  test('the store keeps both variants', () => {
    const store = openIdentity();
    store.upsert({ text: 'Deploys to production every Friday after tests pass', section: 'Who' });
    store.upsert({ text: 'Deploys to staging every Friday after tests pass', section: 'Who' });
    assert.equal(store.facts().length, 2);
  });
});

describe('Claude Code wiring', () => {
  test('registers the three lifecycle hooks', () => {
    const res = attachClaude();
    const settings = JSON.parse(fs.readFileSync(res.file, 'utf8'));
    assert.deepEqual(Object.keys(settings.hooks).sort(), ['SessionEnd', 'SessionStart', 'UserPromptSubmit']);
  });

  test('SessionEnd declares a timeout above the 1.5s shared budget', () => {
    const hooks = wifeHooks('/usr/bin/node');
    const sessionEnd = hooks.SessionEnd[0].hooks[0];
    assert.ok(sessionEnd.timeout >= 5, 'harvest needs more than the default SessionEnd budget');
  });

  test('uses exec form with an absolute path, so PATH and spaces cannot break it', () => {
    const hooks = wifeHooks('/usr/bin/node');
    const handler = hooks.SessionStart[0].hooks[0];
    assert.equal(handler.command, '/usr/bin/node');
    assert.ok(path.isAbsolute(handler.args[0]));
    assert.match(handler.args[0], /wife\.js$/);
  });

  test('leaves existing settings completely untouched', () => {
    const file = path.join(sandbox, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      model: 'opus',
      permissions: { allow: ['Bash(git *)'] },
      hooks: {
        PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier --write' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
    }, null, 2));

    attachClaude();
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.model, 'opus');
    assert.deepEqual(after.permissions.allow, ['Bash(git *)']);
    assert.equal(after.hooks.PostToolUse[0].hooks[0].command, 'prettier --write');
    const starts = after.hooks.SessionStart.flatMap((g) => g.hooks);
    assert.ok(starts.some((h) => h.command === 'echo hi'), 'the user\'s own SessionStart hook was destroyed');
    assert.ok(starts.some(isWifeHandler), 'wife did not register');
  });

  test('attaching twice does not duplicate', () => {
    attachClaude();
    attachClaude();
    attachClaude();
    const settings = JSON.parse(fs.readFileSync(claudeStatus().file, 'utf8'));
    const wifeHandlers = Object.values(settings.hooks).flat().flatMap((g) => g.hooks).filter(isWifeHandler);
    assert.equal(wifeHandlers.length, 3, `expected 3 handlers, found ${wifeHandlers.length}`);
  });

  test('detach removes only wife and leaves the rest intact', () => {
    const file = path.join(sandbox, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
    }));
    attachClaude();
    const res = detachClaude();
    assert.equal(res.removed, 3);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.hooks.SessionStart[0].hooks[0].command, 'echo hi');
    assert.equal(claudeStatus().attached, false);
  });

  test('detach on a machine with no settings file does not throw', () => {
    assert.doesNotThrow(() => detachClaude());
  });

  test('status reports honestly before and after', () => {
    assert.equal(claudeStatus().attached, false);
    attachClaude();
    assert.equal(claudeStatus().attached, true);
  });

  test('does not mistake midwife.js for one of its own handlers', () => {
    assert.equal(isWifeHandler({ command: 'node', args: ['/tools/midwife.js'] }), false);
  });
});

describe('Codex wiring', () => {
  test('registers real lifecycle hooks, not just a text block', () => {
    const res = attachCodex();
    const hooks = JSON.parse(fs.readFileSync(res.file, 'utf8')).hooks;
    assert.deepEqual(Object.keys(hooks).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit'].sort());
    assert.equal(codexStatus().attached, true);
    assert.deepEqual(codexStatus().events.sort(), ['SessionStart', 'Stop', 'UserPromptSubmit'].sort());
  });

  test('the session ends on Stop, not SessionEnd', () => {
    const hooks = codexHooks('/usr/bin/node');
    assert.ok(hooks.Stop, 'Codex has no SessionEnd event; wiring one there would never fire');
    assert.equal(Object.hasOwn(hooks, 'SessionEnd'), false);
  });

  test('SessionStart only fires on startup and resume, not on clear', () => {
    assert.match(codexHooks('/usr/bin/node').SessionStart[0].matcher, /startup/);
  });

  test('still writes the AGENTS.md fallback for builds without hooks', () => {
    const res = attachCodex();
    const content = fs.readFileSync(res.fallback, 'utf8');
    assert.ok(content.includes(BEGIN));
    assert.ok(content.includes(END));
  });

  test('enables the codex_hooks feature flag for older builds', () => {
    attachCodex();
    const cfg = fs.readFileSync(path.join(sandbox, '.codex', 'config.toml'), 'utf8');
    assert.match(cfg, /codex_hooks\s*=\s*true/);
  });

  test('attaching twice does not duplicate handlers', () => {
    attachCodex();
    attachCodex();
    attachCodex();
    const hooks = JSON.parse(fs.readFileSync(hooksPath(), 'utf8')).hooks;
    const mine = Object.values(hooks).flat().flatMap((g) => g.hooks || []).filter(isWifeCodexHandler);
    assert.equal(mine.length, 3, `expected 3 handlers, found ${mine.length}`);
  });

  test('leaves another tool\'s Codex hooks alone', () => {
    const file = hooksPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
    }));
    attachCodex();
    const hooks = JSON.parse(fs.readFileSync(file, 'utf8')).hooks;
    const all = hooks.SessionStart.flatMap((g) => g.hooks);
    assert.ok(all.some((h) => h.command === 'echo hi'), 'destroyed another tool\'s hook');
    assert.ok(all.some(isWifeCodexHandler));
  });

  test('never touches text outside its markers', () => {
    const before = '# My rules\n\nAlways run `bun test` before pushing.\n';
    const merged = upsertBlock(before, `${BEGIN}\nBLOCK\n${END}`);
    assert.ok(merged.startsWith('# My rules'));
    assert.ok(merged.includes('Always run `bun test` before pushing.'));
    assert.ok(merged.includes('BLOCK'));
  });

  test('re-syncing replaces the block in place instead of stacking copies', () => {
    const withBlock = upsertBlock('# Mine\n', `${BEGIN}\nOLD\n${END}`);
    const resynced = upsertBlock(withBlock, `${BEGIN}\nNEW\n${END}`);
    assert.equal((resynced.match(new RegExp(BEGIN.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);
    assert.ok(resynced.includes('NEW'));
    assert.ok(!resynced.includes('OLD'));
    assert.ok(resynced.includes('# Mine'));
  });

  test('replaces a legacy generic full-line block instead of stacking it', () => {
    const legacy = '# Mine\n\n<!-- wife:begin managed by an old release -->\nOLD\n<!-- wife:end -->\n';
    const resynced = upsertBlock(legacy, `${BEGIN}\nNEW\n${END}`);
    assert.equal((resynced.match(/^[ \t]*<!--[ \t]*wife:begin\b/gm) || []).length, 1);
    assert.ok(resynced.includes('NEW'));
    assert.ok(!resynced.includes('OLD'));
  });

  test('only recognises markers that occupy a complete line', () => {
    const docs = '# Docs\n\nExample: `<!-- wife:begin old -->` and `<!-- wife:end -->`.\n';
    const merged = upsertBlock(docs, `${BEGIN}\nBLOCK\n${END}`);
    assert.ok(merged.includes('Example: `<!-- wife:begin old -->`'));
    assert.equal((merged.match(/^[ \t]*<!--[ \t]*wife:begin\b/gm) || []).length, 1);
  });

  test('marker examples inside CommonMark fences remain user-owned text', () => {
    const fenced = [
      '# Documentation',
      '````markdown',
      '<!-- wife:begin example one -->',
      'USER DOCUMENTATION ONE',
      '<!-- wife:end -->',
      '````html',
      '<!-- wife:begin example two -->',
      'USER DOCUMENTATION TWO',
      '<!-- wife:end -->',
      '````',
      '',
    ].join('\n');
    const merged = upsertBlock(fenced, `${BEGIN}\nREAL BLOCK\n${END}`);
    assert.match(merged, /USER DOCUMENTATION ONE/);
    assert.match(merged, /USER DOCUMENTATION TWO/);
    assert.match(merged, /REAL BLOCK/);

    const file = path.join(sandbox, '.codex', 'AGENTS.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, merged);
    detachCodexBlock();
    const detached = fs.readFileSync(file, 'utf8');
    assert.match(detached, /USER DOCUMENTATION ONE/);
    assert.match(detached, /USER DOCUMENTATION TWO/);
    assert.doesNotMatch(detached, /REAL BLOCK/);
  });

  test('ignores orphan ends and consolidates every complete historical block', () => {
    const historical = [
      '<!-- wife:end -->',
      '# User text before',
      '<!-- wife:begin release one -->',
      'OLD ONE',
      '<!-- wife:end -->',
      'User text between',
      '<!-- wife:begin release two -->',
      'OLD TWO',
      '<!-- wife:end -->',
      'User text after',
      '',
    ].join('\n');
    const resynced = upsertBlock(historical, `${BEGIN}\nNEW\n${END}`);
    assert.equal((resynced.match(/^[ \t]*<!--[ \t]*wife:begin\b/gm) || []).length, 1);
    assert.ok(resynced.startsWith('<!-- wife:end -->'));
    assert.match(resynced, /User text before/);
    assert.match(resynced, /User text between/);
    assert.match(resynced, /User text after/);
    assert.doesNotMatch(resynced, /OLD ONE|OLD TWO/);

    const file = path.join(sandbox, '.codex', 'AGENTS.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, historical);
    const detached = detachCodexBlock();
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(detached.removed, true);
    assert.equal((after.match(/^[ \t]*<!--[ \t]*wife:begin\b/gm) || []).length, 0);
    assert.ok(after.startsWith('<!-- wife:end -->'));
    assert.match(after, /User text before/);
    assert.match(after, /User text between/);
    assert.match(after, /User text after/);
  });

  test('detach removes hooks and the block, leaving other content behind', () => {
    const file = path.join(sandbox, '.codex', 'AGENTS.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# House rules\n\nUse tabs.\n');
    attachCodex();
    detachCodex();
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.includes('# House rules'));
    assert.ok(after.includes('Use tabs.'));
    assert.ok(!after.includes(BEGIN));
  });

  test('a malformed fallback cannot leave attach or detach half-applied', () => {
    const agentsFile = path.join(sandbox, '.codex', 'AGENTS.md');
    const hooksFile = hooksPath();
    const configFile = path.join(sandbox, '.codex', 'config.toml');
    const malformed = '# User rules\n\n<!-- wife:begin legacy -->\nunterminated\n';
    fs.mkdirSync(path.dirname(agentsFile), { recursive: true });
    fs.writeFileSync(agentsFile, malformed);

    assert.throws(() => attachCodex(), /Malformed wife managed block/);
    assert.equal(fs.existsSync(hooksFile), false, 'attach wrote hooks before validating AGENTS.md');
    assert.equal(fs.existsSync(configFile), false, 'attach changed config before validating AGENTS.md');
    assert.equal(fs.readFileSync(agentsFile, 'utf8'), malformed);

    fs.writeFileSync(agentsFile, '# User rules\n');
    attachCodex();
    const hooksBefore = fs.readFileSync(hooksFile, 'utf8');
    const configBefore = fs.readFileSync(configFile, 'utf8');
    fs.writeFileSync(agentsFile, malformed);

    assert.throws(() => detachCodex(), /Malformed wife managed block/);
    assert.equal(fs.readFileSync(hooksFile, 'utf8'), hooksBefore, 'detach removed hooks before validating AGENTS.md');
    assert.equal(fs.readFileSync(configFile, 'utf8'), configBefore);
    assert.equal(fs.readFileSync(agentsFile, 'utf8'), malformed);
  });
});

describe('global context scope', () => {
  test('global Codex and Gemini files exclude the current project memory', () => {
    const repo = path.join(sandbox, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

    const identity = openIdentity();
    identity.upsert({ text: 'Prefers identity-only answers', section: 'Who' });
    identity.save();
    const project = openProject(repo);
    project.store.upsert({ text: 'Project-only sentinel uses lunar deploys', section: 'Stack' });
    project.store.save();

    attachCodex({ cwd: repo });
    const globalCodex = fs.readFileSync(path.join(sandbox, '.codex', 'AGENTS.md'), 'utf8');
    assert.match(globalCodex, /identity-only/i);
    assert.doesNotMatch(globalCodex, /lunar deploys/i);

    attachGemini({ cwd: repo });
    const globalGemini = fs.readFileSync(geminiPath(), 'utf8');
    assert.match(globalGemini, /identity-only/i);
    assert.doesNotMatch(globalGemini, /lunar deploys/i);

    attachCodex({ project: true, cwd: repo });
    assert.match(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'), /lunar deploys/i);
    attachGemini({ project: true, cwd: repo });
    assert.match(fs.readFileSync(path.join(repo, 'GEMINI.md'), 'utf8'), /lunar deploys/i);
  });
});

describe('external JSON safety', () => {
  const integrations = [
    {
      name: 'Claude Code',
      file: () => path.join(sandbox, '.claude', 'settings.json'),
      status: () => claudeStatus(),
      attach: () => attachClaude(),
      detach: () => detachClaude(),
      malformedEvents: ['{"hooks":{"SessionStart":{}}}', '{"hooks":{"SessionStart":[null]}}'],
    },
    {
      name: 'Codex',
      file: () => hooksPath(),
      status: () => codexStatus(),
      attach: () => attachCodex(),
      detach: () => detachCodex(),
      malformedEvents: ['{"hooks":{"SessionStart":{}}}', '{"hooks":{"SessionStart":[null]}}'],
    },
    {
      name: 'Cursor',
      file: () => cursorHooksPath({ project: false }),
      status: () => cursorStatus({ project: false }),
      attach: () => attachCursor({ project: false }),
      detach: () => detachCursor({ project: false }),
      malformedEvents: ['{"hooks":{"SessionStart":{}}}'],
    },
  ];

  for (const integration of integrations) {
    test(`${integration.name}: status is read-only and attach/detach reject invalid JSON`, () => {
      const file = integration.file();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const invalid = '{ "hooks": [ definitely not JSON';
      fs.writeFileSync(file, invalid);

      const status = integration.status();
      assert.equal(status.attached, false);
      assert.equal(status.invalid, true);
      assert.equal(fs.readFileSync(file, 'utf8'), invalid);
      assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.includes('.corrupt.')), false);

      assert.throws(integration.attach, /Invalid JSON/);
      assert.throws(integration.detach, /Invalid JSON/);
      assert.equal(fs.readFileSync(file, 'utf8'), invalid);
      assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.includes('.corrupt.')), false);
    });

    for (const [index, invalid] of ['[]', '{"hooks":[]}'].entries()) {
      test(`${integration.name}: rejects invalid root/hooks shape ${index + 1} without changing bytes`, () => {
        const file = integration.file();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, invalid);

        assert.equal(integration.status().invalid, true);
        assert.throws(integration.attach, /Invalid JSON structure/);
        assert.throws(integration.detach, /Invalid JSON structure/);
        assert.equal(fs.readFileSync(file, 'utf8'), invalid);
      });
    }

    for (const [index, invalid] of integration.malformedEvents.entries()) {
      test(`${integration.name}: rejects malformed nested hooks ${index + 1} without changing bytes`, () => {
        const file = integration.file();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, invalid);

        assert.equal(integration.status().invalid, true);
        assert.throws(integration.attach, /Invalid JSON structure/);
        assert.throws(integration.detach, /Invalid JSON structure/);
        assert.equal(fs.readFileSync(file, 'utf8'), invalid);
      });
    }
  }

  test('the status command reports invalid JSON and its path without modifying it', () => {
    const repo = path.join(sandbox, 'repo');
    const file = path.join(sandbox, '.claude', 'settings.json');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const invalid = '{bad json';
    fs.writeFileSync(file, invalid);

    const result = spawnSync(process.execPath, [CLI, 'status'], {
      cwd: repo,
      env: { ...process.env, NO_COLOR: '1', WIFE_NO_COLOR: '1' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Claude Code.*invalid settings JSON.*settings\.json/i);
    assert.doesNotMatch(result.stdout, /Claude Code.*not attached/i);
    assert.equal(fs.readFileSync(file, 'utf8'), invalid);
    assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.includes('.corrupt.')), false);
  });
});
