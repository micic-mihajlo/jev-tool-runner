import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: {
  output: { type: "string" }, "key-file": { type: "string" },
  repeats: { type: "string", default: "3" }, cases: { type: "string" },
  arms: { type: "string", default: "baseline,jev" }, integration: { type: "string", default: "mcp" },
  model: { type: "string", default: "gpt-5.6-sol" }, effort: { type: "string", default: "medium" },
  tier: { type: "string", default: "priority" },
} });
assert.ok(values.output && values["key-file"], "Provide --output and --key-file (a private environment file).");
assert.ok(["mcp", "supervisor"].includes(values.integration), "Unknown integration.");
const output = path.resolve(values.output);
const keyFile = path.resolve(values["key-file"]);
const repeats = Number(values.repeats);
assert.ok(Number.isInteger(repeats) && repeats > 0 && repeats <= 5);
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output);
const scratch = await mkdtemp(path.join(os.tmpdir(), "jev-benchmark-"));
const allCases = [
  {
    id: "membership-fix", kind: "fixture", edits: true,
    goal: "Run the membership tests, diagnose and fix the removed-member access bug, then rerun the tests. Only memberships whose status is active may receive messages; missing or other statuses must be denied. Preserve all test files. Make the smallest implementation change and verify it.",
    commands: [{ id: "membership-tests", description: "Run all membership tests", argv: ["node", "--test", "test/access.test.mjs"], timeoutMs: 10_000 }],
  },
  {
    id: "source-inspection", kind: "project", edits: false,
    goal: "Inspect the runner's source and explain exactly how a completed tool call is suppressed while the workspace is unchanged, how file changes make a call eligible again, and the metadata used for the workspace revision. Cite the implementation files. Do not edit files or run tests; obtain the evidence from source rather than the README.",
    commands: [],
  },
  {
    id: "project-checks", kind: "project", edits: false,
    goal: "Run both npm test and npm run check in this project. Report each command's actual exit code and the integration-test pass/fail counts. Do not edit source, test, or configuration files.",
    commands: [
      { id: "tests", description: "Run npm test: build and execute all integration tests", argv: ["npm", "test"], timeoutMs: 30_000 },
      { id: "typecheck", description: "Run npm run check: TypeScript checking without emitting files", argv: ["npm", "run", "check"], timeoutMs: 30_000 },
    ],
  },
];
const selectedCases = values.cases ? values.cases.split(",") : allCases.map(({ id }) => id);
assert.ok(selectedCases.every((id) => allCases.some((scenario) => scenario.id === id)), "Unknown benchmark case.");
const cases = allCases.filter(({ id }) => selectedCases.includes(id));
const arms = values.arms.split(",");
assert.ok(arms.length && arms.every((arm) => ["baseline", "jev"].includes(arm)), "Unknown benchmark arm.");
const schema = {
  type: "object", additionalProperties: false,
  properties: {
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, finding: { type: "string" } }, required: ["path", "finding"] } },
    checks: { type: "array", items: { type: "object", additionalProperties: false, properties: { command: { type: "string" }, exitCode: { type: "integer" }, passed: { type: "integer" }, failed: { type: "integer" } }, required: ["command", "exitCode", "passed", "failed"] } },
  }, required: ["summary", "evidence", "checks"],
};
const schemaFile = path.join(scratch, "response.schema.json");
await writeFile(schemaFile, JSON.stringify(schema));
const sha = (text) => createHash("sha256").update(text).digest("hex");
async function manifest(root, prefix = "") {
  const result = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const name = path.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await manifest(root, name));
    else if (entry.isFile()) result[name] = sha(await readFile(path.join(root, name)));
  }
  return result;
}

const snapshot = path.join(scratch, "project-snapshot");
await mkdir(snapshot);
for (const name of ["src", "test", "examples", "dist", "package.json", "package-lock.json", "tsconfig.json", ".gitignore", "README.md"]) {
  await cp(path.join(packageRoot, name), path.join(snapshot, name), { recursive: true });
}
const metadata = {
  integrationVersion: values.integration === "supervisor" ? "supervisor-v1" : "v2", recordedAt: new Date().toISOString(), model: values.model, effort: values.effort, serviceTier: values.tier,
  codexVersion: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(), nodeVersion: process.version,
  repeats, arms, cases: cases.map(({ id, goal, commands }) => ({ id, goal, commands })),
  projectSnapshot: await manifest(snapshot),
  supervisorHashes: values.integration === "supervisor" ? Object.fromEntries(await Promise.all(["scripts/supervisor.mjs", "scripts/supervisor-core.mjs"].map(async (name) => [name, sha(await readFile(path.join(packageRoot, name)))]))) : undefined,
  methodology: values.integration === "supervisor" ? "Fresh workspace per run with identical task goals and graders. Baseline starts Codex; treatment starts Jev and invokes Codex only for editing or explanation, with outer verification and at most two coding attempts. Same configured model, effort, tier, schema, counterbalanced ordering, and 180-second budget. All outcomes and provider usage retained; no failed run discarded." : "Fresh Codex CLI process and Git-initialized workspace for every run; identical task goals and model settings; treatment adds one MCP server and asks Codex to delegate inspection/checks while owning edits. The authorized run_tools MCP capability is approved explicitly for the benchmark process. Three task types, alternating arm order by repeat and task. Each run has a 180-second limit. Artifacts capture all events and final answers; no failed formal run is discarded.",
  costBasis: { codex: "API-equivalent estimate, not a subscription invoice", fast: { inputPerMillion: 8, cachedPerMillion: 0.8, cacheWritePerMillion: 10, outputPerMillion: 40 }, standard: { inputPerMillion: 4, cachedPerMillion: 0.4, cacheWritePerMillion: 5, outputPerMillion: 20 }, jev: { inputPerMillion: 0.042, outputPerMillion: 0 }, sources: ["https://developers.openai.com/api/docs/pricing", "https://docs.typesafe.ai/models"] },
};
await writeFile(path.join(output, "methodology.json"), JSON.stringify(metadata, null, 2) + "\n");

async function capture(args, cwd, prompt, artifact, executable = "codex") {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  delete env.TYPESAFE_BASE_URL;
  delete env.TYPESAFE_MODEL;
  const started = performance.now();
  const events = [];
  const child = spawn(executable, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let stdout = "", stderr = "", buffer = "", timedOut = false, startedAtMs = null, firstItemAtMs = null;
  child.stdout.on("data", (data) => {
    stdout += data.toString(); buffer += data.toString();
    const lines = buffer.split("\n"); buffer = lines.pop();
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        events.push(event);
        if (event.type === "turn.started" && startedAtMs === null) startedAtMs = Math.round(performance.now() - started);
        if (event.type.startsWith("item.") && firstItemAtMs === null) firstItemAtMs = Math.round(performance.now() - started);
      } catch { /* Preserve non-JSON lines in the raw artifact. */ }
    }
  });
  child.stderr.on("data", (data) => { stderr += data.toString(); });
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGTERM"); } catch {} }, 180_000);
  const killTimer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 182_000);
  child.stdin.end(prompt);
  let exitCode;
  try { exitCode = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); }); }
  finally { clearTimeout(timer); clearTimeout(killTimer); }
  const elapsedMs = Math.round(performance.now() - started);
  await writeFile(`${artifact}.events.jsonl`, stdout, { mode: 0o600 });
  await writeFile(`${artifact}.stderr.txt`, stderr, { mode: 0o600 });
  return { exitCode, elapsedMs, startedAtMs, firstItemAtMs, timedOut, events };
}

function parseJev(item) {
  const result = item.result;
  if (result?.structuredContent?.metrics) return result.structuredContent;
  for (const content of result?.content ?? []) {
    if (content.type !== "text") continue;
    try { const parsed = JSON.parse(content.text); if (parsed.metrics && parsed.observations) return parsed; } catch {}
  }
  return null;
}

const results = [];
try {
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const [caseIndex, scenario] of cases.entries()) {
      const order = ((repeat + caseIndex) % 2 ? ["jev", "baseline"] : ["baseline", "jev"]).filter((arm) => arms.includes(arm));
      for (const arm of order) {
        const id = `${scenario.id}-${repeat + 1}-${arm}`;
        const workspace = path.join(scratch, id);
        await cp(scenario.kind === "fixture" ? path.join(packageRoot, "examples/membership-repo") : snapshot, workspace, { recursive: true });
        if (scenario.kind === "project") await symlink(path.join(packageRoot, "node_modules"), path.join(workspace, "node_modules"), "dir");
        execFileSync("git", ["init", "--quiet"], { cwd: workspace });
        execFileSync("git", ["add", "."], { cwd: workspace });
        execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Jev Benchmark", "-c", "user.email=benchmark@example.invalid", "commit", "--quiet", "-m", "Benchmark starting state"], { cwd: workspace });
        const before = await manifest(workspace);
        const configFile = path.join(scratch, `${id}.tools.json`);
        await writeFile(configFile, JSON.stringify({ commands: scenario.commands, maxSteps: 10, timeoutMs: 90_000, maxCandidates: 96 }));
        const finalFile = path.join(output, `${id}.final.json`);
        const args = ["exec", "--ignore-user-config", "--strict-config", "--ephemeral", "--skip-git-repo-check", "--json", "--color", "never", "--sandbox", "workspace-write", "--output-schema", schemaFile, "--output-last-message", finalFile,
          "-c", `model=${JSON.stringify(values.model)}`, "-c", `model_reasoning_effort=${JSON.stringify(values.effort)}`, "-c", `service_tier=${JSON.stringify(values.tier)}`,
          "-c", 'approval_policy="never"', "-c", "sandbox_workspace_write.network_access=true", "-c", 'web_search="disabled"', "-c", "features.multi_agent=false", "-c", "project_doc_max_bytes=0"];
        if (arm === "jev" && values.integration === "mcp") {
          const serverArgs = [`--env-file=${keyFile}`, path.join(packageRoot, "dist/cli.js"), "serve", "--root", workspace, "--config", configFile];
          args.push("-c", `mcp_servers.jev_tools.command=${JSON.stringify(process.execPath)}`, "-c", `mcp_servers.jev_tools.args=${JSON.stringify(serverArgs)}`, "-c", "mcp_servers.jev_tools.startup_timeout_sec=15", "-c", "mcp_servers.jev_tools.tool_timeout_sec=120");
          args.push("-c", 'mcp_servers.jev_tools.tools.run_tools.approval_mode="approve"');
        }
        const instructions = arm === "jev"
          ? "Use jev_tools.run_tools once with the complete investigation goal; let it collect the evidence and choose intermediate calls. You own code edits. For exact check commands, supply commandIds from its tool description to execute them directly without model decisions. Use its evidence directly without re-reading or rerunning completed work unless evidence is missing. If it fails or cannot obtain the needed evidence, use your normal tools and finish the task."
          : "Use your normal built-in tools to investigate, make any requested edits, and verify the task. Efficiently batch independent reads or checks when useful.";
        const prompt = `${scenario.goal}\n\n${instructions}\n\nWork only in the provided workspace. Do not use outside repositories, delegate to other agents, or browse the web. Available project check commands: ${scenario.commands.map((command) => command.argv.join(" ")).join("; ") || "none needed"}. Complete the task and return a concise structured result. For checks with no test counts use passed=0 and failed=0. Do not invent checks that were not executed.`;
        process.stdout.write(JSON.stringify({ event: "run.start", id }) + "\n");
        const supervised = arm === "jev" && values.integration === "supervisor";
        const supervisorOutput = path.join(output, `${id}.supervisor`);
        const invocation = supervised ? [`--env-file=${keyFile}`, path.join(packageRoot, "scripts/supervisor.mjs"), "--root", workspace, "--config", configFile, "--output", supervisorOutput, "--model", values.model, "--effort", values.effort, "--tier", values.tier, "--isolated"] : [...args, "-"];
        const run = await capture(invocation, workspace, supervised ? scenario.goal : prompt, path.join(output, id), supervised ? process.execPath : "codex");
        if (supervised) { try { await cp(path.join(supervisorOutput, "final.json"), finalFile); } catch {} }
        let final = null;
        try { final = JSON.parse(await readFile(finalFile, "utf8")); } catch {}
        const completed = run.events.filter(({ type }) => type === "item.completed").map(({ item }) => item);
        const usage = run.events.findLast(({ type }) => type === "turn.completed")?.usage ?? null;
        const jevRuns = [...completed.filter((item) => item.type === "mcp_tool_call").map(parseJev).filter(Boolean), ...run.events.filter(({ type }) => type === "jev.completed").map(({ result }) => result)];
        const commandItems = completed.filter((item) => item.type === "command_execution");
        const after = await manifest(workspace);
        const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]);
        const grading = { passed: false, changedFiles: changed, assertions: {} };
        if (scenario.id === "membership-fix") {
          let graderOutput = "", graderExitCode = 0;
          try {
            graderOutput = execFileSync(process.execPath, ["--input-type=module", "-e", `import assert from 'node:assert/strict'; import {canReceiveMessages as f} from './src/access.mjs'; for (const value of [null,undefined,{status:'removed'},{status:'pending'},{status:'suspended'},{}]) assert.equal(f(value),false); assert.equal(f({status:'active'}),true); console.log('held-out access cases passed');`], { cwd: workspace, encoding: "utf8", timeout: 10_000 });
            graderOutput += execFileSync(process.execPath, ["--test", "test/access.test.mjs"], { cwd: workspace, encoding: "utf8", timeout: 10_000 });
          } catch (error) { graderExitCode = error.status ?? 1; graderOutput += String(error.stdout ?? "") + String(error.stderr ?? ""); }
          grading.assertions = { independentTestsPass: graderExitCode === 0, onlyImplementationChanged: changed.every((file) => file === "src/access.mjs"), modelReportedPassingCheck: final?.checks?.some(({ exitCode }) => exitCode === 0) ?? false };
          await writeFile(path.join(output, `${id}.grader.txt`), graderOutput);
        } else if (scenario.id === "source-inspection") {
          const answer = JSON.stringify(final ?? {});
          const evidence = commandItems.map((item) => item.aggregated_output ?? "").join("\n") + jevRuns.flatMap((result) => result.observations.map(({ output }) => output)).join("\n");
          grading.assertions = { unchanged: changed.length === 0, citesWorkspaceSource: /src\/workspace\.ts/.test(answer), sourceEvidenceCollected: /workspaceRevision\s*===\s*snapshot\.revision/.test(evidence) && /mtimeMs/.test(evidence) && /executed\.has\(candidate\.id\)/.test(evidence), describesRevision: /revision|fingerprint/i.test(answer), describesExecutedSuppression: /executed|completed|suppress|already.*run/i.test(answer), describesModificationTime: /mtime|modification|modified time/i.test(answer), describesSize: /size/i.test(answer) };
        } else {
          const evidence = commandItems.map((item) => item.aggregated_output ?? "").join("\n") + jevRuns.flatMap((result) => result.observations.map(({ output }) => output)).join("\n");
          const typecheckPassed = commandItems.some((item) => /\bnpm run check\b/.test(item.command ?? "") && item.exit_code === 0)
            || jevRuns.some((run) => run.observations.some((item) => item.action.tool === "run_command" && item.action.args.commandId === "typecheck" && item.exitCode === 0));
          grading.assertions = { unchanged: changed.length === 0, actualTestsPassed: /(?:pass|passed)\s+[1-9]\d*/.test(evidence) && /fail\s+0/.test(evidence) && final?.checks?.some((check) => check.command.includes("npm test") && check.passed === Number(evidence.match(/(?:pass|passed)\s+(\d+)/)?.[1]) && check.failed === 0), actualTypecheckPassed: typecheckPassed, reportedBothChecks: ["npm test", "npm run check"].every((command) => final?.checks?.some((check) => check.command.includes(command) && check.exitCode === 0)) };
        }
        grading.passed = run.exitCode === 0 && !run.timedOut && Object.values(grading.assertions).every(Boolean);
        const result = {
          id, scenario: scenario.id, repeat: repeat + 1, arm, elapsedMs: run.elapsedMs, startupMs: run.startedAtMs, firstItemAtMs: run.firstItemAtMs,
          exitCode: run.exitCode, timedOut: run.timedOut, usage, grading, final,
          counts: { coderInvocations: run.events.filter(({ type }) => type === "coder.turn.completed").length, nativeCommandCalls: commandItems.length, fileChangeItems: completed.filter(({ type }) => type === "file_change").length, mcpCalls: completed.filter(({ type }) => type === "mcp_tool_call").length, reasoningItems: completed.filter(({ type }) => type === "reasoning").length },
          jev: { runs: jevRuns.length, inputTokens: jevRuns.reduce((sum, result) => sum + result.metrics.inputTokens, 0), outputTokens: jevRuns.reduce((sum, result) => sum + result.metrics.outputTokens, 0), decisions: jevRuns.reduce((sum, result) => sum + result.metrics.decisionCalls, 0), toolCalls: jevRuns.reduce((sum, result) => sum + result.metrics.toolCalls, 0), totalMs: jevRuns.reduce((sum, result) => sum + result.metrics.totalMs, 0), statuses: jevRuns.map(({ status }) => status) },
          itemTypes: [...new Set(completed.map(({ type }) => type))],
        };
        results.push(result);
        await writeFile(path.join(output, "results.json"), JSON.stringify({ metadata, results }, null, 2) + "\n");
        process.stdout.write(JSON.stringify({ event: "run.complete", id, elapsedMs: result.elapsedMs, usage, grading, jev: result.jev, counts: result.counts }) + "\n");
      }
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
