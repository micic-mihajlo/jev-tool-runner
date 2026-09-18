# Jev native tool router

Jev selects a native Codex tool call **before the coding model is invoked**. Codex executes that call through its own tool runtime, approvals and sandbox. The result stays in Codex's conversation. The coding model handles reasoning, edits and the final answer.

The router does not open repository files, execute commands, or conduct a separate investigation. TypeSafe receives the current user goal, a small set of tool choices, and completion metadata—not source-file output.

![Native tool routing](docs/diagrams/architecture.svg)

## Run it

Requires Node.js 22+, an authenticated Codex CLI, and a TypeSafe key in a private env file. Verified with Codex CLI 0.153.4.

```sh
npm ci
npm run build

# Start a normal interactive Codex session in your project:
node /absolute/path/to/jev-tool-runner/dist/router-cli.js \
  --key-file /absolute/path/to/private.env -- \
  -C /absolute/path/to/your/project
```

Ask a task that names source files, for example:

> Read src/access.mjs and test/access.test.mjs, then explain the access check.

For an existing session, pass `resume SESSION_ID` after `--`. The wrapper supplies a local model provider for that process; it does not modify global Codex configuration or change the selected model, reasoning effort, permissions, or hook trust.

[Daily use](docs/DAILY-USE.md) · [Architecture](docs/ARCHITECTURE.md) · [Live validation](docs/evidence/native-routing.json)

## Current coverage

The Codex adapter offers bounded, numbered reads of relative source paths explicitly named in the current user message. Jev chooses among at most eight offers or hands control to the coding model. Codex executes at most four selected calls before handoff. Completed calls are excluded. Unsupported requests, missing tool support, provider failures and timeouts fall back to the ordinary coding-model request.

This is a working integration at the tool-decision boundary, with intentionally narrow candidate coverage. Automatic search planning, arbitrary command argument generation, test selection and browser/computer-use routing are not implemented. It does not replace every tool decision. The exported `ToolSelector` interface can choose among other host-supplied native calls without gaining execution privileges.

The desktop app's already-running tasks are not patched by this wrapper. Use the wrapper to launch or resume a Codex CLI session. An optional MCP call or `PreToolUse` hook cannot remove reasoning that has already occurred; this implementation intercepts the model-provider request instead.

## Verify it

```sh
npm run test:all
npm run check

node scripts/router-live-smoke.mjs \
  --root /absolute/path/to/repo \
  --goal 'Read src/access.mjs and explain its access check. Do not edit anything.' \
  --key-file /absolute/path/to/private.env \
  --output runs/new-live-run
```

The live harness asserts that Jev actually selected a call before the first coding-model request, that Codex actually executed the selected read, and that the coding model answered. It retains failed runs too. Add `--baseline` for an ordinary Codex comparison or `--offline` for the provider-outage check. These runs consume usage; they are not run by CI.

## Earlier implementation

The older autonomous runner, MCP server and investigation hooks remain available for compatibility. They are **not** the native tool selector, and their [historical benchmarks](docs/benchmarks/README.md) do not establish savings for this architecture. [Legacy hooks and removal](docs/LEGACY-HOOKS.md) · [Legacy MCP setup](docs/CODEX.md).

[TypeSafe function calling](https://docs.typesafe.ai/cookbooks/function_calling) · [Codex custom model providers](https://developers.openai.com/codex/config-advanced#custom-model-providers)
