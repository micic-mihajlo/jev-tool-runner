import { readFile } from "node:fs/promises";
import { z } from "zod";
import { DEFAULT_CONFIG, type RunnerConfig } from "./types.js";

const configSchema = z.object({
  commands: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
    description: z.string().min(1).max(300),
    argv: z.array(z.string().min(1).max(2000)).min(1).max(30),
    timeoutMs: z.number().int().min(100).max(60_000).default(30_000),
  }).strict()).max(20).default([]),
  maxSteps: z.number().int().min(1).max(30).default(DEFAULT_CONFIG.maxSteps),
  timeoutMs: z.number().int().min(1000).max(300_000).default(DEFAULT_CONFIG.timeoutMs),
  maxCandidates: z.number().int().min(10).max(220).default(DEFAULT_CONFIG.maxCandidates),
}).strict();

export async function loadConfig(path?: string): Promise<RunnerConfig> {
  const config = configSchema.parse(path ? JSON.parse(await readFile(path, "utf8")) : {});
  if (new Set(config.commands.map((command) => command.id)).size !== config.commands.length) {
    throw new Error("Command IDs must be unique.");
  }
  return config;
}

export function redact(text: string): string {
  let result = text;
  if (process.env.TYPESAFE_API_KEY) result = result.split(process.env.TYPESAFE_API_KEY).join("[REDACTED]");
  return result
    .replace(/apikey_[a-zA-Z0-9_-]{20,}/g, "[REDACTED]")
    .replace(/\bsk-[a-zA-Z0-9_-]{20,}/g, "[REDACTED]")
    .replace(/\bBearer\s+[a-zA-Z0-9_.=-]{16,}/gi, "Bearer [REDACTED]");
}
