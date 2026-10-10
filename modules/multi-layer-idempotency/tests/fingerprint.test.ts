import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, effectId, fingerprint, FingerprintError, taskId } from "../src/fingerprint.ts";

test("F1 object key order does not change the fingerprint", () => {
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test("F2 array order does change it — order is meaning in a list", () => {
  assert.notEqual(fingerprint({ xs: [1, 2] }), fingerprint({ xs: [2, 1] }));
});

test("F3 a different value changes it", () => {
  assert.notEqual(fingerprint({ amount: 100 }), fingerprint({ amount: 101 }));
});

test("F4 undefined members are dropped, null is kept", () => {
  assert.equal(fingerprint({ a: 1, b: undefined }), fingerprint({ a: 1 }));
  assert.notEqual(fingerprint({ a: 1, b: null }), fingerprint({ a: 1 }));
});

test("F5 nesting is canonicalised all the way down", () => {
  assert.equal(
    fingerprint({ outer: { z: 1, a: { y: 2, b: 3 } } }),
    fingerprint({ outer: { a: { b: 3, y: 2 }, z: 1 } }),
  );
});

test("F6 numbers that mean the same thing agree", () => {
  assert.equal(fingerprint({ n: 1 }), fingerprint({ n: 1.0 }));
});

test("F7 a non-finite number is refused rather than hashed", () => {
  assert.throws(() => fingerprint({ n: NaN }), FingerprintError);
  assert.throws(() => fingerprint({ n: Infinity }), FingerprintError);
});

test("F8 a string that looks like a number does not collide with it", () => {
  assert.notEqual(fingerprint({ n: 1 }), fingerprint({ n: "1" }));
});

test("F9 task ids are hashed, not sequential", () => {
  // Cloud Tasks documents that sequential ids or sequential prefixes increase
  // latency and error rates, and recommends hashed strings.
  const a = taskId("op-1", "charge");
  const b = taskId("op-2", "charge");
  assert.equal(a, taskId("op-1", "charge"));
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{32}-charge$/);
  // Adjacent operation ids must not produce adjacent task ids.
  assert.notEqual(a.slice(0, 8), b.slice(0, 8));
});

test("F10 effect identity is per operation and per kind", () => {
  assert.equal(effectId("op-1", "notify"), effectId("op-1", "notify"));
  assert.notEqual(effectId("op-1", "notify"), effectId("op-1", "provision"));
  assert.notEqual(effectId("op-1", "notify"), effectId("op-2", "notify"));
});

test("F11 the kind separator cannot be forged from the id", () => {
  // Without a separator, ("op-1n", "otify") and ("op-1", "notify") would
  // concatenate to the same string.
  assert.notEqual(effectId("op-1n", "otify"), effectId("op-1", "notify"));
});
