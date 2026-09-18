#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { handleHook, settingsSchema, type HookEvent } from "./hooks.js";
import { redact } from "./config.js";

const abort = new AbortController();
process.once("SIGTERM", () => abort.abort(new Error("Hook terminated")));
process.once("SIGINT", () => abort.abort(new Error("Hook interrupted")));
try {
  const { values } = parseArgs({ options: { settings: { type: "string" } } });
  if (!values.settings) throw new Error("Missing integration settings");
  const settings = settingsSchema.parse(JSON.parse(await readFile(values.settings, "utf8")));
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1000000) throw new Error("Hook input exceeds 1 MB");
    chunks.push(chunk);
  }
  const event = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookEvent;
  process.loadEnvFile(settings.keyFile);
  const result = await handleHook(settings, event, { signal: abort.signal });
  process.stdout.write(redact(JSON.stringify(result)) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ systemMessage: `Jev hook unavailable: ${redact(error instanceof Error ? error.message : String(error))}. Native Codex remains available; automatic evidence/verification is not guaranteed.` }) + "\n");
}
