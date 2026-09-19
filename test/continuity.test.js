import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let sandbox, home, repo;
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wife-continuity-'));
  home = path.join(sandbox, '.wife');
  repo = path.join(sandbox, 'project');
  fs.mkdirSync(repo, { recursive: true });
  process.env.WIFE_HOME = home;
  process.env.WIFE_NO_COLOR = '1';
  process.env.NO_COLOR = '1';
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, encoding: 'utf8' });
});
afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.WIFE_HOME;
  delete process.env.WIFE_NO_COLOR;
  delete process.env.NO_COLOR;
});

const { loadConfig } = await import('../src/core/config.js');
const { openProject } = await import('../src/core/memory.js');
const { addEvidence, buildProjectContext, projectSnapshot, readCheckpoint, readEvidence, saveCheckpoint } = await import('../src/core/projectBrain.js');
const { cmdMergeDriver } = await import('../src/commands/gitsync.js');

describe('project continuity', () => {
  test('checkpoint captures goal, progress, next steps and the current checkout', () => {
    const checkpoint = saveCheckpoint(repo, {
      goal: 'Añadir autenticación',
      done: ['Endpoint de login'],
      next: ['Probar expiración'],
      blocked: ['Falta un fixture'],
    });
    assert.equal(checkpoint.goal, 'Añadir autenticación');
    assert.deepEqual(checkpoint.next, ['Probar expiración']);
    assert.equal(checkpoint.branch, 'main');
    assert.equal(readCheckpoint(repo).project.name, 'project');
  });

  test('evidence is explicit, bounded and linked to a commit when available', () => {
    const entry = addEvidence(repo, {
      kind: 'test',
      text: 'La suite de autenticación pasó',
      status: 'verified',
      files: ['src/auth.js', 'test/auth.test.js'],
    });
    assert.equal(entry.kind, 'test');
    assert.equal(entry.status, 'verified');
    assert.deepEqual(readEvidence(repo).map((item) => item.id), [entry.id]);
    assert.ok(fs.existsSync(path.join(home, 'projects')));
  });

  test('credentials are rejected before evidence reaches disk', () => {
    assert.throws(() => addEvidence(repo, {
      kind: 'note',
      text: 'my API key is sk-abcdefghijklmnopqrstuv',
    }), /credential/i);
    assert.deepEqual(readEvidence(repo), []);

    saveCheckpoint(repo, { goal: 'safe checkpoint' });
    const projectDir = path.join(home, 'projects', fs.readdirSync(path.join(home, 'projects'))[0]);
    const checkpointPath = path.join(projectDir, 'checkpoint.json');
    fs.writeFileSync(checkpointPath, JSON.stringify({ version: 1, goal: 'token sk-abcdefghijklmnopqrstuv' }));
    assert.equal(readCheckpoint(repo), null);
    assert.equal(fs.existsSync(checkpointPath), false);
  });

  test('context selects relevant project memory and includes continuity state', () => {
    const project = openProject(repo, loadConfig());
    project.store.upsert({ text: 'Uses Postgres for auth sessions', section: 'Stack', source: 'manual' });
    project.store.upsert({ text: 'Uses Redis for background jobs', section: 'Stack', source: 'manual' });
    project.store.save();
    saveCheckpoint(repo, { goal: 'Revisar Postgres auth sessions', next: ['Añadir una prueba'] });
    addEvidence(repo, { kind: 'test', text: 'Postgres auth session test passed', status: 'verified' });

    const result = buildProjectContext({ cwd: repo, hint: 'Postgres auth', config: loadConfig(), budget: 500 });
    assert.match(result.text, /Postgres auth sessions/);
    assert.match(result.text, /Continuity checkpoint/);
    assert.match(result.text, /Postgres auth session test passed/);
    assert.doesNotMatch(result.text, /Redis for background jobs/);
    assert.ok(result.tokens <= 500, `context exceeded budget: ${result.tokens}`);
    const tiny = buildProjectContext({ cwd: repo, hint: 'Postgres', config: loadConfig(), budget: 1 });
    assert.ok(tiny.tokens <= 1, `tiny context exceeded budget: ${tiny.tokens}`);
  });

  test('repository snapshot exposes branch, commit state and bounded dirty paths', () => {
    fs.writeFileSync(path.join(repo, 'README.md'), '# Project\n');
    const snapshot = projectSnapshot(repo);
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.branch, 'main');
    assert.ok(snapshot.dirtyFiles.some((file) => file.includes('README.md')));
  });

  test('sync merges receipts by union and checkpoints without losing concurrent work', () => {
    const evidenceBase = path.join(sandbox, 'evidence-base.jsonl');
    const evidenceOurs = path.join(sandbox, 'evidence-ours.jsonl');
    const evidenceTheirs = path.join(sandbox, 'evidence-theirs.jsonl');
    const receipt = (id, text, at) => ({ id, at, kind: 'test', text, source: 'operator', files: [], status: 'verified', commit: '' });
    fs.writeFileSync(evidenceBase, `${JSON.stringify(receipt('a'.repeat(12), 'Base test', '2026-01-01T00:00:00.000Z'))}\n`);
    fs.writeFileSync(evidenceOurs, `${JSON.stringify(receipt('a'.repeat(12), 'Base test', '2026-01-01T00:00:00.000Z'))}\n${JSON.stringify(receipt('b'.repeat(12), 'Laptop test', '2026-01-02T00:00:00.000Z'))}\n`);
    fs.writeFileSync(evidenceTheirs, `${JSON.stringify(receipt('a'.repeat(12), 'Base test', '2026-01-01T00:00:00.000Z'))}\n${JSON.stringify(receipt('c'.repeat(12), 'Desktop test', '2026-01-03T00:00:00.000Z'))}\n`);
    assert.equal(cmdMergeDriver({ _: [evidenceBase, evidenceOurs, evidenceTheirs, 'projects/project/evidence.jsonl'] }), 0);
    const mergedEvidence = fs.readFileSync(evidenceOurs, 'utf8');
    assert.match(mergedEvidence, /Laptop test/);
    assert.match(mergedEvidence, /Desktop test/);

    const checkpointBase = path.join(sandbox, 'checkpoint-base.json');
    const checkpointOurs = path.join(sandbox, 'checkpoint-ours.json');
    const checkpointTheirs = path.join(sandbox, 'checkpoint-theirs.json');
    const checkpoint = (next, done, updatedAt) => ({
      version: 1, project: { key: 'project-key', name: 'project' }, goal: 'Ship context', done, next,
      blocked: [], branch: 'main', commit: 'abc1234', dirtyFiles: [], updatedAt,
    });
    fs.writeFileSync(checkpointBase, JSON.stringify(checkpoint([], [], '2026-01-01T00:00:00.000Z')));
    fs.writeFileSync(checkpointOurs, JSON.stringify(checkpoint(['Review README'], ['Add context command'], '2026-01-02T00:00:00.000Z')));
    fs.writeFileSync(checkpointTheirs, JSON.stringify(checkpoint(['Run CI'], ['Add evidence command'], '2026-01-03T00:00:00.000Z')));
    assert.equal(cmdMergeDriver({ _: [checkpointBase, checkpointOurs, checkpointTheirs, 'projects/project/checkpoint.json'] }), 0);
    const mergedCheckpoint = JSON.parse(fs.readFileSync(checkpointOurs, 'utf8'));
    assert.deepEqual(mergedCheckpoint.next.sort(), ['Review README', 'Run CI']);
    assert.deepEqual(mergedCheckpoint.done.sort(), ['Add context command', 'Add evidence command']);
  });
});

describe('continuity CLI', () => {
  test('checkpoint, evidence and context are available from the installed command surface', () => {
    const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wife.js');
    const env = { ...process.env, WIFE_HOME: home, WIFE_NO_COLOR: '1', NO_COLOR: '1' };
    const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: 'utf8' });

    let result = run(['checkpoint', 'set', '--goal', 'Ship project context', '--next', 'Add evidence']);
    assert.equal(result.status, 0, result.stderr);
    result = run(['evidence', 'add', '--kind', 'decision', '--text', 'Context is bounded and local', '--status', 'verified']);
    assert.equal(result.status, 0, result.stderr);
    result = run(['context', 'project context', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.text, /Ship project context/);
    assert.match(payload.text, /Context is bounded and local/);
    result = run(['checkpoint', 'clear']);
    assert.equal(result.status, 0, result.stderr);
    result = run(['checkpoint', 'show', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  });
});
