import http, { type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { routingInput, type ModelRequest } from "./native-routing.js";
import type { NativeCall, ToolSelector } from "./tool-selector.js";

export type RouterEvent = Record<string, string | number | boolean>;
interface Options {
  selector: ToolSelector;
  token: string;
  upstream: string;
  port?: number;
  audit?: (event: RouterEvent) => void;
  allowLocalUpstreamForTests?: boolean;
}

function authorized(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function toolResponse(call: NativeCall, offerId: string) {
  const item = { ...call, id: `${call.type === "custom_tool_call" ? "ctc" : "fc"}_jev_${randomUUID().replaceAll("-", "")}`,
    call_id: `call_jev_${offerId}_${randomUUID().replaceAll("-", "")}`, status: "completed" };
  return { id: `resp_jev_${randomUUID().replaceAll("-", "")}`, object: "response", created_at: Math.floor(Date.now() / 1000),
    status: "completed", output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
}
function sendCall(res: ServerResponse, call: NativeCall, id: string, streaming: boolean) {
  const response = toolResponse(call, id);
  if (!streaming) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(response)); return; }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  let sequence = 0;
  const event = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  const item = response.output[0]!;
  const field = call.type === "custom_tool_call" ? "input" : "arguments";
  const prefix = call.type === "custom_tool_call" ? "response.custom_tool_call_input" : "response.function_call_arguments";
  event("response.created", { response: { ...response, status: "in_progress", output: [] } });
  event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", [field]: "" } });
  event(`${prefix}.delta`, { item_id: item.id, output_index: 0, delta: item[field] });
  event(`${prefix}.done`, { item_id: item.id, output_index: 0, [field]: item[field] });
  event("response.output_item.done", { output_index: 0, item });
  event("response.completed", { response });
  res.end();
}

/** A Responses transport adapter. Codex, never this server, executes selected tools. */
export async function startRouter(options: Options) {
  const upstream = new URL(options.upstream);
  const official = upstream.protocol === "https:" && ["api.openai.com", "chatgpt.com"].includes(upstream.hostname);
  const localTest = options.allowLocalUpstreamForTests && upstream.protocol === "http:" && upstream.hostname === "127.0.0.1";
  if ((!official && !localTest) || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error("Upstream must be an official OpenAI HTTPS endpoint");
  if (options.token.length < 24) throw new Error("Router token must be at least 24 characters");
  const server = http.createServer(async (req, res) => {
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableEnded) abort.abort(); });
    try {
      if (!authorized(typeof req.headers["x-jev-router-key"] === "string" ? req.headers["x-jev-router-key"] : undefined, options.token)) {
        res.writeHead(401); res.end("Router authorization required"); return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const suffix = url.pathname.replace(/^\/v1/, "");
      if (!((req.method === "POST" && ["/responses", "/responses/compact"].includes(suffix)) || (req.method === "GET" && suffix === "/models"))) {
        res.writeHead(404); res.end(); return;
      }
      if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") {
        res.writeHead(415); res.end("Disable request compression for the Jev provider"); return;
      }
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 16 * 1024 * 1024) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (req.method === "POST" && suffix === "/responses") {
        let request: ModelRequest;
        try { request = JSON.parse(body.toString("utf8")); } catch { res.writeHead(400); res.end("Invalid JSON"); return; }
        const input = routingInput(request);
        if (input) {
          try {
            const decision = await options.selector.select(input, AbortSignal.any([abort.signal, AbortSignal.timeout(6000)]));
            const offer = input.offers.find(o => o.id === decision.choice);
            if (offer) {
              options.audit?.({ kind: "selected", offerId: offer.id, tool: offer.call.name, ...decision, upstreamRequestSkipped: true });
              sendCall(res, offer.call, offer.id, request.stream === true);
              return;
            }
            options.audit?.({ kind: "handoff", ...decision });
          } catch {
            if (abort.signal.aborted) return;
            options.audit?.({ kind: "fallback", reason: "selector_failed_or_timed_out" });
          }
        }
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (["authorization", "content-type", "accept", "user-agent", "chatgpt-account-id", "openai-beta", "originator", "session_id", "conversation_id"].includes(name)
          || name.startsWith("x-codex-") || name.startsWith("x-openai-")) {
          if (typeof value === "string") headers.set(name, value);
        }
      }
      options.audit?.({ kind: "upstream", method: req.method ?? "", path: suffix });
      const target = `${options.upstream.replace(/\/$/, "")}${suffix}${url.search}`;
      const result = await fetch(target, { method: req.method!, headers, ...(req.method === "POST" ? { body } : {}), signal: abort.signal, redirect: "error" });
      res.statusCode = result.status;
      result.headers.forEach((value, name) => { if (!["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"].includes(name)) res.setHeader(name, value); });
      if (result.body) await pipeline(Readable.fromWeb(result.body as any), res);
      else res.end();
    } catch {
      if (!res.headersSent) { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "Jev router transport failed", type: "server_error" } })); }
      else res.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Router listener unavailable");
  return { url: `http://127.0.0.1:${address.port}/v1`, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
