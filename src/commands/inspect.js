import { spawnSync } from 'node:child_process';
import { loadConfig } from '../core/config.js';
import { openIdentity, openProject, listProjects } from '../core/memory.js';
import { compileContext } from '../core/compile.js';
import { readJournal } from '../core/journal.js';
import { listSessions } from '../core/session.js';
import { claudeStatus } from '../agents/claude.js';
import { codexStatus } from '../agents/codex.js';
import { cursorStatus } from '../agents/cursor.js';
import { geminiStatus } from '../agents/gemini.js';
import { paths, homeRelative } from '../util/paths.js';
import { estimateTokens } from '../util/text.js';
import { exists } from '../util/fsx.js';
import { continuityStatus } from './continuity.js';
import { say, c, heading, bullet, meter, info, warn, ok, plural } from '../util/out.js';

/**
 * `wife show` — exactly what the agent will be given, nothing hidden.
 * If you cannot see the context, you cannot trust it.
 */
export function cmdShow(args) {
  const config = loadConfig();

  if (args.raw) {
    const { text } = compileContext({ cwd: process.cwd(), config });
    process.stdout.write(text || '');
    return 0;
  }

  const identity = openIdentity(config);
  const project = openProject(process.cwd(), config);

  renderStore('Identity', identity, config.budget.identity, args);
  renderStore(`Project · ${project.name}`, project.store, config.budget.project, args);

  const { tokens, empty } = compileContext({ cwd: process.cwd(), config });
  heading('Injected at session start');
  if (empty) {
    say(c.gray('  nothing yet — wife has not learned anything about you'));
  } else {
    const total = config.budget.identity + config.budget.project;
    say(`  ${meter(tokens, total)}`);
    say(c.gray(`  see the literal text with: wife show --raw`));
  }
  return 0;
}

function renderStore(title, store, budget, args) {
  const facts = store.activeFacts();
  const dormant = store.dormantFacts();
  heading(`${title} ${c.gray(`(${facts.length} fact${facts.length === 1 ? '' : 's'})`)}`);
  if (!facts.length) {
    say(c.gray('  empty'));
  } else {
    for (const section of store.sectionNames()) {
      const items = facts.filter((f) => f.section === section);
      if (!items.length) continue;
      say(`  ${c.bold(section)}`);
      for (const f of items) {
        const score = store.score(f);
        const meta = args.verbose
          ? `${f.pinned ? '📌 ' : ''}${Number.isFinite(score) ? score.toFixed(2) : 'pinned'} · seen ${f.seen || 1}x · ${f.source}`
          : f.pinned ? '📌' : '';
        bullet(f.text, meta);
      }
    }
  }
  say(`  ${meter(store.tokens(), budget)}`);
  if (dormant.length) {
    say(c.gray(`  ${plural(dormant.length, 'fact')} dormant — not sent to the agent (\`wife review\` to act)`));
  }

  const pending = store.pending();
  if (pending.length && args.verbose) {
    say(`  ${c.gray('waiting for a second sighting:')}`);
    for (const p of pending.slice(0, 10)) bullet(c.gray(p.text), `${p.sessions?.length || 0}/${2}`);
  } else if (pending.length) {
    say(c.gray(`  ${pending.length} candidate(s) waiting for a second sighting (--verbose to list)`));
  }
}

/** `wife status` — is this thing actually wired up? */
export function cmdStatus() {
  const config = loadConfig();
  const identity = openIdentity(config);
  const project = openProject(process.cwd(), config);
  const claude = claudeStatus();
  const codex = codexStatus();
  const sessions = listSessions();

  heading('wife');
  say(`  memory      ${homeRelative(paths.home())}`);
  say(`  identity    ${plural(identity.activeFacts().length, 'fact')} · ${identity.tokens()}/${config.budget.identity} tokens`);
  say(`  project     ${project.name} · ${plural(project.store.activeFacts().length, 'fact')} · ${project.store.tokens()}/${config.budget.project} tokens`);
  say(`  root        ${homeRelative(project.root)}`);

  const continuity = continuityStatus();
  heading('Project continuity');
  if (continuity.checkpoint) {
    say(`  checkpoint  ${continuity.checkpoint.goal || 'in progress'} · updated ${continuity.checkpoint.updatedAt || 'unknown'}`);
    if (continuity.checkpoint.next.length) say(c.gray(`  next        ${continuity.checkpoint.next.join(' · ')}`));
  } else {
    say(c.gray('  checkpoint  none — use `wife checkpoint set --goal "…"`'));
  }
  say(`  evidence    ${continuity.evidenceCount} recorded receipt(s)`);
  if (continuity.snapshot.available) {
    say(`  repository  ${continuity.snapshot.branch || '(detached)'} · ${continuity.snapshot.commit || 'no commit'} · ${continuity.snapshot.dirty ? `${continuity.snapshot.dirtyFiles.length} changed file(s)` : 'clean'}`);
  } else {
    say(c.gray('  repository  Git not detected'));
  }

  heading('Agents');
  if (claude.invalid) warn(`Claude Code — invalid settings JSON at ${homeRelative(claude.file)}. Fix it before attach/detach.`);
  else if (claude.attached) ok(`Claude Code — ${claude.events.join(', ')} ${c.gray(homeRelative(claude.file))}`);
  else warn(`Claude Code — not attached. Run: wife attach claude`);
  if (codex.invalid) warn(`Codex — invalid hooks JSON at ${homeRelative(codex.file)}. Fix it before attach/detach.`);
  else if (codex.attached) ok(`Codex — ${codex.events.join(', ')} ${c.gray(homeRelative(codex.file))}`);
  else if (codex.blockOnly) warn('Codex — AGENTS.md block only, no hooks. Run: wife attach codex');
  else warn('Codex — not attached. Run: wife attach codex');

  const cursor = cursorStatus();
  if (cursor.invalid) warn(`Cursor — invalid hooks JSON at ${homeRelative(cursor.file)}. Fix it before attach/detach.`);
  else if (cursor.attached) ok(`Cursor — ${cursor.events.join(', ')} ${c.gray(homeRelative(cursor.file))}`);
  else warn('Cursor — not attached. Run: wife attach cursor');

  const gemini = geminiStatus();
  if (gemini.attached) ok(`Gemini CLI — ${c.gray('injection only')} ${c.gray(homeRelative(gemini.file))}`);
  else warn('Gemini CLI — not attached. Run: wife attach gemini');

  heading('Buffers');
  if (!sessions.length) say(c.gray('  no unharvested sessions'));
  else {
    say(`  ${plural(sessions.length, 'session buffer')} waiting to be harvested`);
    say(c.gray('  they are picked up automatically at the next session start, or run: wife harvest'));
  }

  const projects = listProjects();
  if (projects.length > 1) {
    heading(`Known projects (${projects.length})`);
    for (const p of projects.slice(0, 8)) {
      say(`  ${c.bold(p.name.padEnd(22))} ${c.gray(homeRelative(p.root))}`);
    }
  }
  return 0;
}

/** `wife journal` — the audit trail, newest first. */
export function cmdJournal(args) {
  const limit = Number(args.limit || args.n || 30);
  const all = readJournal();
  if (!all.length) {
    info('Journal is empty.');
    return 0;
  }
  const filtered = args.event ? all.filter((e) => e.event === args.event) : all;
  const slice = filtered.slice(-limit).reverse();

  heading(`Journal ${c.gray(`(${filtered.length} entries, showing ${slice.length})`)}`);
  const colorFor = {
    added: c.green, reinforced: c.cyan, superseded: c.yellow,
    forgotten: c.red, pruned: c.gray, adopted: c.blue, harvest: c.magenta,
    pinned: c.magenta, unpinned: c.gray,
  };
  for (const e of slice) {
    const tint = colorFor[e.event] || c.gray;
    const when = String(e.at || '').slice(0, 16).replace('T', ' ');
    const detail = e.event === 'harvest'
      ? `${e.prompts} prompts → +${e.added} added, ${e.reinforced} confirmed, ${e.staged} staged`
      : `${e.text || ''}${e.reason ? c.gray(` — ${e.reason}`) : ''}`;
    say(`  ${c.gray(when)} ${tint(String(e.event).padEnd(12))} ${detail}`);
  }
  return 0;
}

/** `wife edit` — open the memory file in $EDITOR. Hand edits are first-class. */
export function cmdEdit(args) {
  const config = loadConfig();
  const file = args.project ? openProject(process.cwd(), config).store.mdPath : paths.identity();
  if (!exists(file)) {
    (args.project ? openProject(process.cwd(), config).store : openIdentity(config)).save({ force: true });
  }
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) {
    info(`No $EDITOR set. The file is at:\n  ${file}`);
    return 0;
  }
  const result = spawnSync(editor, [file], { stdio: 'inherit', shell: true });
  if (result.error) {
    warn(`Could not launch ${editor}. The file is at:\n  ${file}`);
    return 1;
  }
  const store = args.project ? openProject(process.cwd(), config).store : openIdentity(config);
  store.save();
  ok(`Saved. ${store.facts().length} facts, ${estimateTokens(store.render())} tokens on disk.`);
  return 0;
}
