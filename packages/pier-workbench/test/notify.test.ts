import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNotificationParams, VALID_NOTIFICATION_SOUNDS } from '../src/notify.ts';

test('buildNotificationParams: valid pi blocked event produces correct notification.show params', () => {
  const event = {
    type: 'pane.agent_status_changed',
    data: {
      agent: 'pi',
      agent_status: 'blocked',
      pane_id: 'pane-42',
      title: 'Waiting for approval',
    },
  };

  const params = buildNotificationParams(event);
  assert.ok(params !== null);
  assert.equal(params.title, 'Subagent blocked: pi');
  assert.equal(params.body, 'Pane pane-42 needs a human decision — Waiting for approval');
  assert.equal((params as Record<string, unknown>).message, undefined, 'must use body, not message');
  assert.equal(params.sound, 'request');
  assert.ok(VALID_NOTIFICATION_SOUNDS.has(params.sound!));
});

test('buildNotificationParams: sound option allows valid enum values and falls back for invalid', () => {
  const event = {
    type: 'pane.agent_status_changed',
    data: { agent: 'pi', agent_status: 'blocked', pane_id: 'p1' },
  };

  const doneParams = buildNotificationParams(event, { soundOverride: 'done' });
  assert.equal(doneParams?.sound, 'done');

  const noneParams = buildNotificationParams(event, { soundOverride: 'none' });
  assert.equal(noneParams?.sound, 'none');

  const invalidParams = buildNotificationParams(event, { soundOverride: 'invalid_sound' });
  assert.equal(invalidParams?.sound, 'request');
});

test('buildNotificationParams: gate rejects non-pi agents', () => {
  const claudeEvent = {
    type: 'pane.agent_status_changed',
    data: { agent: 'claude', agent_status: 'blocked', pane_id: 'p1' },
  };
  assert.equal(buildNotificationParams(claudeEvent), null);

  const emptyAgentEvent = {
    type: 'pane.agent_status_changed',
    data: { agent: null, agent_status: 'blocked', pane_id: 'p1' },
  };
  assert.equal(buildNotificationParams(emptyAgentEvent), null);
});

test('buildNotificationParams: gate rejects non-blocked states', () => {
  for (const status of ['working', 'idle', 'unknown', 'ready']) {
    const event = {
      type: 'pane.agent_status_changed',
      data: { agent: 'pi', agent_status: status, pane_id: 'p1' },
    };
    assert.equal(buildNotificationParams(event), null, `status ${status} must be gated out`);
  }
});

test('buildNotificationParams: handles missing or unusual fields gracefully', () => {
  assert.equal(buildNotificationParams(null), null);
  assert.equal(buildNotificationParams(undefined), null);
  assert.equal(buildNotificationParams('string-event'), null);
  assert.equal(buildNotificationParams({ type: 'other.event' }), null);
  assert.equal(buildNotificationParams({ type: 'pane.agent_status_changed' }), null);

  // Missing title
  const noTitle = buildNotificationParams({
    type: 'pane.agent_status_changed',
    data: { agent: 'pi', agent_status: 'blocked', pane_id: 'p99' },
  });
  assert.equal(noTitle?.body, 'Pane p99 needs a human decision');

  // Missing pane_id falls back to '?'
  const noPane = buildNotificationParams({
    type: 'pane.agent_status_changed',
    data: { agent: 'pi', agent_status: 'blocked' },
  });
  assert.equal(noPane?.body, 'Pane ? needs a human decision');

  // Numeric pane_id converted to string
  const numPane = buildNotificationParams({
    type: 'pane.agent_status_changed',
    data: { agent: 'pi', agent_status: 'blocked', pane_id: 123 },
  });
  assert.equal(numPane?.body, 'Pane 123 needs a human decision');
});
