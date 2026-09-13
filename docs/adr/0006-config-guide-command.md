# 0006 — `/pier-config`: a read-only configuration guide with a guided-change handoff

**Status**: accepted (2026-09-13)
**Decisions Cited**: D104
**Design note**: [docs/pier-config-command.md](../pier-config-command.md)
**User-facing docs**: [docs/configuration.md](../configuration.md), [docs/efficiency-trial.md](../efficiency-trial.md)

## Context

pier's configuration is spread over five planes with four precedence rules and a trust gate:
the efficiency mechanisms (D100–D103), role profiles (D82/D11), pi's own `settings.json`, the
workbench `boot-config.json`, and the `PIER_*` / `PI_HERDR_*` env knobs. Users could not tell
**which value is in effect, where it came from, or where to change it**, and the loader silently
ignores workspace layers of untrusted projects (by design) — which reads as "my config does
nothing". `/efficiency` only covered three booleans of one plane.

Three approaches were considered:

1. an interactive picker that writes values for the user (like pi's `/settings`);
2. a generator that only writes a markdown reference;
3. a read-only reporter plus a handoff that lets the agent walk the user through the edit.

## Decision

Ship **`/pier-config`** as option 3, with the name prefixed to avoid colliding with pi's builtin
commands (or other plugins) and the injected instruction block written in English:

- `show [plane|all]` reports **effective value + source** (`env` > workspace > user > default),
  the file inventory per plane (marking untrusted workspaces as `IGNORED`), and a one-line impact
  per knob.
- `check` aggregates real validation (efficiency config validator, role loader, boot-config shape,
  env bounds) instead of re-implementing it.
- `doc [path]` writes a machine-truth report; bare `/pier-config` injects a fixed workflow that
  makes the **agent** explain trade-offs, show a diff, wait for confirmation, apply with the normal
  `edit`/`write` tools (write locks apply), and re-run `check`.

The command never writes configuration itself: writes stay in the audited, lock-protected tool
path, and the command cannot leak secrets (it reads only catalog-declared env keys and masks
secret-shaped ones).

## Guard rails

- `config-catalog-core.ts` is the single source of truth, and a test diffs the catalog against
  both JSON schemas and the env keys the runtime actually reads — an undocumented key fails CI
  instead of drifting.
- pi-owned values stay read-only and point at pi's `/settings`.
- All reads are fail-open: a broken plane becomes a reported issue, never an exception in pi's
  command pipeline.

## Consequences

- The former `/efficiency` command is **removed** rather than kept as an alias: no tag had been
  released, and its information is fully covered by the `/pier-config` index line (OCC/OBS/EPR
  state) and `show efficiency` (every knob with effective value and source).
- The typecheck gate gained the three new D104 files (which surfaced a pre-existing
  non-strict narrowing bug in `role-loader.ts`, fixed with `result.ok === false`).
- P3 (an optional TUI picker for the high-frequency efficiency toggles) stays unimplemented until
  trial feedback justifies it.
