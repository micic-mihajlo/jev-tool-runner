#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig, redact } from "./config.js";
import { runTools } from "./controller.js";
import { JevDecider } from "./jev.js";
import { serve } from "./mcp.js";
import { Workspace } from "./workspace.js";

const HELP = `Jev tool runner

Usage:
  node dist/cli.js run --root /path/to/repo --goal "Run tests and inspect the failure"
  node dist/cli.js serve --root /path/to/repo

Options:
  --config FILE    Explicit command allowlist and run limits (JSON).
  --max-steps N    Override tool-step budget, 1–30 (run only).
  --trace FILE     Save the complete run as private JSON (run only).
  --quiet          Suppress decision progress on stderr (run only).

Set TYPESAFE_API_KEY before running. Node's --env-file flag can load a protected file:
  node --env-file=/path/to/key.env dist/cli.js run ...

Without --config, only source reads, searches, and Git inspection are available.
Configured commands execute locally with shell=false; this runner is not a sandbox.
The run's selected source and tool outputs are sent to the TypeSafe API.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" }, goal: { type: "string" }, config: { type: "string" },
      "max-steps": { type: "string" }, trace: { type: "string" },
      quiet: { type: "boolean", default: false }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !positionals.length) { process.stdout.write(HELP); return; }
  const mode = positionals[0];
  if (positionals.length !== 1 || (mode !== "run" && mode !== "serve")) throw new Error("Choose run or serve; use --help for usage.");
  if (!values.root) throw new Error("Provide an explicit workspace with --root.");
  if (!process.env.TYPESAFE_API_KEY) throw new Error("Set TYPESAFE_API_KEY or use node --env-file=/path/to/key.env. No calls were made.");
  const config = await loadConfig(values.config);
  if (values["max-steps"]) {
    const maxSteps = Number(values["max-steps"]);
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 30) throw new Error("--max-steps must be an integer from 1 to 30.");
    config.maxSteps = maxSteps;
  }
  const workspace = await Workspace.create(values.root, config.commands);
  const decider = new JevDecider();
  if (mode === "serve") { await serve(workspace, decider, config); return; }
  if (!values.goal) throw new Error("Provide --goal for a run.");
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error("Interrupted by user."));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await runTools({
      goal: values.goal, workspace, decider, config, signal: abort.signal,
      onDecision: (event) => {
        if (!values.quiet) {
          process.stderr.write(`[${event.step + 1}] Jev ${event.durationMs}ms → ${event.action?.description ?? event.choice}\n`);
        }
      },
    });
    const json = JSON.stringify(result, null, 2) + "\n";
    if (values.trace) await writeFile(values.trace, json, { mode: 0o600, flag: "wx" });
    process.stdout.write(json);
    if (["error", "cancelled", "time_limit", "step_limit"].includes(result.status)) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`jev-tools: ${redact(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 1;
});
