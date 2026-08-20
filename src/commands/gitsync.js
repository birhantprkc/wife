import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths, homeRelative } from '../util/paths.js';
import { writeJSON, readText, writeAtomic, exists, removeFile } from '../util/fsx.js';
import { contradicts, factId, refines } from '../util/text.js';
import { mergeIndex, mergeLedger, mergeJournal } from '../core/merge.js';
import { loadConfig } from '../core/config.js';
import { openIdentity, listProjects } from '../core/memory.js';
import { Store } from '../core/store.js';
import { say, ok, warn, fail, info, c, heading, blank, plural } from '../util/out.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '..', '..', 'bin', 'wife.js');

function git(args, { cwd = paths.home(), quiet = true } = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (!quiet && res.stderr) process.stderr.write(res.stderr);
  return { code: res.status, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
}

function isRepo() {
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.out) return false;
  // WIFE_HOME can live below an unrelated repository (a common setup when a
  // user's home directory itself is versioned). Never let Git walk upward and
  // mistake that ancestor for Wife's private sync repository.
  return path.resolve(top.out).toLowerCase() === path.resolve(paths.home()).toLowerCase();
}

const RULES_BEGIN = '# wife:sync-rules:begin';
const RULES_END = '# wife:sync-rules:end';

/**
 * Preserve user-owned git files, but keep Wife's rules in one managed block at
 * the end. Git resolves both ignore negations and attribute overrides by the
 * last matching rule, so merely finding the same text earlier is not enough.
 */
function ensureTrailingRules(file, required) {
  const original = (readText(file, '') || '').replace(/\r\n/g, '\n');
  const source = original.split('\n');
  const kept = [];

  for (let i = 0; i < source.length; i++) {
    if (source[i].trim() !== RULES_BEGIN) {
      kept.push(source[i]);
      continue;
    }
    const end = source.findIndex((line, at) => at > i && line.trim() === RULES_END);
    if (end < 0) {
      // An incomplete marker may be user text; never discard everything after it.
      kept.push(source[i]);
      continue;
    }
    i = end;
  }

  while (kept.length && !kept.at(-1).trim()) kept.pop();
  const next = [
    ...kept,
    ...(kept.length ? [''] : []),
    RULES_BEGIN,
    ...required,
    RULES_END,
    '',
  ].join('\n');
  if (next === original) return false;
  writeAtomic(file, next);
  return true;
}

/**
 * Register a custom merge driver.
 *
 * Without this, git resolves a conflict in identity.index.json by picking a
 * side, and one machine's week of learning disappears. With it, git hands both
 * versions plus their common ancestor to `wife merge-driver`, which merges them
 * by meaning and writes the result back.
 *
 * The driver is registered in .git/config rather than committed, because it
 * points at this machine's node binary and this checkout.
 */
function installDriver() {
  const home = paths.home();
  git(['config', 'merge.wife.name', 'Wife semantic memory merge']);
  // %O/%A/%B are temporary filenames. %P is the logical repo pathname and is
  // therefore the only reliable way for the driver to distinguish an index,
  // the cross-project ledger and the JSONL journal.
  git(['config', 'merge.wife.driver', `"${process.execPath}" "${BIN}" merge-driver %O %A %B %P`]);

  // Markdown is rebuilt from the merged index, so its merge only has to not
  // fail. `merge=ours` looks like it would do that but is NOT a git built-in —
  // without this definition every sync stopped on a markdown conflict and never
  // reached the semantic merge at all. `driver = true` succeeds and leaves %A
  // untouched, which is exactly the no-op wanted here.
  git(['config', 'merge.wife-md.name', 'Keep local markdown; it is regenerated after the merge']);
  git(['config', 'merge.wife-md.driver', 'true']);

  const attrs = path.join(home, '.gitattributes');
  ensureTrailingRules(attrs, [
    '# Memory is merged by meaning, not by line. See `wife merge-driver`.',
    '*.index.json    merge=wife',
    'cross-project.json merge=wife',
    'journal.jsonl   merge=wife',
    '# Markdown is regenerated from the merged index, so either side will do.',
    '*.md            merge=wife-md',
  ]);

  // Sessions are machine-local scratch and must never travel.
  const ignore = path.join(home, '.gitignore');
  ensureTrailingRules(ignore, ['sessions/', '*.corrupt.*', '.state.lock', '.DS_Store']);
}

const PRIVATE_GIT_PATHS = ['sessions', '.state.lock'];

function trackedPrivatePaths() {
  return git(['ls-files', '--', ...PRIVATE_GIT_PATHS]).out.split('\n').filter(Boolean);
}

function privateHistory() {
  if (git(['rev-parse', '--verify', 'HEAD']).code !== 0) return '';
  return git(['log', '--all', '--format=%H', '--', ...PRIVATE_GIT_PATHS]).out;
}

/**
 * Raw sessions and the live lock are local-only. A newly staged path can be
 * removed from the index without touching its working copy. Once one reached a
 * commit, however, deleting it in a later commit would still upload the secret
 * Git object, so sync must stop until the user scrubs that history explicitly.
 */
function protectPrivateState() {
  if (privateHistory()) {
    fail('Sync stopped: sessions/ or .state.lock exists in Git history.');
    say(c.gray('  No data was deleted or pushed. Remove those paths from Git history, then retry.'));
    return false;
  }

  const tracked = trackedPrivatePaths();
  if (!tracked.length) return true;
  const removed = git(['rm', '--cached', '-r', '-f', '--ignore-unmatch', '--', ...PRIVATE_GIT_PATHS]);
  if (removed.code !== 0 || trackedPrivatePaths().length) {
    fail('Could not remove private session state from Git tracking.');
    say(c.gray('  Sync stopped before any commit or push; the local files were left in place.'));
    return false;
  }
  warn(`Kept ${plural(tracked.length, 'private file')} locally and removed it from Git tracking.`);
  return true;
}

function unresolvedMerge() {
  return git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code === 0 ||
    Boolean(git(['diff', '--name-only', '--diff-filter=U']).out);
}

function projectStore(meta, config) {
  return new Store({
    mdPath: paths.projectMd(meta.key),
    indexPath: paths.projectIndex(meta.key),
    sections: config.projectSections,
    title: `Wife · ${meta.name}`,
    header: null,
    halfLife: config.halfLife.project,
    scope: `project:${meta.key}`,
    denyPatterns: config.denyPatterns,
  });
}

/** Persist hand edits (and their tombstones) before git snapshots the sidecars. */
function persistMarkdownEdits(config) {
  openIdentity(config).save();
  for (const meta of listProjects()) projectStore(meta, config).load().save();
}

/**
 * After any merge, rebuild every markdown file from its merged index.
 *
 * The markdown must be DELETED first, and that detail is load-bearing.
 * `.gitattributes` marks .md as `merge=ours`, so after a merge the file still
 * holds this machine's pre-merge list, while the index holds the merged truth.
 * Store.load treats markdown as authoritative — which is right everywhere
 * else — so simply opening the store here re-adopted every fact the other
 * machine had deliberately deleted. Removing the file first makes the index
 * authoritative for exactly this one rebuild, which is the behaviour
 * Store already has for a missing file.
 */
function regenerateMarkdown(config = loadConfig()) {
  let n = 0;
  if (exists(paths.identity()) && !removeFile(paths.identity())) {
    throw new Error(`could not remove stale markdown: ${paths.identity()}`);
  }
  const identity = openIdentity(config);
  reconcile(identity);
  identity.save({ force: true });
  n++;
  for (const meta of listProjects()) {
    if (exists(paths.projectMd(meta.key)) && !removeFile(paths.projectMd(meta.key))) {
      throw new Error(`could not remove stale markdown: ${paths.projectMd(meta.key)}`);
    }
    const store = projectStore(meta, config).load();
    reconcile(store);
    store.save({ force: true });
    n++;
  }
  return n;
}

/**
 * Resolve contradictions that only became visible once two machines were merged.
 *
 * The per-fact merge unions facts by id, so a statement and its negation arrive
 * as two separate entries and would otherwise sit side by side. These are the
 * same rules `Store.upsert` applies locally; the newer statement wins, because
 * across machines "more recent" is the only ordering that means anything.
 */
function reconcile(store) {
  const facts = store.facts();
  const dropped = [];
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const a = facts[i];
      const b = facts[j];
      if (dropped.includes(a.id) || dropped.includes(b.id)) continue;
      const clash = contradicts(a.text, b.text);
      const refinement = refines(a.text, b.text);
      if (!clash && refinement === 0) continue;
      let loser;
      if (clash) loser = Date.parse(a.last || 0) >= Date.parse(b.last || 0) ? b : a;
      else loser = refinement === 1 ? a : b;   // the less specific one loses
      if (loser.pinned) continue;
      store.remove(loser.id, clash ? 'contradicted by a newer statement on another machine' : 'restated more precisely on another machine');
      dropped.push(loser.id);
    }
  }
  return dropped.length;
}

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const INDEX_VERSION = 2;
const FACT_ID = /^[a-f0-9]{10}$/;

const validDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validText = (value) => typeof value === 'string' && Boolean(value.trim());
const validStringList = (value) => Array.isArray(value) && value.every((item) => validText(item));

function validateFact(id, fact, label) {
  if (!FACT_ID.test(id) || !isRecord(fact) || !validText(fact.text) || factId(fact.text) !== id) {
    throw new Error(`${label} contains an invalid fact ${id}`);
  }
  if (!validText(fact.section) || !validText(fact.kind) || !validText(fact.source)) {
    throw new Error(`${label} fact ${id} has invalid classification metadata`);
  }
  if (!Number.isFinite(fact.confidence) || fact.confidence < 0 || fact.confidence > 1 ||
      !Number.isInteger(fact.seen) || fact.seen < 1) {
    throw new Error(`${label} fact ${id} has invalid scoring metadata`);
  }
  if (!validStringList(fact.sessions) || !validDate(fact.first) || !validDate(fact.last) ||
      typeof fact.pinned !== 'boolean') {
    throw new Error(`${label} fact ${id} has invalid provenance metadata`);
  }
  if (fact.dormant !== undefined && typeof fact.dormant !== 'boolean') {
    throw new Error(`${label} fact ${id} has an invalid dormant flag`);
  }
  if ((fact.dormant === true) !== (fact.section === 'Dormant')) {
    throw new Error(`${label} fact ${id} has an incoherent dormant section`);
  }
  if (fact.homeSection !== undefined && !validText(fact.homeSection)) {
    throw new Error(`${label} fact ${id} has an invalid home section`);
  }
  if (fact.evidence !== undefined && fact.evidence !== null && typeof fact.evidence !== 'string') {
    throw new Error(`${label} fact ${id} has invalid evidence`);
  }
  if (fact.supersedes !== undefined && (!validStringList(fact.supersedes) ||
      fact.supersedes.some((previous) => !FACT_ID.test(previous)))) {
    throw new Error(`${label} fact ${id} has invalid supersedes metadata`);
  }
}

function validatePending(id, entry, label) {
  if (!FACT_ID.test(id) || !isRecord(entry) || !validText(entry.text) || factId(entry.text) !== id ||
      !validText(entry.section) || !validText(entry.kind)) {
    throw new Error(`${label} contains an invalid pending candidate ${id}`);
  }
  if (!Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1 ||
      !validStringList(entry.sessions) || !validDate(entry.first) || !validDate(entry.last)) {
    throw new Error(`${label} pending candidate ${id} has invalid metadata`);
  }
  if (entry.evidence !== undefined && entry.evidence !== null && typeof entry.evidence !== 'string') {
    throw new Error(`${label} pending candidate ${id} has invalid evidence`);
  }
}

function readJSONStrict(file, label, { allowEmpty = false } = {}) {
  const raw = readText(file, null);
  if (raw === null) throw new Error(`${label} could not be read`);
  if (!raw.trim()) {
    if (allowEmpty) return null;
    throw new Error(`${label} is empty`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function readJSONLinesStrict(file, label) {
  const raw = readText(file, null);
  if (raw === null) throw new Error(`${label} could not be read`);
  const records = [];
  let lineNo = 0;
  for (const line of raw.split(/\r?\n/)) {
    lineNo++;
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} has invalid JSON on line ${lineNo}: ${error.message}`);
    }
    if (!isRecord(entry)) throw new Error(`${label} line ${lineNo} is not an object`);
    records.push(entry);
  }
  return records;
}

function validateIndex(index, label, allowNull = false) {
  if (index === null && allowNull) return;
  if (!isRecord(index) || !isRecord(index.facts)) throw new Error(`${label} has no facts object`);
  if (!Number.isInteger(index.version) || index.version < 1 || index.version > INDEX_VERSION) {
    throw new Error(`${label} has an unsupported index version`);
  }
  if (!isRecord(index.pending)) throw new Error(`${label} has an invalid pending object`);
  if (index.version >= 2 && !isRecord(index.tombstones)) throw new Error(`${label} has an invalid tombstones object`);
  if (index.tombstones !== undefined && !isRecord(index.tombstones)) throw new Error(`${label} has an invalid tombstones object`);
  if (index.updated !== undefined && index.updated !== null && !validDate(index.updated)) {
    throw new Error(`${label} has an invalid updated timestamp`);
  }
  for (const [id, fact] of Object.entries(index.facts)) {
    validateFact(id, fact, label);
    if (Object.hasOwn(index.tombstones || {}, id)) throw new Error(`${label} contains both a fact and tombstone for ${id}`);
  }
  for (const [id, entry] of Object.entries(index.pending)) validatePending(id, entry, label);
  for (const [id, tombstone] of Object.entries(index.tombstones || {})) {
    if (!FACT_ID.test(id) || !isRecord(tombstone) ||
        (tombstone.at !== null && !validDate(tombstone.at)) || !validText(tombstone.reason)) {
      throw new Error(`${label} contains an invalid tombstone ${id}`);
    }
  }
}

function validateLedger(ledger, label, allowNull = false) {
  if (ledger === null && allowNull) return;
  if (!isRecord(ledger) || !isRecord(ledger.facts)) throw new Error(`${label} has no facts object`);
  for (const [key, entry] of Object.entries(ledger.facts)) {
    if (!isRecord(entry) || typeof entry.text !== 'string' || !Array.isArray(entry.projects)) {
      throw new Error(`${label} contains an invalid ledger entry ${key}`);
    }
  }
}

/**
 * `wife merge-driver <base> <ours> <theirs> <logical-path>` — invoked by git.
 *
 * Must exit 0 on success and leave the merged result in the `ours` path.
 * A malformed input must stop the merge. Treating unreadable data as an empty
 * index turns corruption into a valid-looking deletion and lets the next push
 * erase good memory on every other machine.
 */
export function cmdMergeDriver(args) {
  const [basePath, oursPath, theirsPath, logicalPath] = args._;
  if (!basePath || !oursPath || !theirsPath) {
    process.stderr.write('wife merge-driver: called without file paths\n');
    return 1;
  }

  try {
    const logical = String(logicalPath || oursPath).replace(/\\/g, '/');
    if (logical.endsWith('journal.jsonl')) {
      const merged = mergeJournal(readJSONLinesStrict(oursPath, 'current journal'), readJSONLinesStrict(theirsPath, 'incoming journal'));
      writeAtomic(oursPath, merged.map((l) => JSON.stringify(l)).join('\n') + '\n');
      return 0;
    }
    if (logical.endsWith('cross-project.json')) {
      const base = readJSONStrict(basePath, 'base ledger', { allowEmpty: true });
      const ours = readJSONStrict(oursPath, 'current ledger');
      const theirs = readJSONStrict(theirsPath, 'incoming ledger');
      validateLedger(base, 'base ledger', true);
      validateLedger(ours, 'current ledger');
      validateLedger(theirs, 'incoming ledger');
      writeJSON(oursPath, mergeLedger(base, ours, theirs));
      return 0;
    }
    const base = readJSONStrict(basePath, 'base index', { allowEmpty: true });
    const ours = readJSONStrict(oursPath, 'current index');
    const theirs = readJSONStrict(theirsPath, 'incoming index');
    validateIndex(base, 'base index', true);
    validateIndex(ours, 'current index');
    validateIndex(theirs, 'incoming index');
    const { index } = mergeIndex(base, ours, theirs);
    writeJSON(oursPath, index);
    return 0;
  } catch (error) {
    process.stderr.write(`wife merge-driver: ${error.message} — merge stopped; local memory was not replaced\n`);
    return 1;
  }
}

/**
 * `wife sync` — carry your memory between machines.
 *
 * First run wires ~/.wife up as a git repo with the semantic merge driver.
 * Every run after that is commit, pull, merge, push.
 */
export function cmdSync(args) {
  const home = paths.home();
  const config = loadConfig();

  if (args._[0] === 'setup' || args.remote) {
    const remote = args.remote || args._[1];
    if (!remote) {
      fail('Which repo? Try: wife sync setup git@github.com:you/wife-memory.git');
      say(c.gray('  Use a private repo. Your memory is not something to publish.'));
      return 1;
    }
    if (!isRepo()) {
      const init = git(['init', '-b', 'main']);
      if (init.code !== 0) { fail(`git init failed: ${init.err}`); return 1; }
    }
    installDriver();
    git(['remote', 'remove', 'origin']);
    const add = git(['remote', 'add', 'origin', remote]);
    if (add.code !== 0) { fail(`could not add the remote: ${add.err}`); return 1; }

    ok(`${homeRelative(home)} is now a git repo`);
    say(c.gray(`  remote      ${remote}`));
    say(c.gray('  merge       facts are merged by meaning, not by line'));
    say(c.gray('  ignored     sessions/ never leaves this machine'));
    blank();
    say(c.bold('Next:'));
    say('  wife sync                    push this machine up');
    say(c.gray('  On your other machine, run the same setup with the same remote.'));
    return 0;
  }

  if (!isRepo()) {
    info('Not set up for sync yet.');
    say(c.gray('  wife sync setup <git-remote-url>   (use a private repo)'));
    return 0;
  }
  if (unresolvedMerge()) {
    fail('An unfinished Git merge already exists; sync did not touch memory files.');
    say(c.gray(`  Resolve it or run: git -C ${homeRelative(home)} merge --abort`));
    return 1;
  }
  installDriver(); // repair the driver after a fresh clone or a moved checkout
  if (!protectPrivateState()) return 1;
  persistMarkdownEdits(config);

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out || 'main';
  git(['add', '-A']);
  const staged = git(['diff', '--cached', '--name-only']).out;
  if (staged) {
    git(['-c', 'user.email=wife@localhost', '-c', 'user.name=wife', 'commit', '-m', `memory: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`]);
  }

  const hasRemote = git(['remote', 'get-url', 'origin']).code === 0;
  if (!hasRemote) {
    warn('No remote configured. Run: wife sync setup <url>');
    return 1;
  }

  const fetch = git(['fetch', 'origin', branch]);
  const remoteExists = fetch.code === 0 && git(['rev-parse', `origin/${branch}`]).code === 0;
  // Fetch may have introduced a legacy/compromised remote ref containing raw
  // sessions. Refuse it before merge: an ignore rule cannot undo Git history.
  if (remoteExists && !protectPrivateState()) return 1;

  let merged = false;
  if (remoteExists) {
    const before = git(['rev-parse', 'HEAD']).out;
    const pull = git(['-c', 'user.email=wife@localhost', '-c', 'user.name=wife', 'merge', `origin/${branch}`, '--no-edit', '-m', 'memory: merge']);
    if (pull.code !== 0) {
      const abort = git(['merge', '--abort']);
      fail('The merge did not complete cleanly.');
      say(c.gray(`  ${pull.err.split('\n')[0]}`));
      if (abort.code === 0) {
        say(c.gray('  The partial merge was aborted; your committed local memory is intact.'));
      } else {
        warn(`Git could not abort automatically: ${abort.err.split('\n')[0] || 'inspect the repository status'}`);
        say(c.gray(`  Inspect it with: git -C ${homeRelative(home)} status`));
      }
      return 1;
    }
    merged = git(['rev-parse', 'HEAD']).out !== before;
    if (merged) {
      const files = regenerateMarkdown(config);
      git(['add', '-A']);
      if (git(['diff', '--cached', '--name-only']).out) {
        git(['-c', 'user.email=wife@localhost', '-c', 'user.name=wife', 'commit', '-m', 'memory: rebuild markdown from merged index']);
      }
      ok(`Merged the other machine in · ${plural(files, 'file')} rebuilt`);
    }
  }

  const push = git(['push', '-u', 'origin', branch]);
  if (push.code !== 0) {
    fail(`Push failed: ${push.err.split('\n')[0]}`);
    return 1;
  }

  const identity = openIdentity(config);
  if (!staged && !merged) info('Already up to date.');
  else ok('Synced.');
  say(c.gray(`  ${plural(identity.activeFacts().length, 'fact')} in identity · ${plural(listProjects().length, 'project')} tracked`));
  return 0;
}

/** `wife clone <remote>` — set a new machine up from an existing memory repo. */
export function cmdClone(args) {
  const remote = args._[0];
  if (!remote) {
    fail('Usage: wife clone <git-remote-url>');
    return 1;
  }
  const home = paths.home();
  if (exists(path.join(home, 'identity.md'))) {
    fail(`${homeRelative(home)} already has memory in it.`);
    say(c.gray('  Move it aside first, or use `wife sync setup <url>` to merge this machine into the repo.'));
    return 1;
  }
  const res = spawnSync('git', ['clone', remote, home], { encoding: 'utf8' });
  if (res.status !== 0) {
    fail(`Clone failed: ${(res.stderr || '').split('\n')[0]}`);
    return 1;
  }
  installDriver();
  const config = loadConfig();
  const identity = openIdentity(config);
  ok(`Memory restored to ${homeRelative(home)}`);
  say(c.gray(`  ${plural(identity.activeFacts().length, 'fact')} in identity · ${plural(listProjects().length, 'project')} tracked`));
  blank();
  say(c.bold('Next:'));
  say('  wife attach claude');
  return 0;
}

/** `wife sync status` — where this machine stands relative to the others. */
export function cmdSyncStatus() {
  if (!isRepo()) {
    info('Sync is not set up.');
    say(c.gray('  wife sync setup <git-remote-url>'));
    return 0;
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out || 'main';
  const remote = git(['remote', 'get-url', 'origin']).out || '(none)';
  const dirty = git(['status', '--porcelain']).out;
  git(['fetch', 'origin', branch]);
  const counts = git(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]).out || '0\t0';
  const [ahead, behind] = counts.split(/\s+/).map(Number);

  heading('Sync');
  say(`  remote     ${remote}`);
  say(`  branch     ${branch}`);
  say(`  local      ${dirty ? c.yellow(`${dirty.split('\n').length} uncommitted change(s)`) : c.green('clean')}`);
  say(`  ahead      ${ahead || 0} commit(s) this machine has and the others do not`);
  say(`  behind     ${behind || 0} commit(s) another machine has and this one does not`);
  if (ahead || behind || dirty) say(c.gray('\n  Run `wife sync` to reconcile.'));
  return 0;
}
