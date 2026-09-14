/**
 * A1: pi only marks a tool result as failed when `execute()` throws — "Returning a value never sets
 * the error flag regardless of what properties you include in the return object"
 * (pi docs/extensions.md, "Signaling errors").
 *
 * The round-2 audit found 20+ real failures in pier's tools returned as plain text, so neither the
 * model nor pi's own hooks keyed on `event.isError` could see them (pier's B1 "subagent alive but
 * reported no output" self-heal was dead code for exactly that reason). Every hard failure now goes
 * through `toolError()`; deliberate non-failures (empty result set, "no match within Xms", a pane
 * that simply has not produced output yet) stay normal results.
 *
 * The "Error: " prefix the old text returns carried is dropped: the provider's tool-result error
 * channel and pi's red rendering already mark it, and keeping it would double the prefix once pi
 * formats a thrown error.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(String(message).replace(/^Error:\s*/, ''));
    this.name = 'ToolError';
  }
}

/** Throw a tool failure (never returns). */
export function toolError(message: string): never {
  throw new ToolError(message);
}
