# Use Jev inside the Codex tool-decision loop

Build the package with `npm ci && npm run build`. Keep a private env file containing `TYPESAFE_API_KEY`.

From any repository, launch:

```sh
node /absolute/path/to/jev-tool-runner/dist/router-cli.js \
  --key-file /absolute/path/to/private.env -- \
  -C /absolute/path/to/project
```

The wrapper starts a loopback-only Responses router, launches Codex with a temporary custom-provider configuration, and closes the router when Codex exits. Your normal model and permission settings remain in force. The TypeSafe key and any extra variables loaded from its private env file are not passed to Codex. Existing upstream authentication is forwarded only to the configured official OpenAI endpoint; it is never sent to TypeSafe or written to the audit log.

The default upstream is the ChatGPT Codex endpoint and uses your existing Codex login. For API authentication, set `--upstream https://api.openai.com/v1` and use Codex's normal API login. Do not pass an unrelated proxy endpoint: the router rejects it.

## Existing tasks

Use `resume` through the wrapper:

```sh
node /absolute/path/to/jev-tool-runner/dist/router-cli.js \
  --key-file /absolute/path/to/private.env -- \
  resume YOUR_SESSION_ID
```

Do not simultaneously operate the same session from the desktop and CLI. This wrapper does not hot-swap the provider of a task already running in the desktop. It also does not install global hooks or change your account's model settings.

## What Jev does

When Codex is about to request a model response, the adapter examines the current user message and Codex's advertised tools. For supported requests it constructs a small set of concrete native calls. Jev chooses one or hands off. A chosen call returns through the normal Responses tool-call stream; Codex executes it. The next request already contains Codex's tool result. Once available calls are done, the original request and full results go to the coding model.

Currently supported offers are reads of explicitly named relative source files, capped at 160 numbered lines and the native output budget. At most four calls are selected in one initial sequence. Paths outside this adapter's narrow syntax, credential paths, unsupported tools, missing context, stored-response continuations, and a coding-model continuation go directly to the coding model. This is not general repository exploration or automatic test selection.

Jev receives goal text, offer descriptions and call completion IDs. It does not receive source output, developer instructions, authentication headers or the whole conversation. There is no source inventory and no filesystem/tool executor in the routing component. The host remains responsible for permissions; a Jev choice does not grant approval. A tool failure remains in the Codex conversation, and the coding model handles it.

## Observe and stop

Add a new private audit path before `--`:

```sh
--audit /absolute/path/to/new-router-log.jsonl
```

Audit events distinguish `selected`, `handoff`, `fallback`, and `upstream`. A `selected` event records TypeSafe time and token usage, plus `upstreamRequestSkipped: true`. Model-list requests are ordinary initialization, not coding-model inference. Native tool execution appears in Codex's own transcript. Correlate both when validating routing.

Logs omit prompts, source output, raw tool arguments and credentials. Zero usage on a synthetic Responses tool call means no OpenAI generation occurred for that response; TypeSafe usage is recorded separately. Do not treat it as a free overall task.

Closing Codex stops the local router. To use ordinary Codex again, launch `codex` directly. No configuration rollback is required.

## Remove the old investigation hooks

If you installed the earlier hooks in a project, remove them before testing native routing:

```sh
node /absolute/path/to/jev-tool-runner/scripts/codex-integration.mjs \
  uninstall --root /absolute/path/to/project
```

That preserves other hooks, settings and prior evidence. Restart existing sessions to unload the old registration. Hook-based autonomous investigation is a separate legacy implementation and is not part of this router.

## Validation limits

Local integration tests cover selection, source isolation, duplicate suppression, streaming, authentication, upstream forwarding and provider failure. The opt-in live harness launches the actual Codex CLI with normal permissions. It must observe both a selected call and native execution before reporting success.

The checked-in evidence contains sanitized metrics only. Private source and session logs stay local. The sample is small; cache state, extra model-selected tools and network time affect end-to-end comparisons. It does not establish broad cost savings or desktop hot-integration.
