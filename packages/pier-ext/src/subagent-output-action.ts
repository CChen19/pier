import type { HerdrAgentState, HerdrClientLike } from './herdr-client.ts';
import type { SubEntry } from './subagent-core.ts';
import {
  computeSubagentOutputDelta,
  formatSubagentOutput,
  resolveSubagentStatus,
  type SubagentOutputCursor,
} from './subagent-output-core.ts';
import { readSubagentOutput } from './subagent-output-adapter.ts';
import { toolError } from './tool-error.ts';

export interface OutputActionParams {
  agentId?: unknown;
  taskId?: unknown;
  max_chars?: unknown;
  maxChars?: unknown;
}

export interface OutputActionResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
}

export interface OutputActionDeps {
  client: HerdrClientLike;
  resolveEntry: (rawId: string, cwd: string) => { entry: SubEntry } | { error: string };
  readAskFlag: (paneId: string) => Promise<string | null>;
  outputCursors: Map<string, SubagentOutputCursor>;
  getCwd: (toolCtx: unknown) => string;
}

export async function executeSubagentOutput(
  params: OutputActionParams | undefined,
  toolCtx: unknown,
  deps: OutputActionDeps,
): Promise<OutputActionResult> {
  const rawId = String(params?.agentId ?? params?.taskId ?? '').trim();
  if (!rawId) return toolError('Error: missing agentId for output (see action list)') as OutputActionResult;

  const cwd = deps.getCwd(toolCtx);
  const resolved = deps.resolveEntry(rawId, cwd);
  if ('error' in resolved) return toolError(resolved.error) as OutputActionResult;

  const entry = resolved.entry;
  let agentState: HerdrAgentState | null = null;
  let askFlag: string | null = null;
  try {
    const agents = await deps.client.listAgents();
    const agent = agents.find((candidate) => candidate.paneId === entry.paneId);
    agentState = agent?.status ?? null;
    askFlag = agent?.tokens?.['pi-ask'] ?? null;
  } catch {
    /* Best effort: output remains useful without live status. */
  }
  if (!askFlag && agentState === 'blocked') {
    try {
      askFlag = await deps.readAskFlag(entry.paneId);
    } catch {
      /* Best effort. */
    }
  }

  const status = resolveSubagentStatus({
    localStatus: entry.status,
    herdrStatus: agentState,
    hasAskFlag: Boolean(askFlag),
  });

  let rawRead: { text: string; revision: number; truncated: boolean };
  try {
    rawRead = await readSubagentOutput(deps.client, entry.paneId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(`Error: failed to read output for subagent ${entry.paneId}: ${message}`) as OutputActionResult;
  }

  const prevCursor = deps.outputCursors.get(entry.paneId);
  const maxChars = typeof params?.max_chars === 'number'
    ? params.max_chars
    : typeof params?.maxChars === 'number' ? params.maxChars : undefined;
  const deltaResult = computeSubagentOutputDelta(prevCursor, rawRead.text, { maxChars });
  deps.outputCursors.set(entry.paneId, deltaResult.nextCursor);

  const formatted = formatSubagentOutput({
    paneId: entry.paneId,
    status,
    revision: rawRead.revision,
    bufferTruncated: rawRead.truncated,
    deltaResult,
    askQuestion: askFlag,
  });

  return {
    content: [{ type: 'text', text: formatted }],
    details: {
      paneId: entry.paneId,
      status,
      revision: rawRead.revision,
      truncated: rawRead.truncated || deltaResult.truncated,
      restart: deltaResult.restart,
      deltaLength: deltaResult.delta.length,
    },
  };
}
