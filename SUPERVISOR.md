# Jev-first task execution

The MCP integration still starts with a coding model deciding how to delegate. This optional execution mode starts with Jev instead:

```text
Task → Jev tool loop → collected evidence
                         │
                         ├─ exact check results → final result
                         │
                         └─ Codex edits or explains once
                                   │
                                   └─ runner verifies changed code
                                           └─ failed checks → one repair attempt
```

Jev owns source discovery and intermediate tool decisions. Codex receives the original goal and the actual collected evidence when code generation or an explanation is required. After an edit, the runner reruns previously selected checks directly; if none were selected, Jev chooses appropriate verification. Actual command results replace any check claims in the coding model's answer. Failed verification permits one further coding attempt, then returns an incomplete result. After a workspace change, historical source observations are withheld from repair input so the coder must obtain current source. An unresolved verification handoff is marked incomplete.

This is a standalone Node/Codex CLI integration. It does not replace the Codex desktop app's internal tool dispatcher. The existing MCP tool remains available inside Codex.

## Run

Requires the built package, `codex` CLI with working authentication, ripgrep, and the private TypeSafe environment file. The output directory must not already exist; its parent must exist.

```sh
node --env-file=/absolute/path/to/private.env scripts/supervisor.mjs \
  --root /absolute/path/to/project \
  --config /absolute/path/to/reviewed-tools.json \
  --output /absolute/path/to/new-run-directory \
  --goal "Run the tests, diagnose and fix the failure, then verify the change."
```

Omit `--goal` to read it from stdin. Optional `--model`, `--effort`, and `--tier` configure the coding phase. Without them, Codex uses its configured defaults. `--isolated` is for reproducible benchmarks: it ignores user/project configuration, disables browsing and multi-agent delegation, and uses the same isolation settings as the baseline benchmark.

The whole run has a 180-second budget and at most two coding invocations. Each Jev tool sequence also respects the configured tool and time limits. Interrupting the runner cancels pending tool/model work and terminates its coding subprocess group. The coding subprocess uses Codex's workspace-write sandbox and does not inherit the TypeSafe key. Configured check commands retain the existing allowlist and child-environment rules; they are not an OS sandbox.

## Inspect the result

- `final.json`: summary, source evidence, and actual check exit codes/counts.
- `summary.json`: status, total time, coding-invocation count, and provider usage.
- `jev-N.json`: full decisions and observations for each tool sequence.
- `coder-N.events.jsonl`, `.stderr.txt`, and `.final.json`: coding-phase evidence.
- stdout: a JSONL event stream that the benchmark can grade and account for.

A nonzero runner exit indicates incomplete execution or failed checks. A completed execution is not a proof of arbitrary task correctness. Source inspection and coding still require reviewing the result. Test counts are extracted from common Node test output; commands without recognizable counts report zero counts, while their actual exit code is always preserved.

## Validation and comparison

```sh
node --test scripts/supervisor.test.mjs
node scripts/benchmark.mjs \
  --integration supervisor \
  --output validation/new-supervisor-benchmark \
  --key-file /absolute/path/to/private.env \
  --repeats 3
node scripts/benchmark-report.mjs validation/new-supervisor-benchmark
```

The [18-run paired benchmark](docs/benchmarks/README.md) passed 9/9 tasks per arm. Jev-first execution used 58.7% less total time and 63.3% lower estimated API-equivalent cost; all nine matched tasks were faster. Excluding check-only tasks, the improvement was still 56.9% less time and 57.5% lower cost. This is a small three-task benchmark, not a claim about arbitrary repositories or subscription quotas.

The supervisor tests exercise real filesystem edits and test processes around a controlled coding callback. The live benchmark supplies the real Jev service and real Codex CLI, independently checks repaired behavior, and retains raw usage and all outcomes. A command-only task can use zero Codex calls; this is reported separately from tasks that require a coding model.
