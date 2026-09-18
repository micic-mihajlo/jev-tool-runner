# Contributor instructions

Use the installed TypeSafe skill for changes to Jev decisions or SDK integration, and verify the current TypeSafe documentation.

The primary integration is now the native Codex provider router. Jev selects a concrete native call before coding-model inference; Codex executes it and owns its results. The selector must not read repository files, execute tools, or grow into a second investigator. The older Workspace/MCP/hooks path is legacy and must not be presented as replacing Codex's tool decisions.

Keep the decision loop separate from code generation. Jev selects concrete, bounded actions; the host owns execution, command allowlists, cancellation, and verification. Preserve actual tool outputs and exit codes.

If `jev_tools.run_tools` is configured for this checkout, delegate coherent inspections to it and reuse the returned observations. For exact configured checks, supply `commandIds`; omit them for investigations. Never supply a caller-level `maxSteps`.

Run `npm run test:all` and `npm run check` for runtime changes. Tests do not require live API credentials. Live benchmarks are opt-in and should retain every run, including failures. Keep credentials, local configs, and raw session logs out of Git. Published benchmark numbers must remain traceable to the curated data.

Diagram source is `docs/diagrams/architecture.d2`; regenerate its SVG with `npm run diagram` after editing it.
