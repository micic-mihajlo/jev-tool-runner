# Architecture

The design separates selecting the next action from generating code. The host constructs concrete tool candidates and executes them; Jev chooses among those candidates; Codex is invoked for editing or explanation.

![Jev-first task flow](diagrams/architecture.svg)

[D2 source](diagrams/architecture.d2). GitHub does not list D2 among its [native diagram syntaxes](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams), so this repository embeds a committed SVG produced by the [D2 CLI](https://d2lang.com/tour/exports/). To regenerate it with D2 0.9.0, run `npm run diagram` from the repository root. The SVG contains its styling and fonts; viewing the README does not call a diagram-rendering service.

## One decision step

1. `Workspace.snapshot()` inventories permitted files and computes a revision from sorted path, size, modification-time, and symlink metadata.
2. `Workspace.candidates()` assembles executable reads, searches, Git inspections, and configured commands. Calls already observed at the same revision are omitted; paginated reads advance to their next line.
3. `JevDecider` sends the goal, bounded recent observations, and candidate descriptions to TypeSafe's Choice primitive. Short request-local choice keys map back to stable internal action IDs.
4. `runTools()` executes the selected action immediately. Its output and exit code become an observation for the next decision.
5. Jev can return the collected results or hand control back for coding/reasoning. Step limits, deadlines, errors, and cancellation also preserve collected observations.

No generative-model call occurs between these steps. Confidence is retained in full traces but does not trigger repeated deliberation on an otherwise valid choice. Typed choice validation prevents dispatching an action outside the offered set; it does not establish task correctness.

## Two integrations

### MCP

The parent coding agent calls `run_tools` with a complete investigation goal, then uses the returned source and command evidence. The parent owns edits. The compact MCP response omits internal action hashes, workspace revisions, and per-decision records.

When the caller supplies `commandIds`, the host executes those exact configured commands in order without indexing source or calling Jev. This mode returns check results only; it does not diagnose failures. Failed command exit codes remain visible even when the tool sequence returns normally.

### Jev-first supervisor

The supervisor starts `runTools()` directly. If a normally completed sequence contains only command results, it can format the result without invoking Codex. Otherwise it calls Codex with the original goal and collected evidence.

The coding phase may inspect further if evidence is missing. After a workspace change, the supervisor replays previously selected checks directly. If no checks were selected, it asks Jev to choose verification. A failed check permits one additional coding attempt. Historical source is withheld after changes so repair attempts must obtain current content. An unresolved verification handoff produces an incomplete result.

Observed check results replace model-authored check claims. This is important: the coding model's final prose is not used as proof that a command passed.

## Modules

| File | Responsibility |
| --- | --- |
| `src/workspace.ts` | Inventory, revisions, candidates, source/Git operations, command dispatch |
| `src/jev.ts` | TypeSafe SDK adapter, Choice validation, usage |
| `src/controller.ts` | Execution loop, direct checks, budgets, cancellation, observations |
| `src/process.ts` | Bounded subprocess output, environment, timeout and process termination |
| `src/mcp.ts` | MCP tool schema, serialization, concurrent-call guard |
| `src/cli.ts` | Tool-loop CLI and MCP server entry points |
| `scripts/supervisor-core.mjs` | Coding handoff, verification, retry and check extraction |
| `scripts/supervisor.mjs` | Codex subprocess integration, private run artifacts, usage aggregation |
| `scripts/benchmark.mjs` | Fresh workspaces, counterbalanced trials, independent grading |

## Limits and trust boundaries

Defaults are 10 steps, 90 seconds per tool sequence, and 96 candidates. The supervisor has a 180-second overall deadline and at most two coding invocations. The index is capped at 5,000 files. Reads use bounded pages of up to 90 lines, reject binaries/symlinks/large files, and report truncation.

The revision is metadata-based, not a content hash: a same-size rewrite preserving modification time may be invisible. Excluded files and files beyond the inventory cap do not participate. Candidate discovery uses goal terms, file names, and recent output references; it can miss the action needed for a task.

The runner excludes conventional credential paths and redacts known key patterns. TypeSafe receives selected repository content and tool output; Codex receives coding-phase evidence. Source and command output remain untrusted inputs. Filtering is not a guarantee that arbitrary content is free of secrets.

Configured commands are reviewed argument arrays and run without shell interpolation. They can still execute project code with the host's permissions. Codex uses its own workspace-write sandbox. These are distinct execution boundaries.

The adapters currently cover repository tools. Browser control, arbitrary third-party MCP calls, and a replacement for Codex's internal dispatcher are outside this implementation.
