import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let sandbox;
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wife-test-'));
  process.env.WIFE_HOME = sandbox;
});
afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  delete process.env.WIFE_HOME;
});

// Imported after the env var is settable; the modules read it lazily so this is safe.
const { Store, parseMarkdown } = await import('../src/core/store.js');
const { openIdentity } = await import('../src/core/memory.js');
const { harvestSession } = await import('../src/core/harvest.js');
const { appendPrompt } = await import('../src/core/session.js');
const { compileContext } = await import('../src/core/compile.js');
const { loadConfig } = await import('../src/core/config.js');
const { mergeIndex } = await import('../src/core/merge.js');

function newStore(overrides = {}) {
  return new Store({
    mdPath: path.join(sandbox, 'identity.md'),
    indexPath: path.join(sandbox, 'identity.index.json'),
    sections: ['Who', 'Preferences', 'Working style', 'Constraints'],
    title: 'test',
    header: null,
    halfLife: 90,
    scope: 'user',
    ...overrides,
  }).load();
}

describe('markdown parsing', () => {
  test('reads bullets under headings and ignores prose', () => {
    const parsed = parseMarkdown([
      '# Title', '', 'Some prose that is not a fact.', '',
      '## Who', '- Lives in Berlin', '- Builds AI products', '',
      '## Preferences', '- Prefers short answers', '',
    ].join('\n'));
    assert.equal(parsed.length, 3);
    assert.deepEqual(parsed[0], { section: 'Who', text: 'Lives in Berlin' });
    assert.equal(parsed[2].section, 'Preferences');
  });

  test('a bullet before any heading is ignored', () => {
    assert.equal(parseMarkdown('- orphan bullet\n## Who\n- real').length, 1);
  });
});

describe('hand editing is first-class', () => {
  test('a line typed by hand is adopted at full confidence', () => {
    const store = newStore();
    store.save({ force: true });
    fs.writeFileSync(path.join(sandbox, 'identity.md'), '# t\n\n## Who\n- Writes Kotlin for Android\n');
    const reloaded = newStore();
    const facts = reloaded.facts();
    assert.equal(facts.length, 1);
    assert.equal(facts[0].text, 'Writes Kotlin for Android');
    assert.equal(facts[0].source, 'manual');
    assert.equal(facts[0].confidence, 1);
  });

  test('a line deleted by hand is forgotten, with no command needed', () => {
    const store = newStore();
    store.upsert({ text: 'Prefers short answers', section: 'Preferences' });
    store.upsert({ text: 'Lives in Berlin', section: 'Who' });
    store.save();
    assert.equal(newStore().facts().length, 2);

    fs.writeFileSync(path.join(sandbox, 'identity.md'), '# t\n\n## Who\n- Lives in Berlin\n');
    const after = newStore();
    assert.equal(after.facts().length, 1);
    assert.equal(after.facts()[0].text, 'Lives in Berlin');
  });

  test('metadata survives a hand edit that only moves a line', () => {
    const store = newStore();
    store.upsert({ text: 'Prefers short answers', section: 'Preferences', confidence: 0.7 });
    store.upsert({ text: 'Prefers short answers', section: 'Preferences' }); // reinforce
    store.save();
    const seenBefore = store.facts()[0].seen;

    fs.writeFileSync(path.join(sandbox, 'identity.md'), '# t\n\n## Who\n- Prefers short answers\n');
    const after = newStore().facts()[0];
    assert.equal(after.seen, seenBefore, 'seen count must survive');
    assert.equal(after.section, 'Who', 'the section shown in the file wins');
  });

  test('a hand deletion creates a tombstone that can cross a git merge', () => {
    const store = newStore();
    const { id } = store.upsert({ text: 'Prefers short answers', section: 'Preferences' });
    store.save();

    fs.writeFileSync(path.join(sandbox, 'identity.md'), '# t\n\n## Preferences\n');
    const reloaded = newStore();
    assert.equal(reloaded.facts().length, 0);
    assert.match(reloaded.index.tombstones[id].reason, /removed by hand/i);
    reloaded.save();
    assert.ok(JSON.parse(fs.readFileSync(path.join(sandbox, 'identity.index.json'), 'utf8')).tombstones[id]);
  });

  test('remembering a deliberately deleted fact clears its tombstone', () => {
    const store = newStore();
    const { id } = store.upsert({ text: 'Prefers short answers', section: 'Preferences' });
    store.remove(id);
    assert.ok(store.index.tombstones[id]);
    store.upsert({ text: 'Prefers short answers', section: 'Preferences' });
    assert.equal(store.index.tombstones[id], undefined);
    assert.ok(store.get(id));
  });
});

describe('reconciliation', () => {
  test('the same fact twice is reinforced, not duplicated', () => {
    const store = newStore();
    store.upsert({ text: 'Uses Postgres', section: 'Who', sessionId: 's1' });
    const second = store.upsert({ text: 'uses postgres.', section: 'Who', sessionId: 's2' });
    assert.equal(second.action, 'reinforced');
    assert.equal(store.facts().length, 1);
    assert.equal(store.facts()[0].seen, 2);
    assert.equal(store.facts()[0].sessions.length, 2);
  });

  test('a contradiction supersedes instead of piling up', () => {
    const store = newStore();
    store.upsert({ text: 'Uses Next.js for the frontend', section: 'Who' });
    const result = store.upsert({ text: 'no Uses Next.js for the frontend', section: 'Who' });
    assert.equal(result.action, 'superseded');
    assert.equal(store.facts().length, 1, 'both versions must not coexist');
  });

  test('a more specific restatement replaces the vaguer one', () => {
    const store = newStore();
    store.upsert({ text: 'Prefers short answers', section: 'Preferences' });
    const result = store.upsert({ text: 'Prefers short direct answers', section: 'Preferences' });
    assert.equal(result.action, 'superseded');
    assert.equal(store.facts().length, 1);
    assert.equal(store.facts()[0].text, 'Prefers short direct answers');
  });

  test('unrelated facts coexist', () => {
    const store = newStore();
    store.upsert({ text: 'Lives in Berlin Germany', section: 'Who' });
    store.upsert({ text: 'Prefers short answers', section: 'Preferences' });
    assert.equal(store.facts().length, 2);
  });
});

describe('the promotion gate', () => {
  test('a soft candidate waits for a second session', () => {
    const store = newStore();
    const first = store.stage({ text: 'Prefers dark mode', section: 'Preferences', kind: 'preference', confidence: 0.7, sessionId: 's1', threshold: 2 });
    assert.equal(first.action, 'staged');
    assert.equal(store.facts().length, 0, 'must not reach memory on one sighting');

    const again = store.stage({ text: 'Prefers dark mode', section: 'Preferences', kind: 'preference', confidence: 0.7, sessionId: 's1', threshold: 2 });
    assert.equal(again.action, 'staged', 'the same session repeating itself proves nothing');
    assert.equal(store.facts().length, 0);

    const second = store.stage({ text: 'Prefers dark mode', section: 'Preferences', kind: 'preference', confidence: 0.7, sessionId: 's2', threshold: 2 });
    assert.equal(second.action, 'added');
    assert.equal(store.facts().length, 1);
  });

  test('stale candidates expire', () => {
    const store = newStore();
    store.stage({ text: 'Prefers dark mode', section: 'Preferences', kind: 'preference', confidence: 0.7, sessionId: 's1', threshold: 2 });
    store.index.pending[Object.keys(store.index.pending)[0]].last = new Date(Date.now() - 200 * 86400000).toISOString();
    assert.equal(store.expirePending(60), 1);
    assert.equal(store.pending().length, 0);
  });
});

describe('last-line credential defence', () => {
  test('Store rejects secrets in text and evidence without touching any sidecar or journal', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz1234';
    const store = newStore();
    const direct = store.upsert({ text: `Production token ${token}`, section: 'Who' });
    const staged = store.stage({
      text: 'Uses the production deployment account', section: 'Who', kind: 'fact',
      confidence: 0.8, sessionId: 's1', evidence: `Authorization: Bearer ${token}abcdefghijklmnop`,
    });
    store.save({ force: true });

    assert.equal(direct.action, 'unchanged');
    assert.equal(staged.action, 'unchanged');
    assert.match(direct.reason, /credential/);
    assert.equal(store.facts().length, 0);
    assert.equal(store.pending().length, 0);
    const disk = fs.readdirSync(sandbox, { recursive: true })
      .filter((file) => typeof file === 'string' && fs.statSync(path.join(sandbox, file)).isFile())
      .map((file) => fs.readFileSync(path.join(sandbox, file), 'utf8'))
      .join('\n');
    assert.ok(!disk.includes(token), 'Store leaked a rejected credential to disk');
  });

  test('unsafe hand-edited bullets and sections are removed before injection', () => {
    const password = 'hunter2000xyz';
    const clientSecret = 'abc123xyz789';
    fs.writeFileSync(path.join(sandbox, 'identity.md'), [
      '# test', '', '## Who',
      `- password is ${password}`,
      '- Prefers short answers', '',
      `## client secret = ${clientSecret}`,
      '- Uses pnpm', '',
    ].join('\n'));

    const store = newStore();
    assert.deepEqual(store.facts().map((fact) => fact.text), ['Prefers short answers']);
    assert.doesNotMatch(store.render(), new RegExp(`${password}|${clientSecret}`));
    store.save();
    const disk = fs.readFileSync(path.join(sandbox, 'identity.md'), 'utf8') +
      fs.readFileSync(path.join(sandbox, 'identity.index.json'), 'utf8');
    assert.doesNotMatch(disk, new RegExp(`${password}|${clientSecret}`));
  });
});

describe('the token budget', () => {
  test('the lowest-scoring fact is evicted first', () => {
    const store = newStore();
    const topics = ['Kotlin', 'Postgres', 'Deno', 'Tailwind', 'Vitest', 'Docker', 'Redis', 'Nginx',
      'Prisma', 'Vite', 'Rust', 'Zig', 'Svelte', 'Astro', 'Bun', 'Elixir', 'Ruby', 'Swift',
      'Terraform', 'Kafka', 'Grafana', 'Ansible', 'Helm', 'Puppet', 'Rollup', 'Babel', 'Jest',
      'Cypress', 'Storybook', 'Figma'];
    topics.forEach((topic, i) => {
      store.upsert({ text: `Has shipped production work with ${topic}`, section: 'Who', confidence: 0.5 + i / 100 });
    });
    const before = store.facts().length;
    const evicted = store.prune(200);
    assert.ok(evicted.length > 0, 'something should have been evicted');
    assert.ok(store.tokens() <= 200, `still over budget: ${store.tokens()}`);
    assert.equal(store.facts().length, before - evicted.length);
    const survivorConfidences = store.facts().map((f) => f.confidence);
    const evictedConfidences = evicted.map((f) => f.confidence);
    assert.ok(Math.min(...survivorConfidences) >= Math.max(...evictedConfidences) - 0.001,
      'survivors must all outrank everything evicted');
  });

  test('a pinned fact is never evicted, however tight the budget', () => {
    const store = newStore();
    store.upsert({ text: 'Speaks Spanish as a first language', section: 'Who' });
    ['Docker', 'Redis', 'Nginx', 'Prisma', 'Vite', 'Rust', 'Svelte', 'Astro', 'Bun', 'Kafka']
      .forEach((topic) => store.upsert({ text: `Has shipped production work with ${topic}`, section: 'Who' }));
    const pinned = store.find('Speaks Spanish')[0];
    store.setPinned(pinned.id, true);
    store.prune(60);
    assert.ok(store.find('Speaks Spanish').length === 1, 'pinned fact was evicted');
  });

  test('an empty store prunes to nothing without looping', () => {
    const store = newStore();
    assert.deepEqual(store.prune(0), []);
  });

  test('more than 500 facts are still pruned all the way to the ceiling', () => {
    const store = newStore();
    const now = new Date().toISOString();
    for (let i = 0; i < 600; i++) {
      const id = `fact-${i}`;
      store.index.facts[id] = {
        text: `Independent remembered item number ${i}`,
        section: 'Who', confidence: 0.5, seen: 1, sessions: [],
        first: now, last: now, pinned: false,
      };
      store.order.push(id);
    }
    const evicted = store.prune(0);
    assert.equal(evicted.length, 600);
    assert.equal(store.tokens(), 0);
    assert.equal(store.facts().length, 0);
  });

  test('automatic pruning does not create a deliberate-deletion tombstone', () => {
    const store = newStore();
    const { id } = store.upsert({ text: 'A low scoring remembered item', section: 'Who' });
    store.prune(0);
    assert.equal(store.index.tombstones[id], undefined);
  });
});

describe('semantic index merge invariants', () => {
  const fact = (overrides = {}) => ({
    text: 'Prefers short answers', section: 'Who', kind: 'fact', source: 'capture',
    confidence: 0.8, seen: 1, sessions: ['s1'], first: '2026-01-01T00:00:00.000Z',
    last: '2026-01-01T00:00:00.000Z', pinned: false, dormant: false, evidence: null,
    ...overrides,
  });
  const index = (facts, tombstones = {}, overrides = {}) => ({
    version: 2, facts, pending: {}, tombstones, updated: '2026-01-01T00:00:00.000Z', ...overrides,
  });

  test('a reinforcement survives automatic pruning, but not an explicit forget', () => {
    const baseFact = fact();
    const base = index({ f: baseFact });
    const reinforced = index({ f: fact({ seen: 2, sessions: ['s1', 's2'], last: '2026-02-01T00:00:00.000Z' }) });
    const pruned = index({});
    assert.ok(mergeIndex(base, pruned, reinforced).index.facts.f,
      'automatic pruning erased a fact reinforced on the other machine');

    const forgotten = index({}, { f: { at: '2026-02-02T00:00:00.000Z', reason: 'user requested' } });
    const merged = mergeIndex(base, forgotten, reinforced).index;
    assert.equal(merged.facts.f, undefined);
    assert.ok(merged.tombstones.f, 'the deliberate forget must remain durable');
  });

  test('an unpin and manual section move beat a stale reinforced copy', () => {
    const baseFact = fact({ pinned: true });
    const base = index({ f: baseFact });
    const edited = index({ f: fact({ pinned: false, section: 'Preferences' }) });
    const reinforced = index({ f: fact({ pinned: true, seen: 2, last: '2026-02-01T00:00:00.000Z' }) });
    const merged = mergeIndex(base, edited, reinforced).index.facts.f;
    assert.equal(merged.pinned, false);
    assert.equal(merged.section, 'Preferences');
  });

  test('awake wins over dormant with a coherent section in either operand order', () => {
    const awake = fact({ section: 'Preferences' });
    const dormant = fact({ section: 'Dormant', dormant: true, homeSection: 'Preferences' });
    const base = index({ f: awake });
    for (const [ours, theirs] of [[dormant, awake], [awake, dormant]]) {
      const merged = mergeIndex(base, index({ f: ours }), index({ f: theirs })).index.facts.f;
      assert.equal(merged.dormant, false);
      assert.equal(merged.section, 'Preferences');
    }
  });
});

describe('scoring', () => {
  test('recent beats old, all else equal', () => {
    const store = newStore();
    const now = Date.now();
    const fresh = { confidence: 0.8, seen: 1, last: new Date(now).toISOString(), source: 'capture' };
    const old = { confidence: 0.8, seen: 1, last: new Date(now - 180 * 86400000).toISOString(), source: 'capture' };
    assert.ok(store.score(fresh, now) > store.score(old, now));
  });

  test('repeated beats mentioned-once', () => {
    const store = newStore();
    const now = Date.now();
    const base = { confidence: 0.8, last: new Date(now).toISOString(), source: 'capture' };
    assert.ok(store.score({ ...base, seen: 6 }, now) > store.score({ ...base, seen: 1 }, now));
  });

  test('what you typed on purpose beats what was inferred', () => {
    const store = newStore();
    const now = Date.now();
    const base = { confidence: 0.8, seen: 1, last: new Date(now).toISOString() };
    assert.ok(store.score({ ...base, source: 'manual' }, now) > store.score({ ...base, source: 'capture' }, now));
  });
});

describe('the full harvest, end to end', () => {
  test('an explicit statement lands immediately; a soft one waits', () => {
    const config = loadConfig();
    appendPrompt('sess-1', { prompt: 'recuerda que trabajo en español siempre', cwd: sandbox, agent: 'test' });
    appendPrompt('sess-1', { prompt: 'prefiero respuestas cortas', cwd: sandbox, agent: 'test' });
    appendPrompt('sess-1', { prompt: 'arregla el bug del login por favor', cwd: sandbox, agent: 'test' });

    const report = harvestSession('sess-1', { config });
    assert.equal(report.prompts, 3);
    assert.ok(report.added.length >= 1, 'the explicit directive should be stored');
    assert.ok(report.staged.length >= 1, 'the soft preference should be staged');

    const identity = openIdentity(config);
    const texts = identity.facts().map((f) => f.text.toLowerCase());
    assert.ok(texts.some((t) => t.includes('español')), `expected the directive, got: ${texts.join(' | ')}`);
    assert.ok(!texts.some((t) => t.includes('bug')), 'a task must never become a memory');
  });

  test('the same soft preference in a second session gets promoted', () => {
    const config = loadConfig();
    appendPrompt('sess-a', { prompt: 'prefiero respuestas cortas', cwd: sandbox, agent: 'test' });
    harvestSession('sess-a', { config });
    assert.equal(openIdentity(config).facts().length, 0);

    appendPrompt('sess-b', { prompt: 'prefiero respuestas cortas', cwd: sandbox, agent: 'test' });
    harvestSession('sess-b', { config });
    const facts = openIdentity(config).facts();
    assert.equal(facts.length, 1);
    assert.match(facts[0].text.toLowerCase(), /respuestas cortas/);
  });

  test('a credential in a prompt never reaches disk', () => {
    const config = loadConfig();
    appendPrompt('sess-secret', { prompt: 'recuerda que mi token es ghp_abcdefghijklmnopqrstuvwxyz1234', cwd: sandbox, agent: 'test' });
    harvestSession('sess-secret', { config });

    const disk = fs.readdirSync(sandbox, { recursive: true })
      .filter((f) => typeof f === 'string' && /\.(md|json|jsonl)$/.test(f))
      .map((f) => fs.readFileSync(path.join(sandbox, f), 'utf8'))
      .join('\n');
    assert.ok(!disk.includes('ghp_abcdefghijklmnopqrstuvwxyz1234'), 'the token leaked onto disk');
  });

  test('the session buffer is deleted once harvested', () => {
    const config = loadConfig();
    appendPrompt('sess-x', { prompt: 'recuerda que uso pnpm', cwd: sandbox, agent: 'test' });
    assert.ok(fs.existsSync(path.join(sandbox, 'sessions', 'sess-x.jsonl')));
    harvestSession('sess-x', { config });
    assert.ok(!fs.existsSync(path.join(sandbox, 'sessions', 'sess-x.jsonl')), 'raw prompts must not linger');
  });

  test('harvesting an empty session is a no-op, not a crash', () => {
    assert.doesNotThrow(() => harvestSession('does-not-exist', { config: loadConfig() }));
  });
});

describe('compiled context', () => {
  test('is empty when nothing is known', () => {
    const result = compileContext({ cwd: sandbox });
    assert.equal(result.empty, true);
    assert.equal(result.text, '');
  });

  test('reads as factual statements, never as commands', () => {
    const store = openIdentity();
    store.upsert({ text: 'Prefers short direct answers', section: 'Preferences', source: 'manual' });
    store.save();
    const { text } = compileContext({ cwd: sandbox });
    assert.match(text, /Prefers short direct answers/);
    assert.ok(!/YOU MUST|<system>|SYSTEM:/i.test(text), 'must not look like an injected system command');
  });

  test('stays under the hook output cap even with a huge memory file', () => {
    const store = openIdentity();
    for (let i = 0; i < 400; i++) {
      store.upsert({ text: `Owns internal service number ${i} codenamed ${'abcdefghij'[i % 10]}${i} in the platform group`, section: 'Who' });
    }
    store.save();
    const { text } = compileContext({ cwd: sandbox });
    assert.ok(text.length < 9200, `context was ${text.length} chars, over the hook limit`);
  });
});

describe('regression: promotion must carry its own history', () => {
  test('a promoted fact reports the sessions that earned it', () => {
    const store = openIdentity();
    store.stage({ text: 'Prefiere trabajar de noche', section: 'Preferences', kind: 'preference', confidence: 0.7, sessionId: 's1', threshold: 2 });
    const promoted = store.stage({ text: 'Prefiere trabajar de noche', section: 'Preferences', kind: 'preference', confidence: 0.7, sessionId: 's2', threshold: 2 });
    assert.equal(promoted.action, 'added');
    const fact = store.get(promoted.id);
    assert.equal(fact.sessions.length, 2, '`wife why` would otherwise contradict itself');
    assert.equal(fact.seen, 2);
  });
});
