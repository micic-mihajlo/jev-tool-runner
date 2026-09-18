import { redact } from "./config.js";
import { HANDOFF, RETURN } from "./jev.js";
import type { Decider, DecisionEvent, Observation, RunnerConfig, RunResult, RunStatus } from "./types.js";
import { Workspace } from "./workspace.js";

export async function runTools(options: {
  goal: string;
  workspace: Workspace;
  decider: Decider;
  config: RunnerConfig;
  commandIds?: string[];
  signal?: AbortSignal;
  onDecision?: (event: DecisionEvent) => void;
}): Promise<RunResult> {
  const { workspace, decider, config } = options;
  const goal = options.goal.trim();
  if (!goal || goal.length > 4000) throw new Error("Goal must contain 1–4000 characters.");
  const requestedCommands = options.commandIds;
  const commandActions = workspace.commandActions();
  if (requestedCommands && (!requestedCommands.length || requestedCommands.length > config.maxSteps
      || new Set(requestedCommands).size !== requestedCommands.length
      || requestedCommands.some((id) => !commandActions.some((action) => action.args.commandId === id)))) {
    throw new Error("commandIds must contain unique configured command IDs within the server's step budget.");
  }
  const started = performance.now();
  const deadline = AbortSignal.timeout(config.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const observations: Observation[] = [];
  const decisions: DecisionEvent[] = [];
  let status: RunStatus = "step_limit";
  let message = "Tool-step budget reached. The coding agent receives the collected observations.";
  let attemptedDecisions = 0;
  let decisionMs = 0;
  try {
    for (let step = 0; step < (requestedCommands?.length ?? config.maxSteps); step++) {
      signal.throwIfAborted();
      const snapshot = requestedCommands ? { files: [], revision: "direct-command", truncated: false } : await workspace.snapshot(signal);
      let selected = requestedCommands ? commandActions.find((action) => action.args.commandId === requestedCommands[step]) : undefined;
      if (!requestedCommands) {
        const actions = workspace.candidates(goal, snapshot, observations, config.maxCandidates);
        attemptedDecisions++;
        const decisionStarted = performance.now();
        let decision;
        try {
          decision = await decider.decide({ goal, snapshot, actions, observations, remainingSteps: config.maxSteps - step }, signal);
        } finally { decisionMs += performance.now() - decisionStarted; }
        signal.throwIfAborted();
        selected = actions.find((candidate) => candidate.id === decision.choice);
        if (!selected && decision.choice !== HANDOFF && !(decision.choice === RETURN && observations.length)) {
          throw new Error("Decision did not select an available action.");
        }
        const event: DecisionEvent = { ...decision, step, availableActions: actions.length, ...(selected ? { action: selected } : {}) };
        decisions.push(event);
        options.onDecision?.(event);
        if (decision.choice === HANDOFF || decision.choice === RETURN) {
          status = decision.choice === HANDOFF ? "needs_coding_agent" : "returned_results";
          message = status === "needs_coding_agent"
            ? "Jev returned control for code generation, reasoning, or a capability outside the configured tools. Use the observations to continue."
            : "Jev returned the collected tool results. Inspect exit codes and observations; this status is not a correctness verdict.";
          break;
        }
      }
      const toolStarted = performance.now();
      try {
        const result = await workspace.execute(selected!, snapshot, signal);
        observations.push({ step, action: selected!, workspaceRevision: snapshot.revision, ...result });
      } catch (error) {
        signal.throwIfAborted();
        observations.push({
          step, action: selected!, workspaceRevision: snapshot.revision,
          output: `Tool error: ${redact(error instanceof Error ? error.message : String(error))}`,
          exitCode: null, truncated: false, durationMs: Math.round(performance.now() - toolStarted),
        });
      }
    }
    if (requestedCommands) {
      status = "returned_results";
      message = "Executed the requested configured commands in order without model decisions. Inspect exit codes.";
    }
  } catch (error) {
    status = options.signal?.aborted ? "cancelled" : deadline.aborted ? "time_limit" : "error";
    message = status === "error"
      ? `Stopped without executing an unselected action: ${redact(error instanceof Error ? error.message : String(error))}`
      : status === "cancelled" ? "Run cancelled; collected observations are preserved." : "Run time budget reached; collected observations are preserved.";
  }
  const totalMs = Math.round(performance.now() - started);
  const toolMs = observations.reduce((sum, item) => sum + item.durationMs, 0);
  return {
    status, goal: redact(goal), workspace: workspace.root, observations, decisions, message,
    metrics: {
      totalMs, decisionMs: Math.round(decisionMs), toolMs,
      hostMs: Math.max(0, totalMs - Math.round(decisionMs) - toolMs),
      decisionCalls: attemptedDecisions, toolCalls: observations.length, generativeModelCalls: 0,
      inputTokens: decisions.reduce((sum, item) => sum + item.inputTokens, 0),
      outputTokens: decisions.reduce((sum, item) => sum + item.outputTokens, 0),
    },
  };
}
