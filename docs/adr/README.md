# Architecture Decision Records

Short WHY notes for load-bearing choices. Code is still the source of truth.

For a comprehensive index of D-series decisions cited in codebase comments, see [Design Decisions Index](../decisions.md).

| ID | Decision |
| --- | --- |
| [0001](0001-session-dir-encoding.md) | Collision-resistant session dir names with dual-read |
| [0002](0002-subagent-port.md) | Atomic `SubagentPort` instead of reverse callback slots |
| [0003](0003-user-roles-dir.md) | `userRolesDir` stays `~/.pi/agent/herdr-pi/roles` |
| [0004](0004-isolate-sweep-ownership.md) | Isolate worktree collection is ownership-scoped |

> Per-feature design notes and review records are development artifacts and stay **local**
> (see `.gitignore`): only this index and the project-level ADRs are tracked. Rationale for the
> efficiency mechanisms (D100–D103) and `/pier-config` (D104) lives in `docs/decisions.md`.
