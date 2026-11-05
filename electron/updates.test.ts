import assert from "node:assert/strict";
import test from "node:test";
import { isNewer } from "./updates.ts";

test("versions compare by number, not by text", () => {
  assert.equal(isNewer("v1.10.0", "1.9.2"), true);
  assert.equal(isNewer("1.0.1", "1.0.0"), true);
  assert.equal(isNewer("v1.0", "1.0.0"), false);
  assert.equal(isNewer("1.0.0", "1.0.0"), false);
  assert.equal(isNewer("0.9.9", "1.0.0"), false);
});
