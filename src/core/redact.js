/**
 * Secret screening.
 *
 * wife reads every prompt you type. That is only acceptable if a credential
 * pasted into a prompt can never survive into a memory file. Anything matching
 * these shapes disqualifies the whole candidate: it is dropped, not masked.
 * Dropping beats masking here, because a masked fact still leaks its context
 * ("the production key for acme-prod is <redacted>").
 */
const SECRET_PATTERNS = [
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/ },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/ },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { id: 'google-key', re: /\bAIza[A-Za-z0-9_-]{30,}\b/ },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'stripe-key', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { id: 'private-key-block', re: /-----BEGIN[A-Z ]*PRIVATE KEY-----/ },
  { id: 'bearer', re: /\bbearer\s+[A-Za-z0-9._-]{20,}/i },
  { id: 'basic-auth', re: /\bauthorization\s*:\s*basic\s+[A-Za-z0-9+/]{8,}={0,2}(?![A-Za-z0-9+/=])/i },
  { id: 'basic-auth-url', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i },
  {
    id: 'assigned-secret',
    // Match both prose ("password is …", "contraseña: …") and the
    // compound identifiers used in env files (CLIENT_SECRET, DB_PASSWORD).
    // Human-readable labels often contain spaces ("API key", "private key"),
    // while env-style labels use underscores or dashes, so both shapes matter.
    // Requiring an assignment word or separator avoids treating phrases such
    // as "token budget" and "secret rotation policy" as credentials.
    re: /(?:\b(?:(?:[a-z0-9]+[_-])*(?:pass(?:word|wd)?|secret|token|api[_-]?key|apikey|access[_-]?key|credential|priv(?:ate)?[_-]?key)|(?:api|access|private)\s+key|secret\s+access\s+key|contrase(?:ñ|n)a)\b\s*(?::|=|\bis\b|\bes\b)|\bclave\b\s*[:=])\s*["'`]?\S{6,}/i,
  },
  {
    id: 'assigned-secret-es',
    // "La clave es mantener las pruebas rápidas" is ordinary prose. Treat
    // "clave es <value>" as a credential only when the first value-shaped
    // token contains both a letter and a digit/symbol, as real keys commonly do.
    re: /\bclave\b\s+es\s+["'`]?(?=[^\s"'`]{6,})(?=[^\s"'`]*[A-Za-z])(?=[^\s"'`]*(?:\d|[_.\/+\-=:]))[^\s"'`]{6,}/i,
  },
  {
    id: 'high-entropy-blob',
    // A word boundary does not exist after base64 padding (`=`), nor between
    // an underscore-prefixed label and its value. Delimit by the alphabet
    // itself so padded session tokens are screened too.
    re: /(?:^|[^A-Za-z0-9+/=_-])(?=[A-Za-z0-9+/=_-]{40,}(?:$|[^A-Za-z0-9+/=_-]))(?=[A-Za-z0-9+/=_-]*[A-Z])(?=[A-Za-z0-9+/=_-]*[a-z])(?=[A-Za-z0-9+/=_-]*\d)[A-Za-z0-9+/=_-]{40,}/,
  },
  { id: 'long-hex', re: /\b[a-f0-9]{40,}\b/i },
  { id: 'connection-string', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/\S+/i },
];

/** @returns {string|null} the id of the first pattern that matched, or null. */
export function detectSecret(text, extraPatterns = []) {
  const s = String(text || '');
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(s)) return p.id;
  }
  for (const raw of extraPatterns) {
    try {
      if (new RegExp(raw, 'i').test(s)) return `custom:${raw}`;
    } catch {
      /* an invalid user regex must not break capture */
    }
  }
  return null;
}

export function isSafe(text, extraPatterns = []) {
  return detectSecret(text, extraPatterns) === null;
}

export const SECRET_PATTERN_IDS = SECRET_PATTERNS.map((p) => p.id);
