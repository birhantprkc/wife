import { normalize } from '../util/text.js';

const INDEX_VERSION = 2;
const DORMANT = 'Dormant';

/**
 * Semantic merge, for people who work on more than one machine.
 *
 * The usual advice — push your memory folder to a private repo — works right up
 * to the moment you use two machines in the same week. Then git hands you a
 * text conflict in a file full of facts and asks you to pick a side, and every
 * side loses something.
 *
 * Facts are content-addressed and carry their own provenance, so they can be
 * merged by meaning instead of by line. Nothing here is new: these are the same
 * reconciliation rules `Store.upsert` already applies within one machine,
 * pointed at two copies of the same memory instead.
 *
 * Nothing about this is limited to two machines. A fact merges by union, so
 * seven laptops converge exactly as cleanly as two.
 *
 * The rules, in the order they are applied to each fact id:
 *
 *   in both        union the sessions, keep the highest seen count and the
 *                  latest sighting. User-editable fields use the common
 *                  ancestor, so an unpin or section move is not mistaken for
 *                  stale metadata. Awake wins over dormant.
 *
 *   only one side, and it was in the common ancestor
 *                  an explicit tombstone wins. A missing version-2 fact with
 *                  no tombstone was pruned automatically, so a reinforcement
 *                  on the other machine may keep it.
 *
 *   only one side, and it was NOT in the ancestor
 *                  that machine learned something new. Keep it.
 */

const timestamp = (value, fallback) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : fallback;
};

function byTime(a, b, direction) {
  const A = timestamp(a, direction > 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY);
  const B = timestamp(b, direction > 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY);
  if (A !== B) return direction > 0 ? (A > B ? a : b) : (A < B ? a : b);
  // Equal timestamps must not make the merge depend on which machine ran it.
  return String(a || '').localeCompare(String(b || '')) >= 0 ? a : b;
}

const newer = (a, b) => byTime(a, b, 1);
const older = (a, b) => byTime(a, b, -1);

function preferredFact(a, b) {
  const A = timestamp(a.last, Number.NEGATIVE_INFINITY);
  const B = timestamp(b.last, Number.NEGATIVE_INFINITY);
  if (A !== B) return A > B ? a : b;
  const aKey = JSON.stringify([a.text || '', a.section || '', a.first || '']);
  const bKey = JSON.stringify([b.text || '', b.section || '', b.first || '']);
  return aKey.localeCompare(bKey) >= 0 ? a : b;
}

function mergeField(base, ours, theirs, onConflict) {
  if (Object.is(ours, theirs)) return ours;
  if (base !== undefined) {
    if (Object.is(ours, base) && !Object.is(theirs, base)) return theirs;
    if (Object.is(theirs, base) && !Object.is(ours, base)) return ours;
  }
  if (ours === undefined || ours === null) return theirs;
  if (theirs === undefined || theirs === null) return ours;
  return onConflict(ours, theirs);
}

function mergeFact(ours, theirs, base = null) {
  const preferred = preferredFact(ours, theirs);
  const sessions = [...new Set([...(ours.sessions || []), ...(theirs.sessions || [])])]
    .sort()
    .slice(-20);
  const dormant = Boolean(ours.dormant && theirs.dormant);
  const activeOurs = !ours.dormant;
  const activeTheirs = !theirs.dormant;
  let section;
  if (dormant) {
    section = DORMANT;
  } else if (activeOurs && !activeTheirs) {
    section = ours.section === DORMANT ? (ours.homeSection || base?.section) : ours.section;
  } else if (!activeOurs && activeTheirs) {
    section = theirs.section === DORMANT ? (theirs.homeSection || base?.section) : theirs.section;
  } else {
    section = mergeField(base?.section, ours.section, theirs.section, () => preferred.section);
  }

  const homeSection = dormant
    ? mergeField(base?.homeSection, ours.homeSection, theirs.homeSection, (a, b) => String(a).localeCompare(String(b)) >= 0 ? a : b)
    : undefined;

  return {
    ...preferred,
    // The other machine may hold a longer or shorter form of the same statement.
    // A unilateral hand edit beats a mere reinforcement of the base wording.
    text: mergeField(base?.text, ours.text, theirs.text, () => preferred.text),
    section,
    seen: Math.max(ours.seen || 1, theirs.seen || 1, sessions.length),
    sessions,
    confidence: Math.max(ours.confidence || 0, theirs.confidence || 0),
    first: older(ours.first, theirs.first),
    last: newer(ours.last, theirs.last),
    // Three-way field selection lets an explicit unpin survive a stale pinned
    // copy, while a new pin still wins over an unchanged unpinned base.
    pinned: Boolean(mergeField(base?.pinned, Boolean(ours.pinned), Boolean(theirs.pinned), (a, b) => a || b)),
    dormant,
    homeSection,
    evidence: mergeField(base?.evidence, ours.evidence, theirs.evidence, () => preferred.evidence),
    supersedes: [...new Set([...(ours.supersedes || []), ...(theirs.supersedes || [])])].sort(),
  };
}

function factChanged(base, fact) {
  if (!base) return true;
  for (const key of ['text', 'section', 'kind', 'source', 'confidence', 'seen', 'first', 'last', 'pinned', 'dormant', 'homeSection', 'evidence']) {
    if (!Object.is(base[key], fact[key])) return true;
  }
  return JSON.stringify(base.sessions || []) !== JSON.stringify(fact.sessions || []) ||
    JSON.stringify(base.supersedes || []) !== JSON.stringify(fact.supersedes || []);
}

const sameTombstone = (a, b) => Boolean(a && b && a.at === b.at && a.reason === b.reason);

function mergeTombstone(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const A = timestamp(a.at, Number.NEGATIVE_INFINITY);
  const B = timestamp(b.at, Number.NEGATIVE_INFINITY);
  if (A !== B) return A > B ? a : b;
  return String(a.reason || '').localeCompare(String(b.reason || '')) >= 0 ? a : b;
}

/**
 * Merge pending candidates.
 *
 * This is the quiet win of syncing. The promotion gate asks for a fact to turn
 * up in two separate sessions, and until now those sessions had to be on the
 * same machine. Union the session lists and saying something once on the laptop
 * and once on the desktop is finally enough.
 */
function mergePending(ours = {}, theirs = {}, facts) {
  const out = {};
  for (const id of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    if (facts[id]) continue; // already promoted on one side; the candidate is spent
    const a = ours[id];
    const b = theirs[id];
    if (!a || !b) { out[id] = a || b; continue; }
    out[id] = {
      ...a,
      sessions: [...new Set([...(a.sessions || []), ...(b.sessions || [])])].sort(),
      confidence: Math.max(a.confidence || 0, b.confidence || 0),
      first: older(a.first, b.first),
      last: newer(a.last, b.last),
    };
  }
  return out;
}

/**
 * Three-way merge of two index files.
 * @param {object|null} base the common ancestor, or null for a two-way merge
 * @returns {{index: object, stats: object}}
 */
export function mergeIndex(base, ours, theirs) {
  const B = base?.facts || {};
  const O = ours?.facts || {};
  const T = theirs?.facts || {};
  const BD = base?.tombstones || {};
  const OD = ours?.tombstones || {};
  const TD = theirs?.tombstones || {};
  const stats = { merged: 0, fromThem: 0, fromUs: 0, deleted: 0, kept: 0 };
  const facts = {};
  const tombstones = {};
  const ourVersion = Number(ours?.version || 1);
  const theirVersion = Number(theirs?.version || 1);

  for (const id of new Set([
    ...Object.keys(B), ...Object.keys(O), ...Object.keys(T),
    ...Object.keys(BD), ...Object.keys(OD), ...Object.keys(TD),
  ])) {
    const inOurs = Object.hasOwn(O, id);
    const inTheirs = Object.hasOwn(T, id);
    const inBase = Object.hasOwn(B, id);

    if (inOurs && inTheirs) {
      facts[id] = mergeFact(O[id], T[id], B[id] || null);
      stats.merged++;
      continue;
    }

    if (inOurs || inTheirs) {
      const present = inOurs ? O[id] : T[id];
      const missingTombstone = inOurs ? TD[id] : OD[id];
      const missingVersion = inOurs ? theirVersion : ourVersion;
      const missingUpdated = inOurs ? theirs?.updated : ours?.updated;

      // A tombstone that was created after the base is an intentional forget
      // (including a hand deletion or semantic supersession) and wins even if
      // the other machine happened to reinforce the old fact meanwhile.
      if (missingTombstone && !sameTombstone(missingTombstone, BD[id])) {
        tombstones[id] = mergeTombstone(missingTombstone, inOurs ? OD[id] : TD[id]);
        stats.deleted++;
        continue;
      }

      if (inBase) {
        // Version-1 indexes had no tombstones, so preserve their historical
        // deletion-wins behaviour. Version 2 can identify a missing entry with
        // no tombstone as automatic pruning instead.
        if (missingVersion < INDEX_VERSION) {
          tombstones[id] = missingTombstone || {
            at: missingUpdated || base?.updated || present.last || null,
            reason: 'deleted on a legacy client',
          };
          stats.deleted++;
          continue;
        }
        if (!factChanged(B[id], present)) {
          // The present side is unchanged, so the other side's automatic prune
          // is the only new decision and may stand without becoming a tombstone.
          stats.deleted++;
          continue;
        }
      }

      // New fact, explicit resurrection of a base tombstone, or a reinforcement
      // that outranks automatic pruning on the other machine.
      facts[id] = present;
      if (inOurs) stats.fromUs++;
      else stats.fromThem++;
      continue;
    }

    const tombstone = mergeTombstone(OD[id], TD[id]);
    if (tombstone) tombstones[id] = tombstone;
    if (inBase) stats.deleted++;
  }
  stats.kept = Object.keys(facts).length;

  return {
    index: {
      version: Math.max(INDEX_VERSION, Number(base?.version || 1), ourVersion, theirVersion),
      facts,
      pending: mergePending(ours?.pending, theirs?.pending, facts),
      tombstones,
      updated: newer(ours?.updated, theirs?.updated),
    },
    stats,
  };
}

/** Merge the cross-project ledger: a fact's repo list is the union of both sides. */
export function mergeLedger(base, ours, theirs) {
  const O = ours?.facts || {};
  const T = theirs?.facts || {};
  const facts = {};
  for (const key of new Set([...Object.keys(O), ...Object.keys(T)])) {
    const a = O[key];
    const b = T[key];
    if (!a || !b) { facts[key] = a || b; continue; }
    facts[key] = {
      text: Date.parse(b.last || 0) > Date.parse(a.last || 0) ? b.text : a.text,
      projects: [...new Set([...(a.projects || []), ...(b.projects || [])])].sort(),
      first: older(a.first, b.first),
      last: newer(a.last, b.last),
      promoted: Boolean(a.promoted || b.promoted),
    };
  }
  return { version: Math.max(Number(base?.version || 1), Number(ours?.version || 1), Number(theirs?.version || 1)), facts };
}

/**
 * Merge the audit log. It is append-only by construction, so the union of both
 * sides in timestamp order is the whole history, with exact duplicates dropped.
 */
export function mergeJournal(ourLines, theirLines) {
  const seen = new Set();
  const all = [];
  for (const line of [...ourLines, ...theirLines]) {
    const key = JSON.stringify(line);
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(line);
  }
  return all.sort((a, b) => {
    const byDate = String(a.at || '').localeCompare(String(b.at || ''));
    return byDate || JSON.stringify(a).localeCompare(JSON.stringify(b));
  });
}

/**
 * Evidence is an append-only receipt stream. Unlike the audit journal, each
 * receipt has a stable id, so two copies of the same receipt with different
 * JSON field order still collapse to one entry. A later edit wins for a
 * duplicate id, and the resulting stream is deterministic for Git.
 */
export function mergeEvidence(ourLines = [], theirLines = []) {
  const byId = new Map();
  for (const entry of [...ourLines, ...theirLines]) {
    const current = byId.get(entry.id);
    const entryAt = timestamp(entry.at, Number.NEGATIVE_INFINITY);
    const currentAt = timestamp(current?.at, Number.NEGATIVE_INFINITY);
    if (!current || entryAt > currentAt ||
        (entryAt === currentAt && JSON.stringify(entry).localeCompare(JSON.stringify(current)) >= 0)) {
      byId.set(entry.id, entry);
    }
  }
  return [...byId.values()].sort((a, b) => {
    const byDate = String(a.at || '').localeCompare(String(b.at || ''));
    return byDate || String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Merge a project handoff. Scalar snapshot fields follow the newer checkpoint;
 * list fields union concurrent additions so two machines do not silently lose
 * a next step or a completed item. When a side is the only one changed from
 * the common ancestor, its intentional replacement still wins.
 */
export function mergeCheckpoint(base, ours, theirs) {
  const B = base || {};
  const O = ours || {};
  const T = theirs || {};
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const oursAt = timestamp(O.updatedAt, Number.NEGATIVE_INFINITY);
  const theirsAt = timestamp(T.updatedAt, Number.NEGATIVE_INFINITY);
  const latest = oursAt > theirsAt ||
    (oursAt === theirsAt && JSON.stringify(O).localeCompare(JSON.stringify(T)) >= 0) ? O : T;
  const changedOurs = (key) => !same(O[key], B[key]);
  const changedTheirs = (key) => !same(T[key], B[key]);
  const choose = (key) => {
    if (changedOurs(key) && !changedTheirs(key)) return O[key];
    if (changedTheirs(key) && !changedOurs(key)) return T[key];
    return latest[key] ?? O[key] ?? T[key] ?? B[key];
  };
  const union = (key) => {
    if (changedOurs(key) && !changedTheirs(key)) return O[key] || [];
    if (changedTheirs(key) && !changedOurs(key)) return T[key] || [];
    return [...new Set([...(O[key] || []), ...(T[key] || [])])];
  };
  return {
    version: 1,
    project: latest.project || O.project || T.project || B.project || {},
    goal: choose('goal') || '',
    done: union('done').slice(0, 50),
    next: union('next').slice(0, 50),
    blocked: union('blocked').slice(0, 50),
    branch: choose('branch') || '',
    commit: choose('commit') || '',
    dirtyFiles: union('dirtyFiles').slice(0, 80),
    updatedAt: latest.updatedAt || O.updatedAt || T.updatedAt || B.updatedAt || null,
  };
}

export const _internals = { mergeFact, mergePending, normalize };
