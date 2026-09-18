import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function estimateCost(usage, jev, rates) {
  if (!usage) return null;
  const cached = usage.cached_input_tokens ?? 0;
  const written = usage.cache_write_input_tokens ?? 0;
  const uncached = usage.input_tokens - cached - written;
  assert.ok(uncached >= 0, "Cache counts cannot exceed total input tokens.");
  const codex = (uncached * rates.inputPerMillion + cached * rates.cachedPerMillion
    + written * rates.cacheWritePerMillion + usage.output_tokens * rates.outputPerMillion) / 1_000_000;
  const typesafe = (jev?.inputTokens ?? 0) * 0.042 / 1_000_000;
  return { codex, typesafe, total: codex + typesafe };
}

export const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const sum = (values) => values.reduce((total, value) => total + value, 0);
const savings = (baseline, treatment) => Number.isFinite(baseline) && baseline > 0 && Number.isFinite(treatment) ? 100 * (baseline - treatment) / baseline : null;
const seconds = (ms) => (ms / 1000).toFixed(2);
const dollars = (value) => value === null ? "unavailable" : `$${value.toFixed(4)}`;
const percentage = (value) => value === null ? "unavailable" : `${value.toFixed(1)}%`;
const change = (value, decrease, increase) => value === null ? "unavailable" : `${Math.abs(value).toFixed(1)}% ${value >= 0 ? decrease : increase}`;

export function summarize(rows, metadata) {
  const rates = metadata.serviceTier === "priority" || metadata.serviceTier === "fast" ? metadata.costBasis.fast : metadata.costBasis.standard;
  const costs = rows.map((row) => estimateCost(row.usage, row.jev, rates));
  const known = costs.filter(Boolean);
  return {
    runs: rows.length, passed: rows.filter(({ grading }) => grading.passed).length,
    elapsedMs: sum(rows.map(({ elapsedMs }) => elapsedMs)), medianElapsedMs: median(rows.map(({ elapsedMs }) => elapsedMs)),
    codex: {
      inputTokens: sum(rows.map(({ usage }) => usage?.input_tokens ?? 0)),
      cachedInputTokens: sum(rows.map(({ usage }) => usage?.cached_input_tokens ?? 0)),
      cacheWriteInputTokens: sum(rows.map(({ usage }) => usage?.cache_write_input_tokens ?? 0)),
      outputTokens: sum(rows.map(({ usage }) => usage?.output_tokens ?? 0)),
      reasoningOutputTokens: sum(rows.map(({ usage }) => usage?.reasoning_output_tokens ?? 0)),
    },
    jev: {
      inputTokens: sum(rows.map(({ jev }) => jev.inputTokens)),
      outputTokens: sum(rows.map(({ jev }) => jev.outputTokens)),
      decisions: sum(rows.map(({ jev }) => jev.decisions)),
      toolCalls: sum(rows.map(({ jev }) => jev.toolCalls)),
      elapsedMs: sum(rows.map(({ jev }) => jev.totalMs)),
      mcpSequences: sum(rows.map(({ jev }) => jev.runs)),
    },
    coderInvocations: sum(rows.map(({ counts }) => counts.coderInvocations ?? 0)),
    nativeCommandCalls: sum(rows.map(({ counts }) => counts.nativeCommandCalls)),
    mcpCalls: sum(rows.map(({ counts }) => counts.mcpCalls)),
    unknownUsageRuns: rows.length - known.length,
    codexCost: known.length === rows.length ? sum(known.map(({ codex }) => codex)) : null,
    jevCost: sum(known.map(({ typesafe }) => typesafe)),
    totalCost: known.length === rows.length ? sum(known.map(({ total }) => total)) : null,
  };
}

export async function generateReport(directory) {
  const { metadata, results, gradingAdjudication } = JSON.parse(await readFile(path.join(directory, "results.json"), "utf8"));
  assert.equal(metadata.model, "gpt-5.6-sol", "Reverify the pricing table for any other model.");
  let postBenchmarkHardening;
  try { postBenchmarkHardening = JSON.parse(await readFile(path.join(directory, "audit.json"), "utf8")).postBenchmarkHardening; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const supervisor = metadata.integrationVersion === "supervisor-v1";
  const baseline = summarize(results.filter(({ arm }) => arm === "baseline"), metadata);
  const jev = summarize(results.filter(({ arm }) => arm === "jev"), metadata);
  const complete = results.length === metadata.repeats * metadata.cases.length * metadata.arms.length;
  const codingTasks = { baseline: summarize(results.filter((row) => row.arm === "baseline" && row.scenario !== "project-checks"), metadata), jev: summarize(results.filter((row) => row.arm === "jev" && row.scenario !== "project-checks"), metadata) };
  const perScenario = metadata.cases.map(({ id }) => ({
    id,
    baseline: summarize(results.filter((row) => row.scenario === id && row.arm === "baseline"), metadata),
    jev: summarize(results.filter((row) => row.scenario === id && row.arm === "jev"), metadata),
  }));
  const paired = results.filter(({ arm }) => arm === "baseline").map((base) => {
    const treatment = results.find((row) => row.arm === "jev" && row.scenario === base.scenario && row.repeat === base.repeat);
    if (!treatment) return null;
    return { scenario: base.scenario, repeat: base.repeat, baselineMs: base.elapsedMs, jevMs: treatment.elapsedMs, latencySavedPercent: savings(base.elapsedMs, treatment.elapsedMs), bothPassed: base.grading.passed && treatment.grading.passed };
  }).filter(Boolean);
  const rejectedMcpCalls = [];
  let directSequences = 0, investigationSequences = 0, responseCharacters = 0;
  for (const row of results.filter(({ arm }) => arm === "jev")) {
    const events = (await readFile(path.join(directory, `${row.id}.events.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    for (const event of events) {
      const item = event.item;
      if (event.type === "jev.completed") {
        if (event.result.metrics.decisionCalls === 0) directSequences++;
        else investigationSequences++;
        responseCharacters += JSON.stringify(event.result).length;
        continue;
      }
      if (event.type !== "item.completed" || item?.type !== "mcp_tool_call") continue;
      for (const content of item.result?.content ?? []) {
        if (content.type !== "text") continue;
        try {
          const result = JSON.parse(content.text);
          if (!result.metrics) continue;
          responseCharacters += content.text.length;
          if (result.metrics.decisionCalls === 0) directSequences++;
          else investigationSequences++;
        } catch {}
      }
      if (item.status !== "failed") continue;
      rejectedMcpCalls.push({ run: row.id, tool: item.tool, maxSteps: item.arguments?.maxSteps, message: item.error?.message ?? item.result?.content?.filter(({ type }) => type === "text").map(({ text }) => text).join("\n") });
    }
  }
  await writeFile(path.join(directory, "tool-call-errors.json"), JSON.stringify(rejectedMcpCalls, null, 2) + "\n");
  const report = {
    complete, requestedModel: metadata.model, effort: metadata.effort, serviceTier: metadata.serviceTier,
    baseline, jev, codingTasks, perScenario, paired, rejectedMcpCalls, gradingAdjudication,
    routing: { directSequences, investigationSequences, responseCharacters }, postBenchmarkHardening,
    savings: {
      totalWallTimePercent: savings(baseline.elapsedMs, jev.elapsedMs),
      codexInputTokensPercent: savings(baseline.codex.inputTokens, jev.codex.inputTokens),
      codexOutputTokensPercent: savings(baseline.codex.outputTokens, jev.codex.outputTokens),
      estimatedCostPercent: baseline.totalCost !== null && jev.totalCost !== null ? savings(baseline.totalCost, jev.totalCost) : null,
      medianPairedLatencyPercent: median(paired.map(({ latencySavedPercent }) => latencySavedPercent)),
    },
  };
  await writeFile(path.join(directory, "summary.json"), JSON.stringify(report, null, 2) + "\n");
  const lines = [
    supervisor ? "# Jev-first execution benchmark" : "# Codex + Jev benchmark", "", `${complete ? "Completed" : "PRELIMINARY"}: ${paired.length} matched pairs across ${metadata.cases.length} task types, ${metadata.repeats} repeats per type. Recorded ${metadata.recordedAt}.`, "",
    `Both arms requested **${metadata.model}, ${metadata.effort} reasoning, ${metadata.serviceTier} service tier** through ${metadata.codexVersion}. Jev used the pinned runner model jev-1.13.0.`, "",
    "| Aggregate across matched tasks | Normal Codex | Codex + Jev |", "| --- | ---: | ---: |",
    `| Verified completions | ${baseline.passed}/${baseline.runs} | ${jev.passed}/${jev.runs} |`,
    `| Total task wall time | ${seconds(baseline.elapsedMs)} s | ${seconds(jev.elapsedMs)} s |`,
    `| Median task wall time | ${seconds(baseline.medianElapsedMs)} s | ${seconds(jev.medianElapsedMs)} s |`,
    `| Codex input tokens | ${baseline.codex.inputTokens.toLocaleString("en-US")} | ${jev.codex.inputTokens.toLocaleString("en-US")} |`,
    `| Of which cached input | ${baseline.codex.cachedInputTokens.toLocaleString("en-US")} | ${jev.codex.cachedInputTokens.toLocaleString("en-US")} |`,
    `| Of which cache writes | ${baseline.codex.cacheWriteInputTokens.toLocaleString("en-US")} | ${jev.codex.cacheWriteInputTokens.toLocaleString("en-US")} |`,
    `| Codex output tokens, including reasoning | ${baseline.codex.outputTokens.toLocaleString("en-US")} | ${jev.codex.outputTokens.toLocaleString("en-US")} |`,
    `| Of which reasoning output | ${baseline.codex.reasoningOutputTokens.toLocaleString("en-US")} | ${jev.codex.reasoningOutputTokens.toLocaleString("en-US")} |`,
    `| Jev input tokens | 0 | ${jev.jev.inputTokens.toLocaleString("en-US")} |`,
    `| Codex API-equivalent cost | ${dollars(baseline.codexCost)} | ${dollars(jev.codexCost)} |`,
    `| Jev estimated API cost | ${dollars(baseline.jevCost)} | ${dollars(jev.jevCost)} |`,
    `| Combined API-equivalent cost | ${dollars(baseline.totalCost)} | ${dollars(jev.totalCost)} |`, "",
    `Measured change with Jev: **${change(report.savings.totalWallTimePercent, "less total wall time", "more total wall time")}**, **${change(report.savings.codexOutputTokensPercent, "fewer Codex output tokens", "more Codex output tokens")}**, **${change(report.savings.estimatedCostPercent, "lower estimated total cost", "higher estimated total cost")}**.`, "",
    `Excluding the check-only tasks: ${change(savings(codingTasks.baseline.elapsedMs, codingTasks.jev.elapsedMs), "less total wall time", "more total wall time")} and ${change(savings(codingTasks.baseline.totalCost, codingTasks.jev.totalCost), "lower estimated cost", "higher estimated cost")}. This separates code repair/source explanation from tasks that can bypass Codex entirely.`, "",
    "## By task", "", "Times below are medians; costs are mean estimated cost per run, including Jev.", "",
    "| Task | Normal: pass / seconds / USD | Jev: pass / seconds / USD |", "| --- | --- | --- |",
    ...perScenario.map(({ id, baseline: b, jev: j }) => `| ${id} | ${b.passed}/${b.runs} · ${seconds(b.medianElapsedMs)} s · ${dollars(b.totalCost === null ? null : b.totalCost / b.runs)} | ${j.passed}/${j.runs} · ${seconds(j.medianElapsedMs)} s · ${dollars(j.totalCost === null ? null : j.totalCost / j.runs)} |`), "",
    "## Individual paired timings", "", "| Task | Repeat | Normal (s) | Jev (s) | Time saved | Both outcomes pass |", "| --- | ---: | ---: | ---: | ---: | --- |",
    ...paired.map((pair) => `| ${pair.scenario} | ${pair.repeat} | ${seconds(pair.baselineMs)} | ${seconds(pair.jevMs)} | ${percentage(pair.latencySavedPercent)} | ${pair.bothPassed ? "yes" : "no"} |`), "",
    "## Integration findings", "",
    supervisor ? `The supervisor invoked Codex ${jev.coderInvocations} times across ${jev.runs} tasks. Each coding invocation and its actual usage are retained in the raw events.` : `${rejectedMcpCalls.length} of ${jev.mcpCalls} MCP attempts failed. These calls and their token/time costs remain in the comparison. See [exact errors](tool-call-errors.json).`, "",
    `${investigationSequences} sequences used Jev to choose intermediate calls; ${directSequences} executed explicitly selected checks with zero model decisions. Recorded sequence payloads totaled ${responseCharacters.toLocaleString("en-US")} JSON characters${supervisor ? "; these are full diagnostic traces, not the coding model input" : " returned through MCP"}.`, "",
    metadata.integrationVersion === "v2"
      ? "This version removes the caller-facing maxSteps parameter, omits internal decision/revision metadata from MCP evidence, uses short request-local Choice keys, and provides direct execution for exact configured checks. The treatment prompt documents that route. These are measured together; this experiment does not isolate the effect of each change."
      : supervisor ? "Jev starts the task directly. Codex is invoked only for editing or explanation; the supervisor verifies edits and permits at most two coding attempts. Command-only tasks can complete without Codex. This is a standalone execution mode, not an interception of Codex built-in tools. Its stdout carries full trace events; those traces are not all sent to the coding model." : "Inspect raw traces to distinguish model decisions, integration retries, and native-tool fallbacks.", "",
    "Latency also includes model-service variability; the data does not attribute the entire time difference to the integration errors. Jev's internal loop timing alone is not an end-to-end comparison.", "",
    "## Method and interpretation", "",
    supervisor ? "Both arms receive the same concrete task and final-result schema. Normal Codex starts with the task; the treatment starts with Jev, then gives the coding phase the task plus collected evidence. The coding model, reasoning effort, service tier, workspace snapshot, correctness graders, and 180-second limit are unchanged. Codex invocation count can be zero for checks and is bounded at two for repairs. Runs are sequential and counterbalanced. This measures a change in execution architecture, including when Codex is invoked; it is not a model-only comparison. No failed run is discarded." : "The normal arm uses Codex's built-in tools and can batch calls. The Jev arm adds the actual MCP server and asks the same Codex model to delegate coherent inspection and verification sequences; Codex still owns edits and may recover with normal tools if necessary. Both arms receive the same task goal and structured final-answer schema. Each run starts in a fresh Git repository. The project cases use identical frozen copies of this runner's source and tests. User config and project instructions are isolated for parity; the shared installed skill catalog remains available. Runs are sequential, alternate arm order, and include CLI startup and, for Jev, MCP startup. No formal failure is discarded.", "",
    "The bug-fix grader checks unchanged tests and runs independent held-out status cases. The source-inspection grader requires retrieved implementation evidence plus the correct revision, modification-time, size, and suppression explanation. The check task requires actual passing test output and successful execution of both commands with matching reported exit codes. Raw evidence and all final answers are retained for manual review. Three repeats on three small tasks do not establish general coding-agent performance or statistical significance.", "",
    ...(gradingAdjudication ? ["A mechanical grading correction is recorded in results.json with original assertions and its justification. No run was removed or replaced.", ""] : []),
    `The Jev arm executed ${jev.jev.toolCalls} inner tools across ${jev.jev.mcpSequences} tool sequences, with ${jev.mcpCalls} MCP attempts, ${jev.coderInvocations} explicit supervisor coding invocations, and ${jev.nativeCommandCalls} native command calls. The normal arm used ${baseline.nativeCommandCalls} native command calls. A native command call can contain several shell operations, so these are host-call counts rather than equivalent units of work.`, "",
    "Dollar figures are API-equivalent estimates, not charges on this user's Codex subscription and not a measurement of the account's five-hour or weekly quota. Prices were checked on September 18, 2026. At the requested priority/Fast tier, GPT-5.6 Sol is $8/M ordinary input, $0.80/M cached reads, $10/M cache writes, and $40/M output. The formula subtracts both cache-read and cache-write tokens from total input before pricing ordinary input; reasoning output is already included in output and is not added again. Jev adds $0.042/M input tokens and has free output. See [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and [TypeSafe models/pricing](https://docs.typesafe.ai/models).", "",
    "Cache hit rates are measured, not normalized: counterbalanced ordering reduces a simple first-run advantage but cannot remove all shared-cache and service variability. The savings apply to this task mix and this integration. Actual subscription savings cannot be converted directly from these token counts. An already-running desktop MCP server may have different startup overhead.", "",
    ...(postBenchmarkHardening ? ["After this frozen benchmark, two retry safeguards were added: withholding stale source after workspace changes and marking unresolved verification handoffs incomplete. Neither branch occurred in a measured run. The audit verifies identical coding-input payloads for every measured run and retains the exact measured scripts with matching source hashes. These safeguards have separate regression tests. See [audit](audit.json) and [measured scripts](measured-runtime/README.md).", ""] : []),
    "The runner was frozen throughout this benchmark. Setup, previous benchmark runs, and this conversation's token usage are outside the totals above.", "",
    "Artifacts: [raw results](results.json), [machine-readable summary](summary.json), [fixed methodology and source hashes](methodology.json). Each run also has an events JSONL file, final answer, stderr, and (for bug fixes) independent grader output.", "",
  ];
  await writeFile(path.join(directory, "REPORT.md"), lines.join("\n"));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], "Provide the formal benchmark output directory.");
  const report = await generateReport(path.resolve(process.argv[2]));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
