export type ToolName = "read_file" | "search_text" | "list_directory" | "git_status" | "git_diff" | "run_command";

export interface ToolAction {
  id: string;
  tool: ToolName;
  args: Record<string, string | number>;
  description: string;
}

export interface CommandSpec {
  id: string;
  description: string;
  argv: string[];
  timeoutMs: number;
}

export interface RunnerConfig {
  commands: CommandSpec[];
  maxSteps: number;
  timeoutMs: number;
  maxCandidates: number;
}

export interface Observation {
  step: number;
  action: ToolAction;
  output: string;
  exitCode: number | null;
  truncated: boolean;
  durationMs: number;
  workspaceRevision: string;
  nextLine?: number;
}

export interface WorkspaceSnapshot {
  files: string[];
  revision: string;
  truncated: boolean;
}

export interface Decision {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  model: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface DecisionInput {
  goal: string;
  snapshot: WorkspaceSnapshot;
  actions: ToolAction[];
  observations: Observation[];
  remainingSteps: number;
}

export interface Decider {
  decide(input: DecisionInput, signal: AbortSignal): Promise<Decision>;
}

export interface DecisionEvent extends Decision {
  step: number;
  availableActions: number;
  action?: ToolAction;
}

export type RunStatus = "returned_results" | "needs_coding_agent" | "step_limit" | "time_limit" | "cancelled" | "error";

export interface RunResult {
  status: RunStatus;
  goal: string;
  workspace: string;
  observations: Observation[];
  decisions: DecisionEvent[];
  message: string;
  metrics: {
    totalMs: number;
    decisionMs: number;
    toolMs: number;
    hostMs: number;
    decisionCalls: number;
    toolCalls: number;
    generativeModelCalls: 0;
    inputTokens: number;
    outputTokens: number;
  };
}

export const DEFAULT_CONFIG: RunnerConfig = {
  commands: [],
  maxSteps: 10,
  timeoutMs: 90_000,
  maxCandidates: 96,
};
