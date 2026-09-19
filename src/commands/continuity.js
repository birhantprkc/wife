import { loadConfig } from '../core/config.js';
import { addEvidence, buildProjectContext, projectContinuity, readCheckpoint, readEvidence, saveCheckpoint } from '../core/projectBrain.js';
import { say, ok, fail, info, c, heading, bullet } from '../util/out.js';

function listArg(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value).split(/\r?\n|;\s*/).map((item) => item.trim()).filter(Boolean);
}

export function cmdCheckpoint(args) {
  const action = (args._[0] || 'show').toLowerCase();
  if (action === 'clear' || args.clear) {
    saveCheckpoint(process.cwd(), { goal: '', done: [], next: [], blocked: [] });
    info('Checkpoint cleared.');
    return 0;
  }
  if (action === 'set') {
    const checkpoint = saveCheckpoint(process.cwd(), {
      goal: args.goal,
      done: listArg(args.done),
      next: listArg(args.next),
      blocked: listArg(args.blocked),
    });
    if (!checkpoint) {
      info('Checkpoint cleared.');
      return 0;
    }
    ok(`Checkpoint saved for ${checkpoint.project.name}.`);
    say(c.gray(`  updated ${checkpoint.updatedAt}`));
    if (checkpoint.next.length) say(c.gray(`  next: ${checkpoint.next.join(' · ')}`));
    return 0;
  }
  if (action !== 'show') {
    fail('Usage: wife checkpoint set [--goal "…"] [--done "…; …"] [--next "…; …"] [--blocked "…"]');
    return 1;
  }

  const checkpoint = readCheckpoint(process.cwd());
  if (args.json) {
    say(JSON.stringify(checkpoint || {}, null, 2));
    return 0;
  }
  heading('Continuity checkpoint');
  if (!checkpoint) {
    info('No checkpoint for this project.');
    say(c.gray('  Set one with: wife checkpoint set --goal "..." --next "..."'));
    return 0;
  }
  if (checkpoint.goal) say(`  ${c.bold('goal')}     ${checkpoint.goal}`);
  if (checkpoint.done.length) { say(`  ${c.bold('done')}`); checkpoint.done.forEach((item) => bullet(item)); }
  if (checkpoint.next.length) { say(`  ${c.bold('next')}`); checkpoint.next.forEach((item) => bullet(item)); }
  if (checkpoint.blocked.length) { say(`  ${c.bold('blocked')}`); checkpoint.blocked.forEach((item) => bullet(item)); }
  say(c.gray(`  ${checkpoint.branch || '(detached)'} · ${checkpoint.commit || 'no commit'} · updated ${checkpoint.updatedAt || 'unknown'}`));
  return 0;
}

export function cmdEvidence(args) {
  const action = (args._[0] || 'list').toLowerCase();
  if (action === 'add') {
    try {
      const entry = addEvidence(process.cwd(), {
        kind: args.kind,
        text: args.text,
        source: args.source,
        files: listArg(args.file || args.files),
        status: args.status,
        commit: args.commit,
      });
      ok(`Evidence recorded: ${entry.id} (${entry.kind}/${entry.status}).`);
      return 0;
    } catch (error) {
      fail(error.message);
      return 1;
    }
  }
  if (action !== 'list') {
    fail('Usage: wife evidence add --kind test --text "npm test passed" [--status verified] [--file src/app.js]');
    return 1;
  }
  const entries = readEvidence(process.cwd()).slice(-(Number(args.limit || 20) || 20)).reverse();
  if (args.json) {
    say(JSON.stringify(entries, null, 2));
    return 0;
  }
  heading(`Project evidence (${entries.length})`);
  if (!entries.length) {
    info('No evidence recorded for this project.');
    say(c.gray('  Add an explicit receipt with: wife evidence add --kind test --text "..."'));
    return 0;
  }
  for (const entry of entries) {
    bullet(`[${entry.kind}/${entry.status}] ${entry.text}`, `${entry.id} · ${String(entry.at).slice(0, 16).replace('T', ' ')}`);
  }
  return 0;
}

export function cmdContext(args) {
  const hint = args._.join(' ').trim();
  const config = loadConfig();
  const budget = Number(args.budget || config.budget.context || 1200);
  const result = buildProjectContext({ cwd: process.cwd(), hint, config, budget: Number.isFinite(budget) && budget > 0 ? budget : 1200 });
  if (args.json) {
    say(JSON.stringify({ text: result.text, tokens: result.tokens, checkpoint: result.checkpoint, evidence: result.evidence, snapshot: result.snapshot }, null, 2));
    return 0;
  }
  process.stdout.write(result.text);
  return 0;
}

export function continuityStatus() {
  return projectContinuity(process.cwd());
}
