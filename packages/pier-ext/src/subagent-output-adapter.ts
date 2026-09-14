/**
 * Herdr output-read adapter for subagents.
 *
 * Newer herdr exposes agent.read; older versions only expose pane.read. Prefer the semantic agent
 * endpoint and fall back to the pane endpoint so output observation stays version-compatible.
 */
import type { HerdrClientLike } from './herdr-client.ts';

export interface SubagentOutputRead {
  text: string;
  revision: number;
  truncated: boolean;
}

export async function readSubagentOutput(
  client: HerdrClientLike,
  paneId: string,
): Promise<SubagentOutputRead> {
  if (typeof client.readAgent === 'function') {
    try {
      return await client.readAgent(paneId, { source: 'recent', stripAnsi: true });
    } catch {
      return await client.readPane(paneId, { source: 'recent', stripAnsi: true });
    }
  }
  return await client.readPane(paneId, { source: 'recent', stripAnsi: true });
}
