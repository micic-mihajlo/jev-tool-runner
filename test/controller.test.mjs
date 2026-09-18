import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DEFAULT_CONFIG, JevDecider, Workspace, loadConfig, runTools } from "../dist/index.js";
import { runProcess } from "../dist/process.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const signal = () => new AbortController().signal;

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jev-tools-test-"));
  await cp(path.join(root, "examples/membership-repo"), dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = await loadConfig(path.join(root, "examples/demo-tools.json"));
  return { dir, config, workspace: await Workspace.create(dir, config.commands) };
}

async function provider(t, select) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/systemone");
      assert.equal(req.headers.authorization, "Bearer test-token");
      let data = "";
      for await (const chunk of req) data += chunk;
      const body = JSON.parse(data);
      requests.push(body);
      const result = await select(body, requests.length);
      const selected = typeof result === "string" ? result : result.choice;
      const confidence = typeof result === "string" ? 0.9 : result.confidence;
      const probabilities = Object.fromEntries(Object.keys(body.questions.next_action.criteria).map((key) => [key, key === selected ? 1 : 0]));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        model: "contract-fixture", usage: { input_tokens: 100, output_tokens: 20 },
        answers: { next_action: { type: "choice", choice: selected, confidence, probabilities } },
      }));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise((resolve, reject) => { server.on("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  return {
    requests, baseURL,
    decider: new JevDecider({ apiKey: "test-token", baseURL, retry: { maxRetries: 0 } }),
  };
}

function match(body, text) {
  const entry = Object.entries(body.questions.next_action.criteria).find(([, description]) => description.includes(text));
  assert.ok(entry, `Missing candidate: ${text}`);
  return entry[0];
}

test("real HTTP SDK calls dispatch real tests and source reads with no generative round trips", async (t) => {
  const { workspace, config } = await fixture(t);
  const http = await provider(t, (body, count) => {
    if (count === 1) return match(body, "Run configured command");
    if (count === 2) return match(body, "Read 'test/access.test.mjs'");
    if (count === 3) return match(body, "Read 'src/access.mjs'");
    return "request_coding_agent";
  });
  const result = await runTools({ goal: "Run membership tests and inspect removed access", workspace, config, decider: http.decider });
  assert.equal(result.status, "needs_coding_agent");
  assert.equal(result.metrics.decisionCalls, 4);
  assert.equal(result.metrics.toolCalls, 3);
  assert.equal(result.metrics.generativeModelCalls, 0);
  assert.equal(result.observations[0].exitCode, 1);
  assert.match(result.observations[0].output, /removed members cannot receive messages/);
  assert.match(result.observations[2].output, /membership !== null/);
  assert.equal(http.requests[1].state.observations[0].exitCode, 1);
});

test("a valid low-confidence choice executes once, and unchanged calls leave the candidate set", async (t) => {
  const { workspace, config } = await fixture(t);
  let first;
  const http = await provider(t, (body, count) => {
    if (count === 1) {
      first = match(body, "Run configured command");
      return { choice: first, confidence: 0.1 };
    }
    assert.ok(!Object.values(body.questions.next_action.criteria).some((description) => description.includes("Run configured command")));
    return "return_results";
  });
  const result = await runTools({ goal: "Run membership tests", workspace, config, decider: http.decider });
  assert.equal(result.metrics.toolCalls, 1);
  assert.equal(result.decisions[0].confidence, 0.1);
  assert.equal(result.observations[0].exitCode, 1);
  assert.equal(result.status, "returned_results");
});

test("an unknown model-selected action cannot execute", async (t) => {
  const { workspace, config } = await fixture(t);
  const http = await provider(t, () => "invented_shell_command");
  const result = await runTools({ goal: "Inspect membership", workspace, config, decider: http.decider });
  assert.equal(result.status, "error");
  assert.equal(result.metrics.toolCalls, 0);
  assert.match(result.message, /outside the supplied candidates/);
});

test("a terminal result cannot be returned before collecting evidence", async (t) => {
  const { workspace, config } = await fixture(t);
  const http = await provider(t, (body) => {
    assert.equal(Object.hasOwn(body.questions.next_action.criteria, "return_results"), false);
    return "return_results";
  });
  const result = await runTools({ goal: "Check access", workspace, config, decider: http.decider });
  assert.equal(result.status, "error");
  assert.equal(result.metrics.toolCalls, 0);
});

test("workspace changes make a previously executed read available again", async (t) => {
  const { workspace, dir } = await fixture(t);
  const snapshot = await workspace.snapshot(signal());
  const selected = workspace.candidates("access", snapshot, [], 96).find((candidate) => candidate.tool === "read_file" && candidate.args.path === "src/access.mjs");
  const observed = { step: 0, action: selected, workspaceRevision: snapshot.revision, ...await workspace.execute(selected, snapshot, signal()) };
  assert.equal(workspace.candidates("access", snapshot, [observed], 96).some((candidate) => candidate.id === selected.id), false);
  await writeFile(path.join(dir, "src/access.mjs"), "export const changedAccess = true;\n");
  const changed = await workspace.snapshot(signal());
  assert.notEqual(changed.revision, snapshot.revision);
  assert.equal(workspace.candidates("access", changed, [observed], 96).some((candidate) => candidate.id === selected.id), true);
});

test("source inventory excludes credential files, ignores gitignored files, and rejects symlink escapes", async (t) => {
  const { workspace, dir } = await fixture(t);
  await writeFile(path.join(dir, ".env"), "PASSWORD=secret\n");
  await writeFile(path.join(dir, "session.env"), "PASSWORD=hidden-value\n");
  await writeFile(path.join(dir, "PRODUCTION.ENV.local"), "PASSWORD=hidden-value\n");
  await mkdir(path.join(dir, "private"));
  await writeFile(path.join(dir, "private", "credentials.json"), "secret");
  await writeFile(path.join(dir, ".gitignore"), "ignored.mjs\n");
  await writeFile(path.join(dir, "ignored.mjs"), "sensitive ignored data");
  const outside = await mkdtemp(path.join(os.tmpdir(), "jev-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "outside.txt"), "outside-value");
  await symlink(path.join(outside, "outside.txt"), path.join(dir, "linked.txt"));
  const snapshot = await workspace.snapshot(signal());
  assert.ok(!snapshot.files.includes(".env"));
  assert.ok(!snapshot.files.includes("session.env"));
  assert.ok(!snapshot.files.includes("PRODUCTION.ENV.local"));
  assert.ok(!snapshot.files.includes("private/credentials.json"));
  assert.ok(!snapshot.files.includes("ignored.mjs"));
  await assert.rejects(workspace.execute({ id: "x", tool: "read_file", args: { path: "../outside.txt", startLine: 1 }, description: "invalid" }, snapshot, signal()));
  await assert.rejects(workspace.execute({ id: "y", tool: "read_file", args: { path: "linked.txt", startLine: 1 }, description: "link" }, snapshot, signal()));
  const search = workspace.candidates("hidden-value", snapshot, [], 96).find((candidate) => candidate.tool === "search_text");
  const searched = await workspace.execute(search, snapshot, signal());
  assert.equal(searched.exitCode, 1);
  assert.equal(searched.output, "");
});

test("source pagination preserves every ordinary line across output limits", async (t) => {
  const { workspace, dir } = await fixture(t);
  const lines = Array.from({ length: 100 }, (_, index) => `line-${index + 1} ${"x".repeat(1000)}`);
  await writeFile(path.join(dir, "long.mjs"), lines.join("\n"));
  const snapshot = await workspace.snapshot(signal());
  const observations = [];
  const numbers = [];
  for (let page = 0; page < 20; page++) {
    const selected = workspace.candidates("long.mjs", snapshot, observations, 96).find((candidate) => candidate.tool === "read_file" && candidate.args.path === "long.mjs");
    if (!selected) break;
    const result = await workspace.execute(selected, snapshot, signal());
    numbers.push(...[...result.output.matchAll(/^(\d+): line-/gm)].map((match) => Number(match[1])));
    assert.ok(result.output.length < 14_000);
    observations.push({ step: page, action: selected, workspaceRevision: snapshot.revision, ...result });
  }
  assert.deepEqual(numbers, Array.from({ length: 100 }, (_, index) => index + 1));
});

test("Git diff excludes tracked credentials", async (t) => {
  const { dir } = await fixture(t);
  await runProcess(["git", "init", "--quiet"], dir, signal());
  await writeFile(path.join(dir, ".env"), "PASSWORD=do-not-return-this\n");
  await runProcess(["git", "add", "."], dir, signal());
  const workspace = await Workspace.create(dir, []);
  const snapshot = await workspace.snapshot(signal());
  const candidate = workspace.candidates("staged diff", snapshot, [], 96).find((candidate) => candidate.tool === "git_diff" && candidate.args.staged === 1);
  const result = await workspace.execute(candidate, snapshot, signal());
  assert.match(result.output, /canReceiveMessages/);
  assert.doesNotMatch(result.output, /PASSWORD|do-not-return-this/);
});

test("Git diff stays scoped to a nested workspace and includes deleted source", async (t) => {
  const { dir } = await fixture(t);
  await runProcess(["git", "init", "--quiet"], dir, signal());
  await runProcess(["git", "add", "."], dir, signal());
  await writeFile(path.join(dir, "test/access.test.mjs"), "outside-nested-workspace\n");
  await writeFile(path.join(dir, "src/access.mjs"), "inside-nested-workspace\n");
  await rm(path.join(dir, "src/format.mjs"));
  const workspace = await Workspace.create(path.join(dir, "src"), []);
  const snapshot = await workspace.snapshot(signal());
  const candidate = workspace.candidates("diff", snapshot, [], 96).find((candidate) => candidate.tool === "git_diff" && candidate.args.staged === 0);
  const result = await workspace.execute(candidate, snapshot, signal());
  assert.match(result.output, /inside-nested-workspace/);
  assert.match(result.output, /deleted file mode/);
  assert.doesNotMatch(result.output, /outside-nested-workspace/);
});

test("only configured commands execute; children do not inherit API credentials or shell interpolation", async (t) => {
  const { dir } = await fixture(t);
  const commands = [{ id: "echo", description: "Echo literal arguments", argv: [process.execPath, "-e", "console.log(JSON.stringify({arg:process.argv[1],key:process.env.TYPESAFE_API_KEY??null}))", "; touch unexpected-file"], timeoutMs: 1000 }];
  const workspace = await Workspace.create(dir, commands);
  const snapshot = await workspace.snapshot(signal());
  const candidate = workspace.candidates("echo", snapshot, [], 96).find((candidate) => candidate.tool === "run_command");
  const result = await workspace.execute(candidate, snapshot, signal());
  assert.deepEqual(JSON.parse(result.output), { arg: "; touch unexpected-file", key: null });
  await assert.rejects(workspace.execute({ ...candidate, args: { commandId: "unapproved" } }, snapshot, signal()), /allowlist/);
});

test("tool processes have bounded output and terminate on timeout or cancellation", async () => {
  const output = await runProcess([process.execPath, "-e", "process.stdout.write('x'.repeat(10000))"], root, signal(), 1000, 100);
  assert.equal(output.stdout.length, 100);
  assert.equal(output.truncated, true);
  const timed = await runProcess([process.execPath, "-e", "setInterval(()=>{},1000)"], root, signal(), 30);
  assert.equal(timed.timedOut, true);
  const abort = new AbortController();
  const pending = runProcess([process.execPath, "-e", "setInterval(()=>{},1000)"], root, abort.signal, 5000);
  setTimeout(() => abort.abort(new Error("cancelled-test")), 30);
  await assert.rejects(pending, /cancelled-test/);
});

test("the step budget stops further provider and tool calls", async (t) => {
  const { workspace, config } = await fixture(t);
  const http = await provider(t, (body) => match(body, "Run configured command"));
  const result = await runTools({ goal: "Run tests", workspace, config: { ...config, maxSteps: 1 }, decider: http.decider });
  assert.equal(result.status, "step_limit");
  assert.equal(result.metrics.toolCalls, 1);
  assert.equal(http.requests.length, 1);
});

test("the run deadline cancels a pending SDK request without executing a tool", async (t) => {
  const { workspace, config } = await fixture(t);
  const http = await provider(t, async (body) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return match(body, "Run configured command");
  });
  const result = await runTools({ goal: "Run tests", workspace, config: { ...config, timeoutMs: 50 }, decider: http.decider });
  assert.equal(result.status, "time_limit");
  assert.equal(result.metrics.toolCalls, 0);
  assert.ok(result.metrics.totalMs < 1000);
});

test("real MCP stdio handshake, catalog, and tool execution return structured observations", async (t) => {
  const { dir } = await fixture(t);
  const http = await provider(t, (body, count) => count === 1 ? match(body, "Read 'src/access.mjs'") : "return_results");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist/cli.js"), "serve", "--root", dir],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TYPESAFE_API_KEY: "test-token", TYPESAFE_BASE_URL: http.baseURL },
    stderr: "pipe",
  });
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.deepEqual(catalog.tools.map((tool) => tool.name), ["run_tools"]);
  assert.equal(catalog.tools[0].inputSchema.properties.maxSteps, undefined);
  const called = await client.callTool({ name: "run_tools", arguments: { goal: "Read the membership access implementation", maxSteps: 20 } });
  assert.equal(called.isError, false);
  assert.equal(called.structuredContent.metrics.toolCalls, 1);
  assert.equal(called.structuredContent.decisions, undefined);
  assert.equal(called.structuredContent.observations[0].workspaceRevision, undefined);
  assert.match(called.structuredContent.observations[0].output, /membership !== null/);
  assert.equal(JSON.parse(called.content[0].text).status, "returned_results");
});

test("explicit commands execute in order, preserve failures, and never call Jev or index source", async (t) => {
  const { dir, config } = await fixture(t);
  const commands = [
    ...config.commands,
    { id: "second", description: "Second requested check", argv: [process.execPath, "-e", "console.log('second-check')"], timeoutMs: 1000 },
  ];
  const workspace = await Workspace.create(dir, commands);
  workspace.snapshot = async () => { throw new Error("Direct checks must not index source"); };
  const decider = { decide: async () => { throw new Error("Direct checks must not call a model"); } };
  const result = await runTools({ goal: "Run both checks", commandIds: ["membership-tests", "second"], workspace, config: { ...config, commands }, decider });
  assert.equal(result.status, "returned_results");
  assert.deepEqual(result.observations.map(({ exitCode }) => exitCode), [1, 0]);
  assert.match(result.observations[1].output, /second-check/);
  assert.equal(result.metrics.decisionCalls, 0);
  assert.equal(result.metrics.inputTokens, 0);
  for (const commandIds of [["second", "unconfigured"], ["second", "second"], []]) {
    await assert.rejects(runTools({ goal: "Check", commandIds, workspace, config, decider }), /unique configured/);
  }
});

test("direct command sequences honor cancellation and do not execute later commands", async (t) => {
  const { dir, config } = await fixture(t);
  const commands = [
    { id: "wait", description: "Wait", argv: [process.execPath, "-e", "setInterval(()=>{},1000)"], timeoutMs: 5000 },
    { id: "later", description: "Must not run", argv: [process.execPath, "-e", "console.log('later')"], timeoutMs: 1000 },
  ];
  const workspace = await Workspace.create(dir, commands);
  const result = await runTools({ goal: "Run checks", commandIds: ["wait", "later"], workspace, config: { ...config, commands, timeoutMs: 50 }, decider: { decide() { throw new Error("Unexpected model call"); } } });
  assert.equal(result.status, "time_limit");
  assert.ok(!result.observations.some(({ action }) => action.args.commandId === "later"));
});

test("MCP exposes configured IDs and executes direct checks with no provider requests", async (t) => {
  const { dir } = await fixture(t);
  const http = await provider(t, () => { throw new Error("Unexpected provider request"); });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist/cli.js"), "serve", "--root", dir, "--config", path.join(root, "examples/demo-tools.json")],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TYPESAFE_API_KEY: "test-token", TYPESAFE_BASE_URL: http.baseURL }, stderr: "pipe",
  });
  const client = new Client({ name: "direct-check-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.ok(catalog.tools[0].inputSchema.properties.commandIds);
  const called = await client.callTool({ name: "run_tools", arguments: { goal: "Run membership tests", commandIds: ["membership-tests"] } });
  assert.equal(called.isError, false);
  assert.equal(called.structuredContent.observations[0].exitCode, 1);
  assert.equal(called.structuredContent.metrics.decisionCalls, 0);
  assert.equal(http.requests.length, 0);
});
