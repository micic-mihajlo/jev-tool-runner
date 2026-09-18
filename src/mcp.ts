import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runTools } from "./controller.js";
import type { Decider, RunnerConfig } from "./types.js";
import type { Workspace } from "./workspace.js";

export function createMcpServer(workspace: Workspace, decider: Decider, config: RunnerConfig): McpServer {
  const server = new McpServer({ name: "jev-tool-runner", version: "0.1.0" }, {
    instructions: "Delegate an investigation with its complete goal once. Jev selects and executes intermediate tools; use the returned evidence to answer or edit. For known checks, supply commandIds to execute them directly without model decisions. Do not repeat collected evidence unless files changed or evidence is missing. This runner cannot edit. Investigation content is processed by TypeSafe.",
  });
  let busy = false;
  server.registerTool("run_tools", {
    title: "Let Jev run a tool sequence",
    description: `Investigate a goal autonomously, or execute exact configured checks using commandIds. Returns source evidence and command outputs with exit codes. The server manages its own ${config.maxSteps}-step budget. Configured commands: ${JSON.stringify(config.commands.map(({ id, argv }) => ({ id, argv })))}`,
    inputSchema: {
      goal: z.string().min(1).max(4000).describe("The concrete inspection or command goal, including known files, symbols, symptoms, and constraints."),
      ...(config.commands.length ? { commandIds: z.array(z.enum(config.commands.map(({ id }) => id) as [string, ...string[]])).min(1).max(config.maxSteps).optional().describe("For exact checks only: execute these IDs in order and return, without Jev investigation. Omit when diagnosis or source discovery is needed.") } : {}),
    },
    annotations: { readOnlyHint: config.commands.length === 0, destructiveHint: config.commands.length > 0, openWorldHint: true },
  }, async ({ goal, commandIds }, extra) => {
    if (busy) return { isError: true, content: [{ type: "text", text: "A tool sequence is already running in this workspace. Wait for it to finish." }] };
    busy = true;
    try {
      const result = await runTools({ goal, workspace, decider, config, ...(commandIds ? { commandIds } : {}), signal: extra.signal });
      const payload = {
        status: result.status,
        message: result.message,
        observations: result.observations.map(({ action, output, exitCode, truncated, nextLine }) => ({
          action: { tool: action.tool, args: action.args }, output, exitCode,
          ...(truncated ? { truncated } : {}), ...(nextLine ? { nextLine } : {}),
        })),
        metrics: result.metrics,
      };
      return {
        isError: result.status === "error",
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    } finally { busy = false; }
  });
  return server;
}

export async function serve(workspace: Workspace, decider: Decider, config: RunnerConfig): Promise<void> {
  const server = createMcpServer(workspace, decider, config);
  await server.connect(new StdioServerTransport());
}
