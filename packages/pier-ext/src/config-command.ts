/**
 * D104 `/pier-config` command registration.
 *
 * Read-only by design: the command reports effective values with their provenance and
 * hands the actual edit to the agent under the existing write-lock + diff-confirmation
 * flow. It never writes configuration itself (only the opt-in `doc` report).
 *
 * Subcommands: (none) | show [plane|all] | check | doc [path]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { VERSION as PI_VERSION } from '@earendil-works/pi-coding-agent';
import { CONFIG_PLANES, type ConfigPlaneId } from './config-catalog-core.ts';
import {
  CONFIG_GUIDANCE_PROMPT,
  collectConfigSnapshot,
  guideCheckLines,
  guideIndexLines,
  guidePlaneLines,
  guideReportMarkdown,
  type ConfigGuideDeps,
  type ConfigGuideSnapshot,
} from './config-guide.ts';
import { formatOptionRows } from './pier-options.ts';
import { formatSwallowedErrors } from './swallow.ts';

export const CONFIG_COMMAND_NAME = 'pier-config';
export const CONFIG_GUIDE_CUSTOM_TYPE = 'pi-herdr.config-guide';
export const CONFIG_REPORT_FILENAME = 'config-report.md';
export const CONFIG_REPORT_DIR = '.pi-herdr';

const PLANE_IDS: readonly ConfigPlaneId[] = CONFIG_PLANES.map((p) => p.id);
const SUBCOMMANDS = ['show', 'check', 'doc', 'doctor'] as const;

export interface ConfigCommandDeps {
  pi: ExtensionAPI;
  /** Injectable for tests; defaults to collectConfigSnapshot. */
  collect?: (deps: ConfigGuideDeps) => ConfigGuideSnapshot;
  /** Overridable so tests can pin the report destination. */
  reportDir?: (cwd: string) => string;
}

function isPlaneId(value: string): value is ConfigPlaneId {
  return (PLANE_IDS as readonly string[]).includes(value);
}

function parseArgs(args: unknown): { sub: (typeof SUBCOMMANDS)[number] | 'index'; rest: string } {
  const raw = typeof args === 'string'
    ? args.split(/\s+/).filter(Boolean)
    : Array.isArray(args) ? args.map(String) : [];
  const [first, ...rest] = raw;
  const sub = (SUBCOMMANDS as readonly string[]).includes(first ?? '')
    ? (first as (typeof SUBCOMMANDS)[number])
    : 'index';
  // `show` accepts an optional plane; an unknown first token is treated as the plane selector for `show`.
  const restJoined = sub === 'index' && first && first !== 'index' ? [first, ...rest].join(' ') : rest.join(' ');
  return { sub, rest: restJoined };
}

/** Registers `/pier-config`. Safe to call once per extension load (pi replaces commands by name). */
export function installConfigCommand(deps: ConfigCommandDeps): void {
  const { pi } = deps;
  const collect = deps.collect ?? collectConfigSnapshot;
  const reportDir = deps.reportDir ?? ((cwd: string) => join(cwd, CONFIG_REPORT_DIR));

  pi.registerCommand(CONFIG_COMMAND_NAME, {
    description:
      'Show pier configuration (5 planes) with effective values and sources; `check` validates them; `doctor` lists option values and swallowed errors; no argument hands a guided change to the agent',
    getArgumentCompletions: (prefix: string) => {
      const tokens = (prefix ?? '').split(/\s+/);
      const head = tokens[0] ?? '';
      if (tokens.length <= 1) {
        const candidates = ['show', 'check', 'doc', 'doctor', 'all', ...PLANE_IDS];
        return candidates
          .filter((c) => c.startsWith(head))
          .map((c) => ({ value: c, label: c, description: c === 'doc' ? 'write a config report file' : undefined }));
      }
      if (head === 'show') {
        const last = tokens[tokens.length - 1] ?? '';
        return ['all', ...PLANE_IDS]
          .filter((c) => c.startsWith(last))
          .map((c) => ({ value: c, label: c }));
      }
      return null;
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      const ui = (ctx as { ui?: { notify?: (text: string, level?: string) => void } }).ui;
      const emit = (text: string, level: 'info' | 'warning' | 'error' = 'info'): void => {
        if (ui?.notify) ui.notify(text, level);
        else console.log(text); // print/json and test modes have no UI surface
      };

      const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
      const isProjectTrusted =
        typeof (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted === 'function'
          ? (ctx as { isProjectTrusted: () => boolean }).isProjectTrusted()
          : false;

      let snapshot: ConfigGuideSnapshot;
      try {
        snapshot = collect({ cwd, isProjectTrusted });
      } catch (err) {
        emit(`pier-config: failed to read configuration (${err instanceof Error ? err.message : String(err)})`, 'error');
        return;
      }

      const { sub, rest } = parseArgs(args);

      if (sub === 'check') {
        emit([`pier config check (workspace trusted: ${snapshot.workspaceTrusted})`, ...guideCheckLines(snapshot)].join('\n'));
        return;
      }

      if (sub === 'doc') {
        const target = rest
          ? (isAbsolute(rest) ? rest : resolve(cwd, rest))
          : join(reportDir(cwd), CONFIG_REPORT_FILENAME);
        try {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(
            target,
            guideReportMarkdown(snapshot, { generatedAt: new Date().toISOString(), cwd, piVersion: PI_VERSION }),
            'utf8',
          );
          emit(
            `pier config report written: ${target}` +
              (rest ? '' : '  (add `.pi-herdr/config-report.md` to .gitignore if you do not want it tracked)'),
          );
        } catch (err) {
          emit(`pier-config: could not write report (${err instanceof Error ? err.message : String(err)})`, 'error');
        }
        return;
      }

      if (sub === 'doctor') {
        // B9/B10: one place to see every pier option (canonical name, effective value, source) and the
        // errors that were deliberately swallowed this session. Without it, a silently failing
        // best-effort path stays invisible until something else breaks.
        emit(
          [
            'pier doctor',
            '',
            `options (canonical PIER_*, legacy PI_HDR_* alias accepted):`,
            ...formatOptionRows(),
            '',
            formatSwallowedErrors(),
          ].join('\n'),
        );
        return;
      }

      if (sub === 'show') {
        const plane = rest.trim();
        const selector = plane === '' || plane === 'all' ? 'all' : isPlaneId(plane) ? plane : null;
        if (selector === null) {
          emit(`pier-config: unknown plane "${plane}" — expected one of ${PLANE_IDS.join(', ')} or all`, 'warning');
          return;
        }
        emit(guidePlaneLines(snapshot, selector).join('\n'));
        return;
      }

      // Bare `/pier-config`: index + hand the guided change to the agent.
      emit([...guideIndexLines(snapshot), '', 'asking the agent to guide the change...'].join('\n'));
      try {
        // Call on the receiver: the ExtensionAPI method must not be detached from `pi`.
        (pi as { sendMessage?: (msg: unknown, opts: unknown) => void }).sendMessage?.(
          { customType: CONFIG_GUIDE_CUSTOM_TYPE, content: CONFIG_GUIDANCE_PROMPT, display: false },
          { triggerTurn: true },
        );
      } catch (err) {
        emit(`pier-config: could not start the guided flow (${err instanceof Error ? err.message : String(err)})`, 'warning');
      }
    },
  });
}
