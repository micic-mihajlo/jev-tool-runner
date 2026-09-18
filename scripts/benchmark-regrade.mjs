import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

assert.ok(process.argv[2], "Provide the completed benchmark directory.");
const directory = path.resolve(process.argv[2]);
const file = path.join(directory, "results.json");
const data = JSON.parse(await readFile(file, "utf8"));
assert.equal(data.results.length, data.metadata.repeats * data.metadata.cases.length * data.metadata.arms.length, "Wait until every formal run completes.");
const corrections = [];
for (const row of data.results.filter(({ scenario }) => scenario === "project-checks")) {
  const events = (await readFile(path.join(directory, `${row.id}.events.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const completed = events.filter(({ type }) => type === "item.completed").map(({ item }) => item);
  let actualTypecheckPassed = completed.some((item) => item.type === "command_execution" && /\bnpm run check\b/.test(item.command ?? "") && item.exit_code === 0);
  for (const item of completed.filter(({ type }) => type === "mcp_tool_call")) {
    const possible = [item.result?.structuredContent];
    for (const content of item.result?.content ?? []) {
      if (content.type !== "text") continue;
      try { possible.push(JSON.parse(content.text)); } catch {}
    }
    actualTypecheckPassed ||= possible.some((result) => result?.observations?.some((observation) => observation.action.tool === "run_command" && observation.action.args.commandId === "typecheck" && observation.exitCode === 0));
  }
  row.originalGrading ??= structuredClone(row.grading);
  delete row.grading.assertions.actualTypecheckOutput;
  row.grading.assertions.actualTypecheckPassed = actualTypecheckPassed;
  row.grading.passed = row.exitCode === 0 && !row.timedOut && Object.values(row.grading.assertions).every(Boolean);
  corrections.push({ id: row.id, originalPassed: row.originalGrading.passed, correctedPassed: row.grading.passed, actualTypecheckPassed });
}
data.gradingAdjudication = {
  reason: "A successful npm run check may have an empty stdout capture. Use the observed command and exit code, not an npm banner, to verify this check. Applied identically to every project-checks run in both arms. All timings, usage, original grades, and raw traces are preserved.",
  corrections,
};
await writeFile(file, JSON.stringify(data, null, 2) + "\n");
process.stdout.write(JSON.stringify(data.gradingAdjudication, null, 2) + "\n");
