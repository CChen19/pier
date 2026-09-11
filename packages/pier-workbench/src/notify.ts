/**
 * Notification payload builder for Herdr notification.show API.
 *
 * Constructs validated notification parameters for subagent state transitions.
 * Conforms to Herdr 0.9.0 protocol 22 NotificationShowParams schema:
 *   { title: string, body?: string | null, position?: ToastHerdrPosition | null, sound?: NotificationShowSound }
 * NotificationShowSound enum: 'none' | 'done' | 'request'
 */

export interface NotificationShowParams {
  title: string;
  body?: string | null;
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | null;
  sound?: 'none' | 'done' | 'request';
}

export const VALID_NOTIFICATION_SOUNDS = new Set<string>(['none', 'done', 'request']);

export interface NotificationOptions {
  soundOverride?: string;
}

/**
 * Validates agent status event and constructs parameters for notification.show.
 * Returns null if the event should be gated out or is malformed.
 *
 * Tight gate: only agents where agent === 'pi' and agent_status === 'blocked' are notified.
 */
export function buildNotificationParams(
  rawEvent: unknown,
  options?: NotificationOptions
): NotificationShowParams | null {
  if (!rawEvent || typeof rawEvent !== 'object') return null;
  const ev = rawEvent as Record<string, unknown>;
  if (ev.type !== 'pane.agent_status_changed') return null;

  const data = (ev.data && typeof ev.data === 'object') ? (ev.data as Record<string, unknown>) : null;
  if (!data) return null;

  // Gate: only pi agents managed by pier
  if (data.agent !== 'pi') return null;

  // Gate: only human-decision blocked state transitions
  if (data.agent_status !== 'blocked') return null;

  const agentName = typeof data.agent === 'string' && data.agent ? data.agent : 'agent';
  const title = `Subagent blocked: ${agentName}`;

  const paneId = typeof data.pane_id === 'string' && data.pane_id.trim()
    ? data.pane_id.trim()
    : (typeof data.pane_id === 'number' ? String(data.pane_id) : '?');

  const titleSuffix = typeof data.title === 'string' && data.title.trim()
    ? ` — ${data.title.trim()}`
    : '';

  const body = `Pane ${paneId} needs a human decision${titleSuffix}`;

  const soundCandidate = options?.soundOverride ?? process.env.HERDR_NOTIFICATION_SOUND;
  const sound: 'none' | 'done' | 'request' = (soundCandidate && VALID_NOTIFICATION_SOUNDS.has(soundCandidate))
    ? (soundCandidate as 'none' | 'done' | 'request')
    : 'request';

  return {
    title,
    body,
    sound,
  };
}
