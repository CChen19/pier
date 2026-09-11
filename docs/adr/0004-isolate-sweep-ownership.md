# 0004 — Isolate worktree collection is ownership-scoped

**Status**: accepted (2026-09-11)
**Context**: `subagent(action: "spawn", isolate: true)` creates a worktree under
`~/.herdr/worktrees/<repo>/pier-<slug>` on branch `pier/<slug>`. Collection of those
worktrees runs from every pier master session (`isolateSweep` in `subagent-gc.ts`,
driven by the 30s GC ticker and by `turn_start`).

## Problem

The first implementation treated **every** branch under `refs/heads/pier/` as
pier-owned. It skipped branches present in the running session's subagent registry and
then collected anything else whose worktree was "merged into HEAD and clean".

That rule is wrong for the same reason it is tempting: a pier subagent runs *inside*
such a worktree, and in its own session the branch it is standing on is trivially an
ancestor of its own `HEAD`. So a worker that committed everything (clean tree) matched
"merged + clean" and the sweep deleted the directory the process was running in.

Observed twice on 2026-09-11: the poll-loop worker lost its worktree mid-run, and the
docs worker only survived because it kept an unrelated dirty file. A third worker's
manifest change was silently disabled as a knock-on effect.

## Decision

1. Only branches registered in the **current session's** subagent registry are
   candidates. Untracked `pier/*` branches belong to another session, another
   worktree, or a human, and are left alone.
2. The process working directory is never a candidate (`planIsolateSweep` filters it;
   the removal path re-checks before `git worktree remove`).
3. Sweeping unregistered branches requires an explicit opt-in:
   `PIER_ISOLATE_SWEEP_ORPHANS=1`.
4. The candidate rules live in `gc-core.ts#planIsolateSweep` as a pure function so the
   ownership matrix is unit-tested instead of re-derived at the call site.

Consequence: genuinely orphaned worktrees (branch left behind by a session whose
registry never replayed) are no longer collected automatically. They remain visible in
`git worktree list` and produce the existing "retained — merge or remove manually"
notice, which is the correct trade for never deleting live work.
