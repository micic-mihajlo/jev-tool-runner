import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Workspace, loadConfig } from '../dist/index.js';
import { checksFrom, runSupervisedTask } from './supervisor-core.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-supervisor-test-'));
  await cp(new URL('../examples/membership-repo', import.meta.url), root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await loadConfig(new URL('../examples/demo-tools.json', import.meta.url));
  return { root, config, workspace: await Workspace.create(root, config.commands), signal: new AbortController().signal };
}
function decision(choice) { return { choice, confidence: 1, probabilities: { [choice]: 1 }, model: 'test', durationMs: 0, inputTokens: 0, outputTokens: 0 }; }
function commandThen(terminal) {
  return { decide: async ({ actions, observations }) => decision(observations.length ? terminal : actions.find(({ tool }) => tool === 'run_command').id) };
}

test('supervisor owns real verification after a coding-phase edit', async (t) => {
  const f = await fixture(t);
  const result = await runSupervisedTask({ ...f, goal: 'Fix removed membership access and verify', decider: commandThen('request_coding_agent'),
    coder: async ({ evidence }) => {
      assert.equal(evidence[0].exitCode, 1);
      await writeFile(path.join(f.root, 'src/access.mjs'), 'export function canReceiveMessages(membership) { return membership?.status === "active"; }\n');
      return { summary: 'Restricted to active memberships.', evidence: [], checks: [{ command: 'invented', exitCode: 0, passed: 999, failed: 0 }] };
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.coderCalls, 1);
  assert.equal(result.sequences.length, 2);
  assert.equal(result.sequences[1].metrics.decisionCalls, 0);
  assert.deepEqual(result.final.checks, [{ command: 'node --test test/access.test.mjs', exitCode: 0, passed: 3, failed: 0 }]);
});

test('command-only work uses no coding model and does not conceal a failed check', async (t) => {
  const f = await fixture(t);
  const result = await runSupervisedTask({ ...f, goal: 'Run membership tests', decider: commandThen('return_results'), coder: async () => { throw new Error('Unnecessary coding call'); } });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.coderCalls, 0);
  assert.equal(result.final.checks[0].exitCode, 1);
  assert.equal(result.final.checks[0].failed, 1);
});

test('failed verification returns actual output for one bounded repair attempt', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const result = await runSupervisedTask({ ...f, goal: 'Fix access', decider: commandThen('request_coding_agent'),
    coder: async ({ evidence }) => {
      calls++;
      if (calls === 2) assert.equal(evidence.at(-1).exitCode, 1);
      await writeFile(path.join(f.root, 'src/access.mjs'), `export function canReceiveMessages(membership) { return ${calls === 1 ? 'true' : 'membership?.status === "active"'}; }\n`);
      return { summary: 'Updated access.', evidence: [], checks: [] };
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.coderCalls, 2);
  assert.equal(result.sequences.length, 3);
  assert.equal(result.final.checks[0].failed, 0);
});

test('check extraction preserves an interrupted command as failure', () => {
  const config = { commands: [{ id: 'check', argv: ['npm', 'test'] }] };
  const checks = checksFrom([{ action: { tool: 'run_command', args: { commandId: 'check' } }, output: '', exitCode: null }], config);
  assert.equal(checks[0].exitCode, -1);
});

test('a repair retry withholds stale source collected before an edit', async (t) => {
  const f = await fixture(t);
  const decider = { decide: async ({ actions, observations }) => decision(observations.length === 0
    ? actions.find(({ tool, args }) => tool === 'read_file' && args.path === 'src/access.mjs').id
    : observations.length === 1 ? actions.find(({ tool }) => tool === 'run_command').id : 'request_coding_agent') };
  let calls = 0;
  const result = await runSupervisedTask({ ...f, goal: 'Fix access', decider,
    coder: async ({ evidence }) => {
      calls++;
      const source = evidence.find(({ tool }) => tool === 'read_file');
      if (calls === 1) { assert.equal(source.stale, undefined); assert.match(source.output, /membership !== null/); }
      else { assert.equal(source.stale, true); assert.doesNotMatch(source.output, /membership !== null/); }
      await writeFile(path.join(f.root, 'src/access.mjs'), `export function canReceiveMessages(membership) { return ${calls === 1 ? 'true' : 'membership?.status === "active"'}; }\n`);
      return { summary: 'Updated access.', evidence: [], checks: [] };
    },
  });
  assert.equal(result.coderCalls, 2);
  assert.equal(result.status, 'completed');
});

test('an unresolved verification handoff is not reported as completed', async (t) => {
  const f = await fixture(t);
  let decisions = 0;
  const decider = { decide: async ({ actions }) => decision(++decisions === 1
    ? actions.find(({ tool, args }) => tool === 'read_file' && args.path === 'src/access.mjs').id : 'request_coding_agent') };
  const result = await runSupervisedTask({ ...f, goal: 'Fix access', decider,
    coder: async () => {
      await writeFile(path.join(f.root, 'src/access.mjs'), 'export const unverifiedChange = true;\n');
      return { summary: 'Made an edit.', evidence: [], checks: [] };
    },
  });
  assert.equal(result.status, 'incomplete');
  assert.match(result.final.summary, /Verification did not complete/);
});
