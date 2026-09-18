# Everyday Codex integration

Install once in a trusted repository, review its hooks, and continue using normal Codex sessions. You do not need to launch the standalone supervisor for each task.

The integration combines automatic hooks with the `jev_tools.run_tools` MCP server. It is supported on macOS and Linux. The live CLI check uses Codex 0.153.4; the desktop uses the same configuration format, but desktop hook execution must be confirmed in a new session with the doctor command.

## Install

From this package, after `npm ci`:

```sh
npm run codex:install -- \
  --root /absolute/path/to/your/project \
  --config /absolute/path/to/reviewed-tools.json \
  --key-file /absolute/path/to/private.env \
  --verify tests,typecheck
```

The private env file contains `TYPESAFE_API_KEY`. Keep it outside tracked source and readable only by your account. `--verify` names exact commands in the reviewed configuration. Omit it to disable automatic verification. Commands can execute project code with the hook process's permissions, so only include checks you intend to run automatically after edits. A TypeScript example is [project-tools.json](../examples/project-tools.json).

The installer merges handlers into `.codex/hooks.json` and adds a marked MCP section to `.codex/config.toml`. It preserves unrelated hooks and settings, refuses an unmanaged `jev_tools` collision, and keeps initial backups in `.codex/jev/`. It stores private settings and state there, too. It adds a local Git exclusion for `.codex/`; already-tracked files still require your attention. The API key is never copied into these generated files.

**Open a new trusted Codex session in the target project and use `/hooks` to review and trust the installed definitions.** Codex requires this review; installation does not grant trust. Changed hook definitions require another review. Do not use the test harness's trust-bypass flag for everyday sessions. Restart existing sessions after installation or updates so MCP and hook registrations refresh.

Check the installation:

```sh
npm run codex:doctor -- --root /absolute/path/to/your/project
```

The doctor checks registration, prerequisites, command IDs, and key-file readability. `lastObservedHooks` shows up to five recent per-session investigation/verification records since the latest installation. An empty list means execution has not been observed; a configured file alone does not establish that hooks ran. The doctor cannot establish Codex's trust state: use `/hooks` for that.

## What happens during a task

1. **SessionStart** supplies concise instructions about evidence reuse, MCP delegation, and data disclosure.
2. **UserPromptSubmit** starts Jev before the coding model. Jev chooses bounded repository reads/searches/Git inspection with no coding-model round trips. It cannot execute configured shell commands in this automatic phase. Defaults: six steps and 15 seconds, configurable with installer `--timeout` up to 30 seconds. Simple acknowledgments are skipped. Collected evidence is capped at 18,000 characters.
3. **Codex** uses that evidence to edit or explain. If more investigation is necessary, it can call `jev_tools.run_tools`. Known checks can use `commandIds` with zero Jev decisions. This additional delegation remains a model choice.
4. **PreToolUse** catches a narrow set of exact redundant shell calls: a complete `cat relative/path` already supplied by the hook, or an exact configured check already recorded at the current revision. It returns the previous result instead of permitting the redundant call. A deliberate retry is allowed after one correction, preventing denial loops. Compound shell commands, partial/paginated reads, different working directories, and unrecognized calls are left alone.
5. **PostToolUse** records patch activity from this Codex session. **Stop** compares the workspace revision. If this session used `apply_patch` and files changed, it runs the configured verification commands directly, once for that revision, preserving actual exit codes. The first failed verification can continue Codex with the failure evidence. Further unchanged stops do not rerun checks, and at most two automatic verification attempts are allowed per turn. A later failure or exhausted budget is visibly reported; it is not relabeled success.
6. **Interrupt** marks the active session cancelled; the running hook aborts its model/tool operation. SessionEnd also signals cancellation. Cancellation is scoped to the session.

There is deliberately no test run after every individual patch. Changes are checked at the end of a turn. Edits made through arbitrary shell commands require explicit checks; they are not attributed automatically. External edits alone do not trigger verification in a read-only task. The revision follows the runner's metadata-based inventory and exclusions; preserving both size and mtime, excluded files, or the inventory cap can hide changes. This is not a content-hash completeness guarantee.

## Failure behavior and limits

Provider failure or timeout produces a visible degraded-mode message and allows normal Codex tools to continue. Exact post-edit verification does not require a functioning TypeSafe API. A missing or unreadable installation/env file can prevent the handler from reaching verification; that produces an unavailable warning. Do not report verification success from an absent hook.

The session lock avoids duplicate concurrent work. Locks left by a crashed process expire after the longer configured run budget plus one minute. Evidence collected across an observed concurrent workspace change is withheld. State is isolated by hashed session ID and turn ID, so one task cannot consume another's cached observations.

Hooks are a workflow integration, not an unbypassable tool dispatcher or security boundary. They can be untrusted, disabled, unavailable, or bypassed by unsupported tool paths; an error in a hook does not generally block Codex. Hosted tools and some specialized paths have different coverage. The integration does not claim to route every tool through Jev or eliminate coding-model reasoning. See the [official hook coverage and failure contract](https://learn.chatgpt.com/docs/hooks#tool-coverage).

Automatic hooks send selected source and tool output to TypeSafe. Locally retained evidence can contain source, and is written with private permissions under `.codex/jev/state`. Only the latest investigation and verification summary per session is retained; these contain timing, token counts and check exit codes, not the prompt or source. The separate session state contains the bounded evidence. There is no remote telemetry service. Remove old state when no session is using it.

## Update or uninstall

Keep the package checkout at a stable path. Build updated source with `npm ci && npm run build`, rerun the install command, restart Codex, and review any changed hook definitions. The installer is repeatable and does not accumulate duplicate handlers. It refuses to overwrite an edited managed MCP section.

```sh
node scripts/codex-integration.mjs uninstall --root /absolute/path/to/your/project
```

Uninstall removes only its own handlers and marked MCP section. It preserves unrelated configuration, initial backups, and private run state. Restart the Codex session afterward.

## Verification

The local tests exercise real filesystem state, subprocess checks, freshness, duplicate handling, outages, interruption, session isolation, installation, and removal. They use a controlled decision provider to isolate those contracts.

[Recorded live smoke results](evidence/codex-hooks.json) include a successful provider-backed run and an outage run. They demonstrate actual hook execution, edits and passing verification, not production-wide reliability or measured savings.

The optional live check runs an actual Codex process and actual TypeSafe requests against a disposable fixture:

```sh
mkdir -p runs
node scripts/codex-live-smoke.mjs \
  --key-file /absolute/path/to/private.env --output runs/live-hooks
node scripts/codex-live-smoke.mjs \
  --key-file /absolute/path/to/private.env --output runs/offline-hooks --offline
```

Both output paths must be new. These consume Codex usage; the first also calls TypeSafe. The harness asserts that UserPromptSubmit actually ran, a real implementation edit happened, and Stop actually ran a passing check. It retains raw events and summaries locally. The offline case points the hook at an unavailable local endpoint and requires normal coding plus verification to recover.

The harness's isolated CLI mode does not discover project file configuration in the tested CLI build, so it supplies the installed fixture hook definitions explicitly. Only these vetted fixture hooks use the per-invocation hook-trust bypass. This validates hook execution, not a user's trust approval or desktop UI. Normal project MCP discovery is checked separately. The older [benchmarks](benchmarks/README.md) measure the MCP/supervisor implementations; their savings are not evidence of this hook integration's everyday savings.
