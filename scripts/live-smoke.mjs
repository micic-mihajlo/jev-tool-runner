import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (!process.env.TYPESAFE_API_KEY) throw new Error("Load TYPESAFE_API_KEY before running the live smoke.");
const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = await mkdtemp(path.join(os.tmpdir(), "jev-live-"));
const client = new Client({ name: "jev-live-smoke", version: "1.0.0" });
const env = {};
for (const key of ["PATH", "HOME", "TMPDIR", "TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "TYPESAFE_MODEL"]) {
  if (process.env[key]) env[key] = process.env[key];
}
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist/cli.js"), "serve", "--root", fixture, "--config", path.join(root, "examples/demo-tools.json")],
  env,
  stderr: "inherit",
});
const results = [];
async function run(phase, goal) {
  const started = performance.now();
  const response = await client.callTool({ name: "run_tools", arguments: { goal } }, undefined, { timeout: 120_000 });
  const result = response.structuredContent;
  assert.ok(result, "MCP must return structured observations");
  results.push({ phase, mcpRoundTripMs: Math.round(performance.now() - started), ...result });
  process.stdout.write(JSON.stringify({ phase, status: result.status, ...result.metrics, tools: result.observations.map(({ action, exitCode }) => ({ tool: action.tool, args: action.args, exitCode })) }) + "\n");
  assert.equal(response.isError, false);
  return result;
}

try {
  await cp(path.join(root, "examples/membership-repo"), fixture, { recursive: true });
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.deepEqual(catalog.tools.map(({ name }) => name), ["run_tools"]);
  const before = await run("before-edit", "Run the membership tests, inspect the failing removed-member test and its implementation, and return the evidence needed for a coding agent to fix it. Do not edit files.");
  assert.ok(before.observations.some(({ action, exitCode }) => action.tool === "run_command" && exitCode === 1), "Jev must run the failing tests");
  assert.ok(before.observations.some(({ action }) => action.tool === "read_file" && action.args.path === "src/access.mjs"), "Jev must inspect the implementation");

  await writeFile(path.join(fixture, "src/access.mjs"), 'export function canReceiveMessages(membership) {\n  return membership?.status === "active";\n}\n');
  const after = await run("after-harness-edit", "Run the membership tests after the implementation edit and return the actual test results.");
  assert.ok(after.observations.some(({ action, exitCode }) => action.tool === "run_command" && exitCode === 0), "Jev must rerun tests against the edited workspace");
  assert.ok(results.every(({ metrics }) => metrics.generativeModelCalls === 0));
} finally {
  if (results.length) {
    await mkdir(path.join(root, "validation"), { recursive: true });
    await writeFile(path.join(root, "validation/live-mcp.json"), JSON.stringify({
      recordedAt: new Date().toISOString(),
      scenario: "Two real Jev calls through MCP; the smoke harness applies the known fixture fix between calls. Jev does not write code.",
      results,
    }, null, 2) + "\n", { mode: 0o600 });
  }
  await client.close();
  await rm(fixture, { recursive: true, force: true });
}
