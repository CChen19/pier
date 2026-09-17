import type { HerdrClientLike, HerdrEnv } from './herdr-client.ts';
import type { TodoItem } from './vocab.ts';

export interface DashboardCommandDeps {
  pi: {
    registerCommand(name: string, options: { description: string; handler: (args: unknown, ctx: unknown) => Promise<void> }): void;
  };
  client: HerdrClientLike;
  env: HerdrEnv | null;
  getTodoItems?: () => readonly TodoItem[];
  getHeldLocks?: () => readonly string[];
}

export function formatStandaloneDashboard(opts: {
  todos: readonly TodoItem[];
  locks: readonly string[];
  now?: number;
}): string {
  const lines: string[] = [];
  const timeStr = new Date(opts.now ?? Date.now()).toTimeString().split(' ')[0] ?? '';
  lines.push(`==================== PIER OPS DASHBOARD ==================== [${timeStr}] (standalone)`);
  lines.push('Mode: Standalone (Non-Herdr / Local Session)');
  lines.push('--------------------------------------------------------------------------------');

  const todos = opts.todos;
  if (todos.length > 0) {
    const inProg = todos.filter((t) => t.status === 'in_progress');
    const blocked = todos.filter((t) => t.status === 'blocked');
    const done = todos.filter((t) => t.status === 'completed');
    const pending = todos.filter((t) => t.status === 'pending');
    lines.push(
      `Todos: ${todos.length} total (${done.length} done, ${inProg.length} working, ${blocked.length} blocked, ${pending.length} pending)`,
    );
    if (inProg.length > 0) {
      lines.push(`Active: ▶ ${inProg.map((t) => t.content).join(', ')}`);
    }
    if (blocked.length > 0) {
      lines.push(`Blocked: ■ ${blocked.map((t) => `${t.content}${t.blocker ? ` (${t.blocker})` : ''}`).join(', ')}`);
    }
    if (inProg.length === 0 && blocked.length === 0 && done.length > 0) {
      lines.push(`Completed: ✓ ${done.slice(-3).map((t) => t.content).join(', ')}`);
    }
  } else {
    lines.push('Todos: (none)');
  }

  const locks = opts.locks;
  lines.push(`Write Locks: ${locks.length > 0 ? locks.join(', ') : '(none)'}`);
  lines.push('--------------------------------------------------------------------------------');
  lines.push('Tip: Inside Herdr 0.9.1, /dashboard opens the interactive modal popup.');
  lines.push('================================================================================');
  return lines.join('\n');
}

export function installDashboardCommand(deps: DashboardCommandDeps): void {
  deps.pi.registerCommand('dashboard', {
    description: 'Open the Pier Ops Dashboard (modal popup in Herdr 0.9.1, tab fallback, or local TUI view)',
    handler: async (_args, ctx) => {
      const ui = (ctx as { ui?: { notify?: (text: string, level?: string) => void } }).ui;

      // Level 1 / Level 2: Herdr environment
      if (deps.client.available && deps.env) {
        try {
          const res = await deps.client.openPluginPane({
            pluginId: 'pier.workbench',
            entrypoint: 'dashboard',
            placement: 'popup',
            width: '80%',
            height: '80%',
            focus: true,
          });
          if (res.mode === 'fallback_tab') {
            ui?.notify?.('Herdr < 0.9.1: Pier Dashboard opened in new tab', 'info');
          }
          return;
        } catch {
          // If plugin is not installed or socket error occurs, fall through to Level 3 local view
        }
      }

      // Level 3: Standalone / Non-Herdr fallback
      const text = formatStandaloneDashboard({
        todos: deps.getTodoItems?.() ?? [],
        locks: deps.getHeldLocks?.() ?? [],
      });
      ui?.notify?.(text, 'info');
    },
  });
}
