import { execFile as nodeExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runtimePolicy } from './runtime-policy.ts'

const execFile = promisify(nodeExecFile)

export interface GitResult {
  readonly stdout: string
  readonly stderr: string
}

export interface GitError extends Error {
  readonly code?: string | number
  readonly stdout?: string
  readonly stderr?: string
}

/**
 * Injectable execFile used by NodeGitAdapter.
 * Why: tests drive git without a real process.
 */
export type GitExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; encoding: 'utf8'; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Output ceiling for one git call. `execFile` defaults to 1MB, which a large checkout exceeds
 * (`status --porcelain` on a repo with tens of thousands of untracked files, or `diff --stat`
 * across a wide change): the call then fails with ENOBUFS, callers normalize it to null, and the
 * user sees a silently missing stat line — or "failed to create worktree" for a worktree that was
 * in fact created. 64MB bounds memory without hitting realistic repositories.
 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Minimal Git adapter for worktree and status operations.
 *
 * Why: Centralizes platform-specific git executable resolution, timeout policy,
 * and error normalization; makes tests independent of real git processes.
 */
export interface GitAdapter {
  /**
   * List worktrees in porcelain format.
   * Returns stdout containing worktree entries.
   */
  listWorktrees(cwd: string): Promise<GitResult>

  /**
   * Get status of worktree in short format.
   * Returns stdout containing status entries.
   */
  status(cwd: string): Promise<GitResult>

  /**
   * Run an arbitrary git command in `cwd` (`git -C <cwd> ...args`).
   * Throws a GitError on failure/timeout — callers that want "null on error"
   * (isolate sweep, placement) catch at the call site.
   */
  run(cwd: string, args: readonly string[]): Promise<GitResult>
}
export class NodeGitAdapter implements GitAdapter {
  private readonly gitExecutable: string
  private readonly timeoutMs: number
  private readonly exec: GitExecFile

  constructor(
    gitExecutable: string = 'git',
    timeoutMs: number = runtimePolicy.gitTimeoutMs,
    exec: GitExecFile = execFile as unknown as GitExecFile,
  ) {
    this.gitExecutable = gitExecutable
    this.timeoutMs = timeoutMs
    this.exec = exec
  }

  listWorktrees(cwd: string): Promise<GitResult> {
    return this.run(cwd, ['worktree', 'list', '--porcelain'])
  }

  status(cwd: string): Promise<GitResult> {
    return this.run(cwd, ['status', '--short'])
  }

  async run(cwd: string, args: readonly string[]): Promise<GitResult> {
    try {
      const { stdout, stderr } = await this.exec(
        this.gitExecutable,
        ['-C', cwd, ...args],
        { timeout: this.timeoutMs, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER },
      )
      return { stdout, stderr }
    } catch (err) {
      throw this.normalizeError(err, args[0] ?? 'command')
    }
  }

  private normalizeError(err: unknown, operation: string): GitError {
    if (err instanceof Error) {
      const gitError = err as GitError
      gitError.message = `Git ${operation} failed: ${gitError.message}`
      return gitError
    }
    return new Error(`Git ${operation} failed: ${String(err)}`) as GitError
  }
}

/**
 * Default production git adapter.
 * Tests should inject fake implementations or a fake exec.
 */
export const defaultGitAdapter = new NodeGitAdapter()
