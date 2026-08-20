import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendPrompt, readSession } from '../src/core/session.js';
import { paths } from '../src/util/paths.js';
import { record, readJournal } from '../src/core/journal.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wife.js');

let sandbox;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wife-session-security-'));
  process.env.WIFE_HOME = path.join(sandbox, '.wife');
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.WIFE_HOME;
});

describe('session buffers screen before writing', () => {
  test('a prompt containing a credential never reaches the session file', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    const stored = appendPrompt('secret-session', {
      prompt: `remember that I prefer short answers; my key is ${secret}`,
      cwd: sandbox,
      agent: 'test',
    });

    assert.equal(stored, false);
    assert.equal(fs.existsSync(paths.session('secret-session')), false);
    assert.equal(fs.existsSync(paths.sessions()), false,
      'screening must happen before even creating the on-disk buffer directory');
  });

  test('custom deny patterns are also rejected before disk', () => {
    const stored = appendPrompt('private-session', {
      prompt: 'remember that the internal client is Acme-Codename',
      cwd: sandbox,
      agent: 'test',
      denyPatterns: ['acme-codename'],
    });

    assert.equal(stored, false);
    assert.equal(fs.existsSync(paths.session('private-session')), false);
  });

  test('prose API-key labels in English and Spanish are rejected before disk', () => {
    for (const [id, prompt, secret] of [
      ['english-label', 'remember that my API key is abc123xyz789', 'abc123xyz789'],
      ['spanish-label', 'recuerda que mi clave es hunter2000xyz', 'hunter2000xyz'],
    ]) {
      assert.equal(appendPrompt(id, { prompt, cwd: sandbox, agent: 'test' }), false);
      assert.equal(fs.existsSync(paths.session(id)), false);
      assert.ok(!fs.existsSync(paths.home()) ||
        !fs.readdirSync(paths.home(), { recursive: true }).some((name) => {
          const file = path.join(paths.home(), String(name));
          return fs.statSync(file).isFile() && fs.readFileSync(file, 'utf8').includes(secret);
        }), `credential from ${id} reached disk`);
    }
  });

  test('manual remember rejects a credential in a section without echoing or persisting it', () => {
    const secret = 'hunter2000xyz';
    const result = spawnSync(process.execPath, [
      CLI, 'remember', 'Uses pnpm', '--section', `password is ${secret}`,
    ], {
      cwd: sandbox,
      env: { ...process.env, WIFE_HOME: paths.home(), NO_COLOR: '1', WIFE_NO_COLOR: '1' },
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
    assert.equal(fs.existsSync(paths.identity()), false);
    assert.equal(fs.existsSync(paths.identityIndex()), false);
    assert.equal(fs.existsSync(paths.journal()), false);
  });

  test('ordinary prompts are still buffered normally', () => {
    const stored = appendPrompt('safe-session', {
      prompt: 'remember that I prefer short answers',
      cwd: sandbox,
      agent: 'test',
    });

    assert.equal(stored, true);
    assert.equal(readSession('safe-session').length, 1);
  });

  test('the append-only journal refuses unsafe provenance defensively', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz1234';
    assert.equal(record({ event: 'added', text: 'Prefers short answers', evidence: secret }), false);
    assert.equal(fs.existsSync(paths.journal()), false);

    assert.equal(record({ event: 'added', text: 'Prefers short answers', evidence: 'said directly' }), true);
    assert.equal(readJournal().length, 1);
    assert.doesNotMatch(fs.readFileSync(paths.journal(), 'utf8'), new RegExp(secret));
  });
});
