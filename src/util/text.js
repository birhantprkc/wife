import crypto from 'node:crypto';

/**
 * Token estimate. Deliberately dependency-free: no tokenizer download, no wasm.
 * Calibrated against mixed Spanish/English markdown prose, which lands around
 * 3.6 characters per token. Expect +/-15%; the budget headroom absorbs it.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 3.6);
}

/** Lowercase, strip diacritics and punctuation, collapse whitespace. Used for identity hashing. */
export function normalize(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable content-addressed id for a fact. Same meaning, same id, across machines. */
export function factId(text) {
  return crypto.createHash('sha256').update(normalize(text)).digest('hex').slice(0, 10);
}

const STOPWORDS = new Set([
  // es
  'el','la','los','las','un','una','unos','unas','de','del','al','a','en','y','o','que','se','es','son',
  'con','por','para','su','sus','lo','le','me','mi','mis','te','tu','tus','como','mas','pero','este',
  'esta','estos','estas','ese','esa','muy','ya','sin','sobre','hay','ser','estar','tiene','tener','usa','usar',
  // en
  'the','a','an','of','to','in','on','for','and','or','that','this','these','those','is','are','be','been',
  'with','by','it','its','as','at','from','my','your','i','we','you','use','uses','using','do','does','not',
]);

export function tokensOf(text) {
  return normalize(text).split(' ').filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Jaccard similarity over content words. Cheap near-duplicate detection, no embeddings. */
export function similarity(a, b) {
  const A = new Set(tokensOf(a));
  const B = new Set(tokensOf(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * True when one statement is a strictly more detailed version of the other:
 * every content word of the shorter appears in the longer, and the longer adds
 * something. "Prefers short answers" refines into "Prefers short direct answers".
 *
 * This replaces a plain similarity threshold, which was quietly wrong. Two long
 * statements differing by one word — "deploys to production every Friday" and
 * "deploys to staging every Friday" — score above any useful similarity cutoff
 * while meaning different things. A subset test cannot make that mistake:
 * each has a word the other lacks, so they stay separate facts.
 *
 * @returns {0|1|-1} 1 if b refines a, -1 if a refines b, 0 if neither.
 */
export function refines(a, b) {
  const A = new Set(tokensOf(a));
  const B = new Set(tokensOf(b));
  if (A.size < 2 || B.size < 2) return 0;
  const subset = (X, Y) => [...X].every((w) => Y.has(w));
  if (A.size === B.size && subset(A, B)) return 1; // same content words, different wording
  if (subset(A, B)) return 1;
  if (subset(B, A)) return -1;
  return 0;
}

const NEGATIONS = new Set(['no', 'not', 'never', 'nunca', 'jamas', 'sin', 'dont', "don't", 'ya no', 'evitar', 'evita']);

/**
 * True when two facts say the opposite thing about the same subject: identical
 * content words, but exactly one of them carries a negation.
 */
export function contradicts(a, b) {
  const stripNeg = (t) => normalize(t).split(' ').filter((w) => !NEGATIONS.has(w)).join(' ');
  const hasNeg = (t) => normalize(t).split(' ').some((w) => NEGATIONS.has(w));
  if (hasNeg(a) === hasNeg(b)) return false;
  return similarity(stripNeg(a), stripNeg(b)) >= 0.8;
}

export function titleCase(text) {
  const t = String(text).trim();
  if (!t) return t;
  return t[0].toUpperCase() + t.slice(1);
}

/** Collapse whitespace, drop trailing filler punctuation, cap the length. */
export function tidy(text, maxLen = 180) {
  let t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s"'`*\-–—:,.]+/, '')
    .replace(/[\s,;:.!]+$/, '');
  if (t.length > maxLen) {
    const cut = t.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(' ');
    t = `${(lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
  }
  return t;
}

export function wordCount(text) {
  return normalize(text).split(' ').filter(Boolean).length;
}

export function pad(str, width) {
  const s = String(str);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}
