import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extract, judge, classifyScope, REJECTIONS } from '../src/core/extract.js';
import { detectSecret } from '../src/core/redact.js';
import { similarity, contradicts, factId, normalize, estimateTokens } from '../src/util/text.js';

describe('secret screening', () => {
  const secrets = [
    'my key is sk-abcdefghijklmnopqrstuvwx',
    'token ghp_abcdefghijklmnopqrstuvwxyz1234',
    'AKIAIOSFODNN7EXAMPLE is the access key',
    'password = hunter2000xyz',
    'password is hunter2000xyz',
    'contraseña: hunter2000xyz',
    'clave = hunter2000xyz',
    'remember that my API key is abc123xyz789',
    'recuerda que mi clave es hunter2000xyz',
    'client_secret=abcdefghi12345',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    'postgres://user:pw@db.example.com:5432/app',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    '-----BEGIN RSA PRIVATE KEY-----',
    'sha is 356a192b7913b04c54574d18c28d46e6395428ab0123456789abcdef',
    'abcdEFGHijklMNOPqrstUVWX0123456789abcde==',
  ];
  for (const s of secrets) {
    test(`rejects: ${s.slice(0, 34)}…`, () => {
      assert.notEqual(detectSecret(s), null, 'should have been flagged as a secret');
    });
  }

  test('does not flag ordinary prose', () => {
    for (const clean of [
      'I prefer short answers',
      'we use Postgres in this project',
      'always run the tests before committing',
      'my name is Sam and I live in Berlin',
      'the token budget is 1200 characters',
      'the client secret rotation policy runs monthly',
      'la clave es mantener las pruebas rápidas',
    ]) {
      assert.equal(detectSecret(clean), null, `false positive on: ${clean}`);
    }
  });

  test('honours custom deny patterns', () => {
    assert.equal(detectSecret('the client is Acme Corp', ['acme']), 'custom:acme');
  });
});

describe('candidate judging', () => {
  test('rejects questions', () => {
    assert.equal(judge('what should I use here').ok, true, 'no question mark, so it passes');
    assert.equal(judge('what should I use here?').reason, REJECTIONS.QUESTION);
    assert.equal(judge('¿qué stack uso?').reason, REJECTIONS.QUESTION);
  });

  test('rejects tasks disguised as statements', () => {
    for (const task of ['arregla el bug de auth', 'fix the login flow please', 'implementa el endpoint nuevo', 'can you refactor this module']) {
      const v = judge(task);
      assert.equal(v.ok, false, `should have rejected: ${task}`);
      assert.equal(v.reason, REJECTIONS.TASK);
    }
  });

  test('rejects code and paths', () => {
    assert.equal(judge('const x = foo({ bar: 1 }); return x;').ok, false);
    assert.equal(judge('the file lives in ./src/components/Button.tsx').reason, REJECTIONS.CODE);
    assert.equal(judge('check https://example.com/docs/page').reason, REJECTIONS.CODE);
  });

  test('rejects fragments and essays', () => {
    assert.equal(judge('ok sure').reason, REJECTIONS.TOO_SHORT);
    assert.equal(judge(new Array(40).fill('palabra').join(' ')).reason, REJECTIONS.TOO_LONG);
  });

  test('accepts genuine facts', () => {
    for (const good of ['prefiere respuestas cortas y directas', 'this project uses Postgres and Deno', 'Based in Berlin']) {
      assert.equal(judge(good).ok, true, `should have accepted: ${good}`);
    }
  });
});

describe('extraction — Spanish', () => {
  test('explicit directive is captured and marked explicit', () => {
    const { candidates } = extract('recuerda que siempre trabajo en español');
    assert.ok(candidates.length >= 1);
    assert.equal(candidates[0].explicit, true);
    assert.match(candidates[0].text, /español/);
  });

  test('preference becomes a normalised fact', () => {
    const { candidates } = extract('prefiero respuestas cortas y sin relleno');
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].text, /^Prefiere /, 'a Spanish preference must be labelled in Spanish');
    assert.equal(candidates[0].kind, 'preference');
    assert.equal(candidates[0].scope, 'user');
  });

  test('dislike is not stored as a preference for the thing', () => {
    const { candidates } = extract('odio que me expliques lo que ya sé');
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].text, /^No le gusta /);
  });

  test('constraint is captured with an Evitar prefix', () => {
    const { candidates } = extract('no uses tablas en los documentos legales');
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].text, /^Evitar: /);
    assert.equal(candidates[0].kind, 'constraint');
  });

  test('stack statement lands in project scope', () => {
    const { candidates } = extract('este proyecto usa Supabase y Deno para las edge functions');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].scope, 'project');
    assert.match(candidates[0].text, /Supabase/);
  });

  test('identity statement is scoped to the user', () => {
    const { candidates } = extract('me llamo Ana y vivo en Valencia');
    assert.ok(candidates.length >= 1);
    assert.equal(candidates[0].scope, 'user');
  });

  test('two Spanish identity clauses keep their own labels', () => {
    const { candidates } = extract('soy ingeniero y trabajo en Acme');
    assert.deepEqual(candidates.map((c) => c.text), ['Es ingeniero', 'Trabaja en Acme']);
  });
});

describe('facts are written in the language they were said in', () => {
  test('Spanish in, Spanish out', () => {
    assert.match(extract('prefiero trabajar de noche sin interrupciones').candidates[0].text, /^Prefiere /);
    assert.match(extract('usamos Kotlin y Compose en el cliente').candidates[0].text, /^Usa /);
    assert.match(extract('no uses emojis en los commits').candidates[0].text, /^Evitar: /);
  });
  test('English in, English out', () => {
    assert.match(extract('I prefer working late without interruptions').candidates[0].text, /^Prefers /);
    assert.match(extract('we use Kotlin and Compose on the client').candidates[0].text, /^Uses /);
  });
  test('every fact starts with a capital letter', () => {
    for (const p of ['recuerda que trabajo en español', 'remember that i deploy on fridays', 'nunca uso tabuladores']) {
      for (const cand of extract(p).candidates) {
        assert.match(cand.text[0], /[A-ZÁÉÍÓÚÑ]/, `not capitalised: "${cand.text}"`);
      }
    }
  });
});

describe('extraction — English', () => {
  test('remember-that directive', () => {
    const { candidates } = extract('Remember that I deploy on Fridays only');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].explicit, true);
  });

  test('work-at identity uses the employer label, not the location label', () => {
    const { candidates } = extract('I work at Acme');
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].text, /^Works at Acme$/);
    assert.equal(candidates[0].scope, 'user');
  });

  test('two English identity clauses remain separate facts', () => {
    const { candidates } = extract("I'm an engineer and I work at Acme");
    assert.deepEqual(candidates.map((c) => c.text), ['Is engineer', 'Works at Acme']);
  });

  test('always/never rule keeps its polarity word', () => {
    const { candidates } = extract('Never commit directly to the main branch');
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].text.toLowerCase(), /^never /);
  });

  test('we-use statement is project scoped', () => {
    const { candidates } = extract('We use pnpm and Vitest in this repo');
    assert.equal(candidates[0].scope, 'project');
  });
});

describe('extraction — what it refuses to learn', () => {
  test('a plain task produces nothing', () => {
    const { candidates } = extract('arregla el bug del login y corre los tests');
    assert.equal(candidates.length, 0);
  });

  test('a question produces nothing', () => {
    const { candidates } = extract('qué base de datos me recomiendas para esto?');
    assert.equal(candidates.length, 0);
  });

  test('a prompt containing a secret produces nothing', () => {
    const token = 'sk-abcdefghijklmnopqrstuvwxyz';
    const result = extract(`recuerda que mi api key es ${token}`);
    const { candidates, rejected } = result;
    assert.equal(candidates.length, 0);
    assert.equal(rejected[0].reason, REJECTIONS.SECRET);
    assert.equal(rejected[0].text, '<sentence containing a credential>');
    assert.ok(!JSON.stringify(result).includes(token), 'a rejected credential must never be echoed');
  });

  test('a secret before the matched phrase cannot leak through evidence', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz1234';
    const result = extract(`token ${token} y recuerda que prefiero respuestas cortas`);
    assert.equal(result.candidates.length, 0);
    assert.equal(result.rejected[0].reason, REJECTIONS.SECRET);
    assert.ok(!JSON.stringify(result).includes(token), 'the source sentence leaked the token');
  });

  test('secret screening runs before candidate truncation', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz1234';
    const body = `mi configuración preferida para todos los entornos es ${'x'.repeat(95)} ${token}`;
    const result = extract(`recuerda que ${body}`);
    assert.equal(body.length > 180, true, 'fixture must cross tidy()\'s truncation boundary');
    assert.equal(result.candidates.length, 0);
    assert.equal(result.rejected[0].reason, REJECTIONS.SECRET);
    assert.ok(!JSON.stringify(result).includes(token), 'truncation hid a token from the gate');
  });

  test('a durable-looking clause inside a one-off task is still a task', () => {
    for (const prompt of [
      'quiero que nunca uses npm para esta tarea',
      'write a component that always uses memoization',
      'I want you to always use memoization in this component',
    ]) {
      const { candidates, rejected } = extract(prompt);
      assert.equal(candidates.length, 0, `learned from task: ${prompt}`);
      assert.equal(rejected[0]?.reason, REJECTIONS.TASK);
    }
  });

  test('a pasted log is never mined', () => {
    const log = new Array(600).fill('ERROR module not found at /usr/lib/node').join('\n');
    const { candidates } = extract(log, { maxChars: 4000 });
    assert.equal(candidates.length, 0);
  });

  test('the same fact twice in one prompt is deduplicated', () => {
    const { candidates } = extract('prefiero respuestas cortas. de verdad prefiero respuestas cortas.');
    assert.equal(candidates.length, 1);
  });

  test('one sentence does not fire two overlapping rules', () => {
    const { candidates } = extract('siempre usamos pnpm en este repo');
    assert.equal(candidates.length, 1, 'the rule and stack patterns must not both fire');
  });
});

describe('text utilities', () => {
  test('factId ignores case, accents and punctuation', () => {
    assert.equal(factId('Prefiere respuestas cortas.'), factId('prefiere respuestas cortas'));
    assert.equal(factId('Está en Múnich'), factId('esta en munich'));
  });

  test('factId separates genuinely different facts', () => {
    assert.notEqual(factId('uses Postgres'), factId('uses MySQL'));
  });

  test('similarity finds restatements', () => {
    assert.ok(similarity('prefers short direct answers', 'prefers short and direct answers') > 0.7);
    assert.ok(similarity('uses Postgres', 'lives in Berlin') < 0.2);
  });

  test('contradiction detection catches a flipped statement', () => {
    assert.equal(contradicts('uses Postgres for storage', 'no uses Postgres for storage'), true);
    assert.equal(contradicts('uses Postgres', 'uses MySQL'), false);
  });

  test('token estimate is in a sane range', () => {
    const tokens = estimateTokens('- prefiere respuestas cortas y directas\n');
    assert.ok(tokens > 5 && tokens < 25, `got ${tokens}`);
  });

  test('normalize collapses whitespace', () => {
    assert.equal(normalize('  Hola   MUNDO  '), 'hola mundo');
  });
});

describe('scope classification', () => {
  test('style instructions are about the user, not the repo', () => {
    assert.equal(classifyScope('answer in Spanish with short replies', 'directive'), 'user');
  });
  test('repo instructions are about the project', () => {
    assert.equal(classifyScope('run the tests before every deploy in this repo', 'directive'), 'project');
  });
});

describe('regression: scope classification must weigh, not short-circuit', () => {
  const cases = [
    ['nunca hagas commit directo a main', 'project', '"directo" also appears in "respuestas directas"'],
    ['recuerda que respondas siempre en español', 'user', 'how to speak to me follows me between repos'],
    ['nunca hago deploy los viernes', 'user', 'first person outweighs a single repo word'],
    ['este proyecto usa Kotlin', 'project', 'a two-word rendered fact is still a fact'],
    ['usamos Deno en el backend', 'project', ''],
    ['prefiero que me expliques poco', 'user', ''],
    ['Remember that we use pnpm', 'project', 'collective stack decisions belong to the repository'],
    ['recuerda que usamos pnpm', 'project', 'collective stack decisions belong to the repository'],
    ['I always deploy on Fridays', 'user', 'scope must retain the first-person cue removed by rendering'],
    ['prefiero usar Vitest en este proyecto', 'project', 'an explicit project qualifier beats a personal verb'],
  ];
  for (const [prompt, expected, why] of cases) {
    test(`"${prompt}" → ${expected}${why ? ` (${why})` : ''}`, () => {
      const { candidates } = extract(prompt);
      assert.ok(candidates.length >= 1, `nothing extracted from "${prompt}"`);
      assert.equal(candidates[0].scope, expected, `got "${candidates[0].text}" in ${candidates[0].scope}`);
    });
  }
});
