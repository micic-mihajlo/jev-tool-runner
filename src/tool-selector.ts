import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { z } from "zod";
import { redact } from "./config.js";

export interface NativeCall {
  type: "function_call" | "custom_tool_call";
  name: string;
  namespace?: string;
  arguments?: string;
  input?: string;
}
export interface ToolOffer { id: string; description: string; call: NativeCall }
export interface SelectionInput {
  goal: string;
  offers: ToolOffer[];
  completed: { id: string; outcome: "returned" | "failed" | "pending" }[];
}
export interface Selection {
  choice: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}
export interface ToolSelector { select(input: SelectionInput, signal: AbortSignal): Promise<Selection> }

/** Selects one native call. No filesystem, tool execution, source inventory, or investigation loop. */
export class JevToolSelector implements ToolSelector {
  private readonly client: TypeSafeClient;
  constructor() {
    this.client = new TypeSafeClient({ defaultModel: process.env.TYPESAFE_MODEL || "jev-1.13.0",
      timeout: 5000, retry: { maxRetries: 0 }, logLevel: "off" });
  }
  async select(input: SelectionInput, signal: AbortSignal): Promise<Selection> {
    if (!input.offers.length || input.offers.length > 8) throw new Error("Expected 1–8 native tool offers");
    const options = Object.fromEntries(input.offers.map((offer, index) => [`t${index}`, offer.description]));
    options.handoff = "Let the coding model reason, write code, answer the user, or choose a call not offered here. Use when these calls are unnecessary or conflict with the task.";
    const start = performance.now();
    const response = await this.client.systemOne({
      state: { goal: redact(input.goal).slice(0, 2400), completed: input.completed.slice(-8) },
      questions: { next: choice("Choose the next tool call for the coding agent to execute. Read explicitly requested files before answering about them. Only choose an offered call that advances the user's request. Do not repeat completed calls. Code and tool results stay with the coding agent; you select a call, not its answer.", options) },
    }, { signal });
    const answer = z.object({ choice: z.string() }).parse(response.answers.next);
    if (!Object.hasOwn(options, answer.choice)) throw new Error("Unknown selection");
    const selected = answer.choice === "handoff" ? "handoff" : input.offers[Number(answer.choice.slice(1))]!.id;
    return { choice: selected, durationMs: Math.round(performance.now() - start), inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
  }
}
