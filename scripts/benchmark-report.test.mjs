import assert from "node:assert/strict";
import test from "node:test";
import { estimateCost, median } from "./benchmark-report.mjs";

test("cost accounting prices cache writes once and does not double-count reasoning", () => {
  const cost = estimateCost({ input_tokens: 1_000_000, cached_input_tokens: 500_000, cache_write_input_tokens: 100_000, output_tokens: 100_000, reasoning_output_tokens: 50_000 }, { inputTokens: 1_000_000 }, { inputPerMillion: 8, cachedPerMillion: 0.8, cacheWritePerMillion: 10, outputPerMillion: 40 });
  assert.equal(cost.codex, 8.6);
  assert.equal(cost.typesafe, 0.042);
  assert.equal(cost.total, 8.642);
});

test("missing usage is unavailable rather than free", () => {
  assert.equal(estimateCost(null, {}, {}), null);
  assert.throws(() => estimateCost({ input_tokens: 1, cached_input_tokens: 2, output_tokens: 0 }, {}, {}), /Cache counts/);
});

test("median handles even and odd paired samples without mutating them", () => {
  const values = [4, 1, 3, 2];
  assert.equal(median(values), 2.5);
  assert.deepEqual(values, [4, 1, 3, 2]);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), null);
});
