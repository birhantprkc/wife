import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stateLockPath, withStateLock, withStateLockSync } from '../src/util/lock.js';
import { appendPrompt } from '../src/core/session.js';
import { harvestSession } from '../src/core/harvest.js';
import { loadConfig } from '../src/core/config.js';
import { openProject } from '../src/core/memory.js';

let sandbox;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wife-concurrency-'));
  process.env.WIFE_HOME = path.join(sandbox, '.wife');
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.WIFE_HOME;
});

describe('cross-process state lock', () => {
  test('an overlapping mutation defers, then succeeds after release', async () => {
    const first = await withStateLock(async () => {
      const overlapping = await withStateLock(() => 'must not run');
      assert.equal(overlapping.acquired, false);
      return 'first completed';
    });
    assert.deepEqual(first, { acquired: true, value: 'first completed' });

    const after = await withStateLock(() => 'second completed');
    assert.deepEqual(after, { acquired: true, value: 'second completed' });
  });

  test('a fresh empty or malformed lock is never stolen during owner initialization', () => {
    fs.mkdirSync(path.dirname(stateLockPath()), { recursive: true });
    for (const contents of ['', '{']) {
      fs.writeFileSync(stateLockPath(), contents);
      let ran = false;
      const attempt = withStateLockSync(() => { ran = true; });
      assert.equal(attempt.acquired, false);
      assert.equal(ran, false);
      fs.rmSync(stateLockPath(), { force: true });
    }
    assert.deepEqual(withStateLockSync(() => 42), { acquired: true, value: 42 });
  });
});

describe('harvest project routing', () => {
  test('a nested repository is not attributed to the cached parent repository', () => {
    const outer = path.join(sandbox, 'outer');
    const inner = path.join(outer, 'packages', 'inner');
    fs.mkdirSync(path.join(outer, '.git'), { recursive: true });
    fs.mkdirSync(path.join(inner, '.git'), { recursive: true });

    appendPrompt('nested-repos', {
      prompt: 'this project uses OuterDB for persistent application storage',
      cwd: outer,
      agent: 'test',
    });
    appendPrompt('nested-repos', {
      prompt: 'this project uses InnerDB for persistent application storage',
      cwd: inner,
      agent: 'test',
    });

    const config = { ...loadConfig(), promotionThreshold: 1 };
    harvestSession('nested-repos', { config });

    const outerFacts = openProject(outer, config).store.facts().map((f) => f.text).join('\n');
    const innerFacts = openProject(inner, config).store.facts().map((f) => f.text).join('\n');
    assert.match(outerFacts, /OuterDB/);
    assert.doesNotMatch(outerFacts, /InnerDB/);
    assert.match(innerFacts, /InnerDB/);
    assert.doesNotMatch(innerFacts, /OuterDB/);
  });
});
