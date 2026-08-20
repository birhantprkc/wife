import { paths } from '../util/paths.js';
import { appendLine, readLines } from '../util/fsx.js';
import { detectSecret } from './redact.js';

/**
 * Append-only audit log. Every mutation to memory lands here with enough
 * context to answer "where did this come from?" months later, and nothing is
 * ever destroyed by pruning — evicted facts stay recoverable from the journal.
 */
export function record(event) {
  const entry = { at: new Date().toISOString(), ...event };
  // Last-line defence: provenance is useful, but never useful enough to copy a
  // credential into an append-only file. Candidate screening should catch it
  // earlier; this prevents a future caller from turning one bug into a durable
  // journal leak.
  if (detectSecret(JSON.stringify(entry))) return false;
  appendLine(paths.journal(), entry);
  return true;
}

export function readJournal() {
  return readLines(paths.journal());
}

export function findEntries(predicate, limit = 50) {
  const all = readJournal();
  const out = [];
  for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
    if (predicate(all[i])) out.push(all[i]);
  }
  return out;
}
