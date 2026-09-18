# Benchmark results

Starting the task with Jev produced the strongest result: **58.7% less total wall time and 63.3% lower estimated API cost**, with 9/9 graded completions in each arm. This is an exploratory experiment across three small task types. It does not establish performance on large feature work, unfamiliar repositories, or long debugging sessions.

The first implementation was slower. All three experiments are included so the architectural change and its limits are visible.

## Three iterations

Each experiment ran three tasks three times per arm: nine plain-Codex runs and nine treatment runs. Every arm completed 9/9 under the stated graders.

| Experiment | Plain Codex time | Treatment time | Plain Codex estimated cost | Treatment estimated cost | Interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| [Initial MCP](data/initial-mcp.json) | 266.7 s | 335.4 s | $2.0149 | $1.9610 | 25.8% more time; 2.7% lower cost |
| [Revised MCP](data/revised-mcp.json) | 311.5 s | 260.3 s | $2.3572 | $1.8631 | 16.4% less time; 21.0% lower cost |
| [Jev-first supervisor](data/jev-first.json) | 353.6 s | 146.1 s | $2.1759 | $0.7995 | 58.7% less time; 63.3% lower cost |

These are separate experiments with their own baselines, not interchangeable runs. Provider latency and cache behavior varied between experiments.

**Initial MCP:** Codex still decided when to delegate. Six invalid step-budget arguments caused retries. The treatment made 19 MCP attempts, of which 13 ran successfully, with 50 Jev decisions and 37 inner tool calls. Simple checks were slower in all three pairs.

**Revised MCP:** The server owned the step budget; shorter provider option keys and compact results reduced overhead. Explicit `commandIds` ran known checks without model decisions. There were no rejected calls. Aggregate gains were concentrated in source inspection: the median paired latency change was still 2.6% slower. One repair run requested direct checks when investigation was needed, then used native Codex source inspection; that run remains included.

**Jev-first:** The supervisor started with Jev, handed collected evidence to Codex only for edits or explanations, and verified edits outside the coding-model loop. Every one of the nine pairs was faster. Three check-only tasks used no coding-model call; the other six used one coding invocation each. The treatment made 40 Jev decisions and 34 tool calls across 12 sequences. It made one native Codex command call, compared with 49 in the baseline.

## Jev-first detail

| Metric, summed over nine runs | Plain Codex | Jev-first |
| --- | ---: | ---: |
| Wall time | 353,612 ms | 146,139 ms |
| Codex input tokens | 757,093 | 184,709 |
| Codex cached input tokens | 625,408 | 121,216 |
| Codex output tokens | 15,552 | 4,736 |
| Jev input tokens | 0 | 121,940 |
| Jev output tokens | 0 | 12,919 |
| Estimated Codex cost | $2.1758864 | $0.7943568 |
| Estimated Jev cost | $0 | $0.00512148 |
| Estimated combined cost | $2.1758864 | $0.79947828 |

Codex input fell 75.6% and output fell 69.5%. Input counts include cached input; they are not counts of unique source tokens. Reasoning output is already part of output tokens and is not charged twice.

| Task | Plain Codex median | Jev-first median |
| --- | ---: | ---: |
| Membership bug fix | 41,766 ms | 20,701 ms |
| Source inspection | 55,155 ms | 24,678 ms |
| Project checks | 16,538 ms | 4,958 ms |

Excluding check-only tasks leaves six runs per arm: **304.1 → 131.0 seconds** and **$1.8811 → $0.7986**, or 56.9% less time and 57.5% lower estimated cost. The result is therefore not solely explained by avoiding Codex for an already-known command sequence.

## Method

Recorded September 18, 2026, using Codex CLI 0.153.4, requested model `gpt-5.6-sol`, medium reasoning, and priority service in both arms. Jev used `jev-1.13.0`. Runs were sequential with counterbalanced arm order, fresh Git workspaces, identical frozen task sources per arm, and a 180-second budget per run. No failed formal run was discarded or replaced. Setup, development, this conversation, and separate calibration runs are excluded from the formal totals.

The baseline used normal Codex tools and could batch commands. The treatment used MCP delegation in the first two experiments and the Jev-first supervisor in the third. User configuration and project instructions were isolated by the harness; the installed skill catalog was shared by both arms. Both arms received the same task and output schema.

The three tasks were:

1. **Membership bug fix.** Repair the included fixture so only active memberships receive messages, preserve its tests, and verify. An independent held-out check required denial for missing, undefined, removed, pending, suspended, and empty status, and allowed active status. The grader also checked that only implementation files changed.
2. **Source inspection.** Explain stable action identifiers and suppression of repeated actions by workspace revision, using real source evidence. No edits or test execution were needed. The grader checked evidence collection and relevant facts; answers were also manually reviewed.
3. **Project checks.** Run actual `npm test` and `npm run check`, preserve source, and report both results. The initial snapshot contained 14 runner tests; later snapshots contained 17. The additional supervisor and accounting suites are separate development checks.

For the initial experiment, two successful baseline type checks emitted no npm banner. Grading was corrected uniformly to accept the actual configured command and exit code; all original runs remained included. A controller status of `returned_results` alone never established a passing test.

### What the public data contains

The three linked JSON files preserve per-run elapsed time, provider usage, tool counts, exit status, and grading assertions. They are curated numeric exports, not full raw session archives. Raw source-bearing traces, final answers, local paths, and private machine configuration are retained locally and omitted from this repository. Consequently, the public data supports recalculating the reported totals but cannot independently establish every semantic grading judgment.

`counts.coderInvocations` counts supervisor-triggered coding phases only. A baseline value of zero does **not** mean the baseline used no Codex process; every baseline run launched Codex. `jev.totalMs` measures runner sequences and includes tool execution, not just provider latency.

The published supervisor also contains two subsequent hardening changes: stale source observations are withheld after a repair changes the workspace, and an unresolved verification handoff is marked incomplete. Neither branch occurred in the measured supervisor runs. All six measured initial coding inputs were checked to remain identical under the hardened serializer. The historical timings describe the immediately preceding implementation on those exercised paths, not a rerun of this publication commit.

### Cost calculation

Dollar figures are **API-equivalent estimates**, not subscription invoices or measured Codex quota savings. Historical rates were recorded with the experiment from [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and [TypeSafe models](https://docs.typesafe.ai/models). Rates may change.

| Token category | USD per million tokens |
| --- | ---: |
| Codex priority uncached input | 8.00 |
| Codex priority cached input | 0.80 |
| Codex priority cache writes | 10.00 |
| Codex priority output | 40.00 |
| Jev input | 0.042 |
| Jev output | 0.00 |

For each run, using the usage fields in the data:

```text
Codex = ((input - cached - cache_write) × 8
         + cached × 0.8 + cache_write × 10 + output × 40) / 1,000,000
Jev   = jev_input × 0.042 / 1,000,000
Total = Codex + Jev
```

No cache-write tokens were reported in the Jev-first experiment. Savings are `1 - treatment_total / baseline_total`. Aggregate percentages use summed times and costs; they are not averages of per-run percentages.

## Run a new experiment

Install dependencies, build, authenticate the Codex CLI, and provide a private TypeSafe environment file. This sends selected project source and tool output to the configured model providers and consumes their usage. Choose a new output directory for each experiment.

```sh
npm ci
npm run build
node scripts/benchmark.mjs \
  --integration supervisor \
  --output runs/my-supervisor-benchmark \
  --key-file /absolute/path/to/private.env \
  --model gpt-5.6-sol --effort medium --tier priority \
  --repeats 3
node scripts/benchmark-report.mjs runs/my-supervisor-benchmark
```

Use `--integration mcp` to test the current MCP path. The current harness does not recreate the retired initial implementation. Adjust the model and service tier to those available to your account, and review the report's historical pricing assumptions before treating a new dollar estimate as current.

The harness retains methodology, usage, raw events, outcomes, and grading artifacts in the ignored output directory. Review raw files for source or credentials before sharing them. See [the supervisor guide](../../SUPERVISOR.md) for run artifacts and behavior.

## What remains unproven

Three task types with three repeats each are too small to establish broad reliability or statistical significance. Tasks were used while developing the controller rather than held out as an unseen evaluation set. Source inspection targets this project's own implementation. Provider latency, caching, and installed skill context were not normalized. The benchmark does not cover large repositories, multi-file feature delivery, browser/computer use, or long recovery chains. A broader unseen task set and independently reviewed task outcomes are the next meaningful validation.
