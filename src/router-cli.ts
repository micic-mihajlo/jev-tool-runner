#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { parseArgs } from "node:util";
import { JevToolSelector } from "./tool-selector.js";
import { startRouter } from "./router-server.js";

const separator = process.argv.indexOf("--");
const own = separator < 0 ? process.argv.slice(2) : process.argv.slice(2, separator);
const codexArgs = separator < 0 ? [] : process.argv.slice(separator + 1);
const { values } = parseArgs({ args: own, options: { "key-file": { type: "string" }, upstream: { type: "string", default: "https://chatgpt.com/backend-api/codex" }, audit: { type: "string" }, help: { type: "boolean" } } });
if (values.help || !values["key-file"]) {
  console.log('Usage: node dist/router-cli.js --key-file PRIVATE.env [--audit NEW.jsonl] [--upstream https://api.openai.com/v1] -- [Codex arguments]\nRuns Codex with a local Jev tool selector. Uses existing Codex authentication and keeps its approvals/sandbox. Jev receives the current goal and tool-call metadata, never source output. Default upstream uses ChatGPT login.');
  process.exit(values.help ? 0 : 1);
}
const env = { ...process.env };
for (const key of ["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "TYPESAFE_MODEL"]) delete env[key];
process.loadEnvFile(values["key-file"]!);
const token = randomBytes(32).toString("hex");
const auditFile = values.audit ? openSync(values.audit, "wx", 0o600) : undefined;
const router = await startRouter({ selector: new JevToolSelector(), token, upstream: values.upstream!,
  audit: event => { if (auditFile !== undefined) appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n"); } });
const settings = ["model_provider=\"jev_router\"", "model_providers.jev_router.name=\"Jev native tool router\"",
  `model_providers.jev_router.base_url=${JSON.stringify(router.url)}`, "model_providers.jev_router.wire_api=\"responses\"",
  "model_providers.jev_router.requires_openai_auth=true", "model_providers.jev_router.supports_websockets=false",
  `model_providers.jev_router.http_headers={\"x-jev-router-key\"=${JSON.stringify(token)}}`, "features.enable_request_compression=false"];
const child = spawn("codex", [...codexArgs, ...settings.flatMap(setting => ["-c", setting])], { stdio: "inherit", env });
const interrupt = () => child.kill("SIGINT");
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try { process.exitCode = await new Promise<number>(resolve => { child.once("error", () => resolve(1)); child.once("exit", (code, signal) => resolve(code ?? (signal ? 130 : 1))); }); }
finally { await router.close(); if (auditFile !== undefined) closeSync(auditFile); }
