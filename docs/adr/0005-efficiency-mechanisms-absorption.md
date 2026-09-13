# 0005 — Absorbing SoL-Pi Efficiency Mechanisms into pier

**Status**: accepted (2026-09-12)  
**Decisions Cited**: D100, D101, D102, D103  
**RFC**: [docs/rfc-sol-pi-absorption.md](../rfc-sol-pi-absorption.md)  

## Context

Coding agents accumulate significant token traffic and inference cost during extended auto-research and development loops. NVIDIA's `SoL-Pi` introduced four efficiency mechanisms (Action Fusion, ObservationPack, Evidence-Preserving Reducer, and Online Context Compact).

However, running SoL-Pi unmodified alongside `pier` created severe conflicts:
- SoL-Pi's `update_plan` clashed with pier's authoritative `todo_write` loop and caused cognitive split;
- SoL-Pi's Action Fusion intercepted `edit`/`write` tools, threatening pier's distributed file write-locks (`index-locks.ts`);
- Hard aborts during manual compaction competed with pier's unfinished-todo reminders and subagent settle-wakes;
- Intermediate message packing risked invalidating rolling prefix caches (e.g. Anthropic) without net profit;
- Rewriting `tool_result` without archiving raw logs permanently discarded evidence from session history.

## Decisions

1. **Retain Native Tools & Drop Action Fusion**:
   Keep Pi's standard `edit` and `write` tools untouched to preserve pier's multi-pane write locks and D82 tool gate invariants.

2. **D100: Todo-Driven Context Compaction (OCC)**:
   - Ground milestone boundaries on `TodosService`'s `todo.completed { source: 'tool' }`, rejecting noise from human commands, archive cleanups, and settlement reconciliations.
   - Employ mathematically grounded KV-cache economics (`writeTokens * (ratio - 1) / savings`), window protection, and preflight feasibility checks (`nativeCompactionFeasible`).
   - Keep the native-compaction retention window in `onlineContextCompact.keepRecentTokens` (default `20000`, equal to Pi's default). Pi's own `compaction.*` settings are deliberately NOT read: enabling OCC means taking over compaction timing, so the window must be configured here (RFC §3.2).
   - Suppress stop-reminders and settle-wakes during compaction via `intentionalAbort` and `compactionInFlight` guards.

3. **D101: Cache-Aware ObservationPack**:
   - Project paged placeholders for large outputs (>10KB) on turn 3+ in `pi.on("context")`, keeping session JSONL immutable.
   - Evaluate rolling prefix cache penalty (`removedTokens * horizon > tailTokensAfter * (ratio - 1)`) before packing.
   - Check role visibility: disable packing if `obs_recall` is denied in the current role profile.

4. **D102: In-Process Evidence-Preserving Reducer (EPR)**:
   - Run as an in-process micro-filter with 5s timeout; do not spawn subagents or disrupt Herdr UI panes.
   - Require `ctx.isProjectTrusted()` and scan `LIKELY_SECRET` before processing.
   - Read Pi's untruncated bash output (`details.fullOutputPath`), archive raw logs to session objects (`0600`, `O_NOFOLLOW`) before replacement, and enforce byte-for-byte quotation validation.
   - Perform block-level replacement to preserve write-lock warnings.

5. **D103: Multi-Tier Config & Independent Telemetry**:
   - Allow independent `enabled` and `logEnabled` flags with `PI_HERDR_*` env overrides.
   - Persist decision state in session branch entries (`pi-herdr.efficiency-state`) while streaming high-frequency telemetry to dedicated JSONL files (`efficiency-logs/*.jsonl`).

## Hardening & residuals resolution (2026-09-13)

All 7 residuals registered during review have been implemented and verified:
- Telemetry logs already rotated at 5MB (`.old`) from the first implementation; this hardening round added object-file pruning (300 files / 50MB) plus session-scoped pruning of both object dirs on shutdown.
- `reducer.jsonl` carries both `sessionId` and `epoch`.
- `loadEfficiencyConfigFromDisk` automatically reads Pi's `settings.json`, respecting `compaction.enabled` and inheriting `keepRecentTokens`.
- OBS supports `batchPackObservations` pre-packing before OCC compaction.
- `CompactCoordinator.getRemainingHorizon()` reuses `estimateRemainingRequests` and is covered by unit tests.
- A targeted typecheck gate (`npm run typecheck`) is enforced before `npm test` covering the 16 efficiency and lifecycle core modules, compiling with zero errors.
- Stryker: `compact-economics-core.ts` scores 77.46% under the full test suite (315 mutants; 78.26% combined with `gc-core.ts`). The other three new cores were additionally measured with a unit+integration spec subset (1160 mutants, 58.79% overall: `observation-core` 66.82%, `efficiency-config-core` 59.80%, `reducer-core` 48.52%); those are **lower bounds** — the full suite can only kill more — and a full-suite run was measured at ~2–3h and not performed. The weakest link (`reducer-core.ts`) was then hardened with command-boundary and receipt-format tests plus a widened `DIAGNOSTIC_COMMAND` tail boundary (shell separators), lifting its lower bound to **52.52%**. Reports: `reports/mutation/*.json`.
