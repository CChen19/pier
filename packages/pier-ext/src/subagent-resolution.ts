/**
 * Subagent task-id lookup rules.
 *
 * Kept separate from the Cordis plugin so prefix resolution remains usable without mounting the
 * master tree and can be verified independently from pane lifecycle code.
 */

export type TaskIdResolutionResult =
  | { kind: 'resolved'; taskId: string }
  | { kind: 'ambiguous'; query: string; candidates: string[] }
  | { kind: 'too_short'; query: string }
  | { kind: 'not_found'; query: string };

/**
 * Resolve a full or short task ID against known candidates.
 *
 * Exact matches are accepted regardless of length. Prefix matching requires four characters and
 * rejects ambiguity with a sorted candidate list.
 */
export function resolveTaskIdPrefix(
  query: string,
  candidates: Iterable<string>,
): TaskIdResolutionResult {
  const trimmed = query.trim();
  if (!trimmed) return { kind: 'not_found', query: trimmed };

  const unique = Array.from(new Set(candidates));
  const exact = unique.find((candidate) => candidate === trimmed);
  if (exact) return { kind: 'resolved', taskId: exact };

  if (trimmed.length < 4) return { kind: 'too_short', query: trimmed };

  const lower = trimmed.toLowerCase();
  const matches = unique.filter((candidate) => candidate.toLowerCase().startsWith(lower));
  if (matches.length === 1) return { kind: 'resolved', taskId: matches[0]! };
  if (matches.length > 1) {
    matches.sort();
    return { kind: 'ambiguous', query: trimmed, candidates: matches };
  }
  return { kind: 'not_found', query: trimmed };
}
