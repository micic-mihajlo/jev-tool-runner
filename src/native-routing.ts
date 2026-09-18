import { createHash } from "node:crypto";
import type { NativeCall, SelectionInput, ToolOffer } from "./tool-selector.js";

type Item = Record<string, any>;
export interface ModelRequest extends Item { input?: Item[]; tools?: Item[] }
const textOf = (item: Item): string => typeof item.content === "string" ? item.content :
  Array.isArray(item.content) ? item.content.filter((c: Item) => c.type === "input_text" || c.type === "text").map((c: Item) => c.text).join("\n") : "";
const keyOf = (call: NativeCall) => createHash("sha256").update(JSON.stringify(call)).digest("hex").slice(0, 20);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function nativeExecutor(request: ModelRequest): ((cmd: string) => NativeCall) | undefined {
  const tools = [...(request.tools ?? []), ...(request.input ?? []).filter(i => i.type === "additional_tools").flatMap(i => i.tools ?? [])];
  const entries: { tool: Item; namespace?: string }[] = [];
  for (const tool of tools) {
    if (tool.type === "namespace") for (const nested of tool.tools ?? []) entries.push({ tool: nested, namespace: tool.name });
    else entries.push({ tool });
  }
  const direct = entries.find(({ tool }) => tool.type === "function" && tool.name === "exec_command" && tool.parameters?.properties?.cmd);
  if (direct) return cmd => ({ type: "function_call", name: "exec_command", ...(direct.namespace ? { namespace: direct.namespace } : {}), arguments: JSON.stringify({ cmd, max_output_tokens: 3000 }) });
  const code = entries.find(({ tool, namespace }) => tool.type === "custom" && tool.name === "exec" && namespace === "functions" && /tools: \{ exec_command\(args:/.test(tool.description ?? ""));
  if (code) return cmd => ({ type: "custom_tool_call", name: "exec", namespace: "functions", input: `text(await tools.exec_command(${JSON.stringify({ cmd, max_output_tokens: 3000 })}));` });
  return;
}

/** Derives offers only from the current request. Never opens files or runs a tool. */
export function routingInput(request: ModelRequest): SelectionInput | undefined {
  if (!Array.isArray(request.input) || request.previous_response_id || request.tool_choice === "none") return;
  const items = request.input;
  let userIndex = items.length - 1;
  while (userIndex >= 0 && !(items[userIndex]!.type === "message" && items[userIndex]!.role === "user")) userIndex--;
  if (userIndex < 0) return;
  const goal = textOf(items[userIndex]!);
  if (!goal || goal.length > 12000 || /<environment_context>|<INSTRUCTIONS>|<recommended_plugins>/.test(goal)) return;
  const execute = nativeExecutor(request);
  if (!execute) return;
  const tail = items.slice(userIndex + 1);
  // Once the coding model takes over, leave its reasoning/tool sequence alone.
  if (tail.some(i => (i.type === "message" && i.role === "assistant") || i.type === "reasoning"
    || ((i.type === "function_call" || i.type === "custom_tool_call") && !String(i.call_id).startsWith("call_jev_")))) return;
  const calls = tail.filter(i => (i.type === "function_call" || i.type === "custom_tool_call") && String(i.call_id).startsWith("call_jev_"));
  if (calls.length >= 4) return;
  const completed = calls.map(i => ({ id: String(i.call_id).slice("call_jev_".length).split("_")[0]!,
    outcome: tail.some(o => o.call_id === i.call_id && /_call_output$/.test(o.type)) ? "returned" as const : "pending" as const }));
  if (completed.some(c => c.outcome === "pending")) return;
  const matches = [...goal.matchAll(/[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*\.(?:[cm]?[jt]sx?|py|rs|go|java|vue|svelte|rb|md|toml|json|yaml|yml)(?=\b)/g)];
  const paths = [...new Set(matches.filter(m => !m.index || !/[\w./-]/.test(goal[m.index - 1]!)).map(m => m[0]))]
    .filter(p => !p.startsWith("/") && !p.split("/").includes("..") && !/(?:^|\/)(?:\.env|\.git|\.ssh|\.aws|\.codex|\.agents|auth\.json|credentials|secrets?)(?:[./]|$)/i.test(p));
  if (!paths.length || paths.length > 8) return;
  const offers: ToolOffer[] = paths.map(file => {
    const call = execute(`awk 'NR>160 {exit} {printf "%6d\\t%s\\n", NR, $0}' ${quote(`./${file.replace(/^\.\//, "")}`)}`);
    return { id: keyOf(call), description: `Codex reads the first 160 numbered lines of ${file}, a file explicitly named in the user request.`, call };
  }).filter(offer => !completed.some(c => c.id === offer.id));
  if (!offers.length) return;
  return { goal, offers, completed };
}
