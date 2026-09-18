# Use the MCP tool in Codex

For automatic use in normal sessions, follow [hooks + MCP installation](DAILY-USE.md). The setup below registers only the MCP tool; it does not automatically invoke Jev.

Build the package first with `npm ci && npm run build`. Keep the TypeSafe key in a private environment file. Choose a fixed repository root and a reviewed command configuration.

Copy [the TOML template](../integration/codex.project.toml) into the trusted project's `.codex/config.toml`, replacing every absolute-path placeholder. Use an absolute Node executable path if `node` is unavailable on the desktop app's PATH. The tool timeout should exceed the runner's configured time budget.

The template launches:

```sh
node --env-file=/absolute/path/to/private.env /absolute/path/to/jev-tool-runner/dist/cli.js \
  serve --root /absolute/path/to/project \
  --config /absolute/path/to/reviewed-tools.json
```

A command configuration is an explicit allowlist:

```json
{
  "commands": [
    {"id":"tests","description":"Run project tests","argv":["npm","test"],"timeoutMs":30000},
    {"id":"typecheck","description":"Check TypeScript","argv":["npm","run","check"],"timeoutMs":30000}
  ],
  "maxSteps": 10,
  "timeoutMs": 90000,
  "maxCandidates": 96
}
```

`examples/project-tools.json` supplies those two commands for this repository. Use commands appropriate to your target project; they execute inside its fixed root.

After changing the server configuration or rebuilding its implementation, reload the MCP connection or reopen the task so its process and tool catalog are refreshed. `codex mcp get jev_tools --json` can inspect the registration; consult `codex mcp --help` for the installed CLI's management options.

## Delegate once

For investigation:

```json
{"goal":"Run tests, inspect the failing test and implementation, and return the evidence needed to fix the issue."}
```

The parent coding agent receives actual outputs and performs any edit. Reuse the evidence instead of repeating completed reads. If files change, checks may need to run again.

For known checks only:

```json
{"goal":"Run the tests and TypeScript check after the edit.","commandIds":["tests","typecheck"]}
```

Do not include `commandIds` in an investigation request: doing so selects direct execution and skips diagnosis. Do not supply a caller-level `maxSteps`; the server manages its configured budget.

`returned_results` means observations were collected. A failing test can have this status. Inspect each `exitCode`, and pay attention to truncation or pagination markers. `needs_coding_agent` means the next step requires editing, deeper reasoning, or an unavailable capability.

For the alternative where Jev starts the entire task and invokes Codex itself, see [Jev-first execution](../SUPERVISOR.md).
