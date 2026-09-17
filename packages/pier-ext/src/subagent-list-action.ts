import { basename } from 'node:path';
import { agoText, type AliveProbe, type SubEntry } from './subagent-core.ts';

export interface ListActionResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
}

export interface ListActionDeps {
  subs: () => Iterable<SubEntry>;
  probeAlive: (paneId: string, cwd: string) => Promise<AliveProbe>;
  readAskFlag: (paneId: string) => Promise<string | null>;
  now?: () => number;
}

/** Render the live background registry without coupling it to Cordis or the tool registration. */
export async function executeSubagentList(deps: ListActionDeps): Promise<ListActionResult> {
  const listed = [...deps.subs()].filter((sub) => sub.background);
  if (listed.length === 0) {
    return {
      content: [{ type: 'text', text: 'No background subagents started (from this session branch).' }],
      details: {},
    };
  }

  const byTask = new Map<string, SubEntry>();
  for (const sub of listed) {
    const previous = byTask.get(sub.taskId);
    if (!previous || sub.createdAt >= previous.createdAt) byTask.set(sub.taskId, sub);
  }

  const probes = new Map<string, AliveProbe>();
  await Promise.all([...byTask.values()].map(async (sub) => {
    if (sub.status === 'closed') return;
    try {
      probes.set(sub.paneId, await deps.probeAlive(sub.paneId, sub.cwd));
    } catch {
      /* Best effort for display. */
    }
  }));

  const now = deps.now ?? Date.now;
  const lines: string[] = [];
  for (const sub of byTask.values()) {
    const tabTag = sub.tabName ? ` [tab: ${sub.tabName}]` : '';
    const wtTag = sub.isolate ? ` [wt: ${sub.isolate.branch}]` : '';
    if (sub.status === 'closed') {
      lines.push(`${sub.taskId.slice(0, 8)} [idle] (${sub.kind}, closed; action send revives)${tabTag}${wtTag} ${sub.description}`);
      continue;
    }

    const state = sub.status === 'settled' ? 'idle' : 'running';
    const takeoverMark = sub.userTakeover ? ', user-controlled' : '';
    const probe = probes.get(sub.paneId);
    const statusTag = probe?.agentStatus ? ` ${probe.agentStatus}` : '';
    const activityTag = probe?.lastActivityMs != null ? `, active ${agoText(probe.lastActivityMs, now())}` : '';
    let gateTag = '';
    if (probe?.agentStatus === 'blocked') {
      const question = await deps.readAskFlag(sub.paneId);
      gateTag = question ? ` — AWAITING HUMAN: "${question}"` : ' — AWAITING HUMAN decision';
    }
    const cwdTag = probe?.foregroundCwd && probe.foregroundCwd !== sub.cwd
      ? ` [cwd: ${basename(probe.foregroundCwd) || probe.foregroundCwd}]`
      : '';
    lines.push(`${sub.paneId} [${state}${takeoverMark}${statusTag}${activityTag}${gateTag}] (${sub.kind})${tabTag}${wtTag}${cwdTag} ${sub.description}`);
  }

  return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
}
