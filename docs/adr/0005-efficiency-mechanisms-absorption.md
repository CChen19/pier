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

## Known residuals (2026-09-13)

These are accepted, documented gaps — none affect the default-off (fail-open) safety baseline. The authoritative per-round evidence lives in `code review.md` (Round 1–4) and the registry table in RFC §9.

- Telemetry logs and content-addressed objects are append-only (no rotation/retention policy yet).
- `reducer.jsonl` carries `sessionId`/`grossSavedBytes` but not the OCC `epoch`.
- OCC does not read Pi's `compaction.enabled`; the retention window is duplicated as an explicit extension setting (handled, but driftable).
- OBS packs on a per-request economic decision with sticky keep (the memo fast path); “batch pack at the OCC compaction point” remains future work.
- `CompactCoordinator.getRemainingHorizon()` re-implements the horizon formula instead of reusing `estimateRemainingRequests`, and is untested.
- The repo has no typecheck gate (`tsc --noEmit`), and the four new pure cores have no fresh Stryker report.
