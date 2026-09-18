import { runTools } from '../dist/controller.js';

export const resultSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, finding: { type: 'string' } }, required: ['path', 'finding'] } },
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { command: { type: 'string' }, exitCode: { type: 'integer' }, passed: { type: 'integer' }, failed: { type: 'integer' } }, required: ['command', 'exitCode', 'passed', 'failed'] } },
  }, required: ['summary', 'evidence', 'checks'],
};

export function checksFrom(observations, config) {
  const latest = new Map();
  for (const item of observations) {
    if (item.action.tool !== 'run_command') continue;
    const command = config.commands.find(({ id }) => id === item.action.args.commandId);
    if (!command) continue;
    latest.set(command.id, {
      command: command.argv.join(' '), exitCode: item.exitCode ?? -1,
      passed: Number(item.output.match(/(?:^|\n)[^\S\n]*(?:[#ℹ]\s*)?pass(?:ed)?\s+(\d+)/)?.[1] ?? 0),
      failed: Number(item.output.match(/(?:^|\n)[^\S\n]*(?:[#ℹ]\s*)?fail(?:ed)?\s+(\d+)/)?.[1] ?? 0),
    });
  }
  return [...latest.values()];
}

export function evidenceForCoder(sequences, currentRevision) {
  return sequences.flatMap(({ observations }) => observations.map(({ action, output, exitCode, truncated, nextLine, workspaceRevision }) => ({
    tool: action.tool, args: action.args, output, exitCode,
    ...(truncated ? { truncated } : {}), ...(nextLine ? { nextLine } : {}),
    ...(currentRevision && action.tool !== 'run_command' && workspaceRevision !== currentRevision
      ? { stale: true, output: 'Historical observation omitted because the workspace changed. Read current source if needed before editing.' } : {}),
  })));
}

export async function runSupervisedTask({ goal, workspace, config, decider, coder, signal, onSequence = () => {} }) {
  const sequences = [];
  let coderCalls = 0;
  let verificationIncomplete = false;
  const sequence = async (options) => {
    const result = await runTools({ workspace, config, decider, signal, ...options });
    sequences.push(result);
    await onSequence(result);
    return result;
  };
  let result = await sequence({ goal });
  const toolFailure = () => sequences.some(({ status }) => ['error', 'cancelled', 'time_limit', 'step_limit'].includes(status));
  signal.throwIfAborted();
  const commandsOnly = result.status === 'returned_results' && result.observations.length
    && result.observations.every(({ action }) => action.tool === 'run_command');
  let final;
  if (commandsOnly) {
    final = { summary: 'Executed requested checks. See recorded exit codes and counts.', evidence: [], checks: [] };
  } else {
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      const before = await workspace.snapshot(signal);
      final = await coder({ goal, evidence: evidenceForCoder(sequences, before.revision), attempt });
      coderCalls++;
      signal.throwIfAborted();
      const after = await workspace.snapshot(signal);
      if (before.revision === after.revision) break;
      const commandIds = [...new Set(sequences.flatMap(({ observations }) => observations
        .filter(({ action }) => action.tool === 'run_command').map(({ action }) => action.args.commandId)))];
      result = await sequence({
        goal: `Verify the implementation just edited for this task: ${goal.slice(0, 3000)}. Execute relevant checks and return actual results. The coding phase is complete.`,
        ...(commandIds.length ? { commandIds } : {}),
      });
      verificationIncomplete = result.status !== 'returned_results';
      const checks = checksFrom(result.observations, config);
      if (!checks.some(({ exitCode }) => exitCode !== 0)) break;
    }
  }
  const checks = checksFrom(sequences.flatMap(({ observations }) => observations), config);
  final = { ...final, checks };
  const failedChecks = checks.some(({ exitCode }) => exitCode !== 0);
  if (failedChecks) final.summary += ' One or more recorded checks failed; the task is not verified.';
  if (toolFailure()) final.summary += ' A tool sequence ended before normal completion; inspect the evidence.';
  if (verificationIncomplete) final.summary += ' Verification did not complete; further work is required.';
  return { final, sequences, coderCalls, status: failedChecks || toolFailure() || verificationIncomplete ? 'incomplete' : 'completed' };
}
