# Wife — notes for the agent reading this (Codex reads this file)

Wife is a local memory layer for coding agents. It has zero runtime
dependencies and no build step: the source in `src/` is what runs.

## If the user wants to install it

Run these, in this order, from this folder:

```bash
npm link            # puts the `wife` command on their PATH
wife init           # creates ~/.wife
wife attach claude  # or: wife attach codex
wife status         # confirm, then show them the output
```

Then tell them to **restart their agent** so the hooks load.

`wife attach` merges into the existing settings file and removes nothing.
If `npm link` fails with a permission error, report it rather than reaching
for sudo — the usual cause is that npm's global bin directory is not on PATH.

## If the user wants to change something

Run `npm run check` before and after. It covers the unit, end-to-end,
multi-machine sync and multi-agent suites, and it must stay green. New
behaviour needs a new test.

Where things live:

- `src/core/extract.js` — the pattern rules that turn prompts into candidate
  facts, plus the rejection filters. Most feature requests land here.
- `src/core/store.js` — markdown file plus metadata sidecar, scoring, pruning.
  Hand edits to the markdown always win over the sidecar.
- `src/core/harvest.js` — the curator: extract, gate, reconcile, retire, prune.
- `src/core/import.js` — seeding from existing CLAUDE.md / AGENTS.md. Screens for
  credentials BEFORE any text cleanup; reversing that order once let a token
  through, because stripping markdown emphasis also ate the underscore.
- `src/core/crossproject.js` — the only state that spans repos.
- `src/core/guards.js` — rules that a PreToolUse hook can enforce. Guards must
  FAIL OPEN and must never be created without the user approving each one. A
  description ("Uses pnpm") is not a prohibition and must never become a guard.
- `src/core/merge.js` + `src/commands/gitsync.js` — multi-machine sync. Two traps
  live here: `merge=ours` is NOT a git built-in and must be defined as a driver
  or every sync dies on a markdown conflict; and markdown must be DELETED before
  regenerating from a merged index, or Store.load re-adopts facts the other
  machine deliberately deleted.
- `src/agents/` — one file per agent integration.
- `src/commands/hooks.js` — code that runs inside a hook. It must never exit
  non-zero and must never print anything unexpected to stdout.

## Rules that are not negotiable

- Never mine the agent's own output. Wife reads user prompts only.
- Never let a credential reach disk. `src/core/redact.js` screens every
  candidate; a match drops the whole candidate rather than masking it.
- Never remove the token ceiling. It is the reason the memory stays trustworthy.
- Never let import read Wife's own managed block. That is a feedback loop.
