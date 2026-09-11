/**
 * Agent view registration builder for Herdr sidebar.
 *
 * Conforms to Herdr 0.9.0 protocol 22 `agent.view.set` schema.
 * Registers a dedicated sidebar view targeting pier-managed panes
 * (identified by presence of the `pi-todo` token).
 */

export interface AgentViewFieldToken {
  token: string;
}

export type AgentViewBuiltinField =
  | 'status'
  | 'workspace_id'
  | 'tab_id'
  | 'pane_id'
  | 'agent'
  | 'seen'
  | 'state_change_seq';

export type AgentViewField = AgentViewBuiltinField | AgentViewFieldToken;

export type AgentViewBuiltinSortField =
  | 'workspace_order'
  | 'tab_order'
  | 'pane_order'
  | 'attention'
  | 'status'
  | 'agent'
  | 'seen'
  | 'state_change_seq';

export type AgentViewSortField = AgentViewBuiltinSortField | AgentViewFieldToken;

export interface AgentViewSort {
  field: AgentViewSortField;
  order?: 'asc' | 'desc';
}

export type AgentViewFilter =
  | { op: 'all'; filters: AgentViewFilter[] }
  | { op: 'any'; filters: AgentViewFilter[] }
  | { op: 'not'; filter: AgentViewFilter }
  | { op: 'exists'; field: AgentViewField }
  | { op: 'eq'; field: AgentViewField; value: string | boolean | number }
  | { op: 'in'; field: AgentViewField; values: Array<string | boolean | number> };

export interface AgentViewSetParams {
  source: string;
  label?: string | null;
  filter?: AgentViewFilter | null;
  sort?: AgentViewSort[];
}

export interface BuildAgentViewOptions {
  source?: string;
  label?: string;
  tokenKey?: string;
}

/**
 * Builds validated parameters for agent.view.set.
 * Defaults to filtering panes with the `pi-todo` token and sorting by attention.
 */
export function buildAgentViewSetParams(options?: BuildAgentViewOptions): AgentViewSetParams {
  const source = options?.source ?? 'pier.workbench';
  const label = options?.label ?? 'Pier';
  const tokenKey = options?.tokenKey ?? 'pi-todo';

  return {
    source,
    label,
    filter: {
      op: 'exists',
      field: { token: tokenKey },
    },
    sort: [
      { field: 'attention', order: 'desc' },
      { field: 'pane_order', order: 'asc' },
    ],
  };
}
