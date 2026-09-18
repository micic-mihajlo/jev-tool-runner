import assert from "node:assert/strict";
import test from "node:test";
import { canReceiveMessages } from "../src/access.mjs";

test("active members receive messages", () => {
  assert.equal(canReceiveMessages({ status: "active" }), true);
});
test("removed members cannot receive messages", () => {
  assert.equal(canReceiveMessages({ status: "removed" }), false);
});
test("missing memberships cannot receive messages", () => {
  assert.equal(canReceiveMessages(null), false);
});
