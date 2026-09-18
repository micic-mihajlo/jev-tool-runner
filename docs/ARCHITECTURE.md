# Native tool selection architecture

![Native tool routing](diagrams/architecture.svg)

[D2 source](diagrams/architecture.d2). GitHub displays the committed SVG; regenerate it with `npm run diagram`.

1. Codex prepares its ordinary Responses request, containing the current task, native tool catalog and prior results.
2. A local provider adapter constructs eligible concrete calls from that request. It does not read the repository or execute anything.
3. Jev chooses a call or hands off to the coding model. Its state contains the goal and completion metadata, not raw source output. There are at most eight options.
4. The adapter emits the selected native function/custom-tool call using the Responses streaming protocol. The coding model has not been invoked for that decision.
5. Codex dispatches it through its own tool runtime, approvals and sandbox. Codex receives the result in its conversation.
6. Codex's next request either permits another bounded selection or passes unchanged to the coding model. Reasoning, edits, unsupported tool selection and answers remain with that model.

A `PreToolUse` hook is too late to replace the model decision that already produced the call. MCP delegation leaves the coding model choosing whether to delegate. The provider adapter occupies an earlier boundary and can skip that model request entirely for an eligible call.

## Components

| File | Responsibility |
| --- | --- |
| `src/tool-selector.ts` | Stateless TypeSafe choice over host-supplied native calls; no tool execution |
| `src/native-routing.ts` | Codex request adapter, narrow candidate construction and completed-call exclusion |
| `src/router-server.ts` | Authenticated loopback Responses transport, synthetic call streaming, unchanged upstream forwarding |
| `src/router-cli.ts` | Process-scoped Codex provider setup and router lifecycle |
| `scripts/router-live-smoke.mjs` | Actual Codex execution, audit assertions and baseline/outage trials |

## Boundaries

The server accepts authenticated loopback requests only. It forwards existing Codex authentication only to a fixed official OpenAI HTTPS endpoint, strips its own local authentication header, and does not log credentials. Unsupported API endpoints are rejected; the server is not a general proxy. A disconnected Codex client cancels the pending selector/upstream operation.

Selection failure falls back to the original model request. The router neither overrides an approval denial nor retries a completed call. It never inserts a fabricated tool result. Native tools still run under Codex's selected permissions.

Current candidate construction covers explicitly named relative source files only. It offers bounded reads, with no workspace inventory. Once the coding model takes over, the adapter leaves that continuation alone. This initial version does not route arbitrary tools or generate open-ended arguments. The generic selection interface is independent of that adapter and can accept other concrete calls supplied by a host.

The CLI wrapper is tested against Codex 0.153.4, including its `additional_tools` namespace catalog and custom `functions.exec` envelope. Public function-tool catalogs are also supported. Unknown catalog shapes fall back to the coding model. Request compression is disabled for this process; WebSocket support is not advertised. No global configuration or hook-trust bypass is installed.

## Legacy implementation

`Workspace`, `runTools`, the MCP server and `hooks.ts` implement the older autonomous investigator. They remain for compatibility and regression history, but are not called by the native router. Their [supervisor diagram](diagrams/supervisor.svg) and [benchmark data](benchmarks/README.md) describe a different architecture.
