// The conformance matrix, and the controls that show it can fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MATRIX, MUTATIONS, runCase, runMatrix } from "../src/conformance.ts";

test("M1 every case in the matrix passes against this implementation", () => {
  const results = runMatrix();
  const failed = results.filter((r) => !r.passed);
  assert.deepEqual(
    failed.map((f) => `${f.id}: ${f.failures.join("; ")}`),
    [],
  );
  assert.equal(results.length, MATRIX.length);
});

test("M2 the matrix is serialisable, which is what makes it a specification", () => {
  // If this ever stops holding, the matrix has become code and no longer
  // ports to another language. ADR-003.
  const json = JSON.stringify(MATRIX);
  const parsed = JSON.parse(json);
  assert.equal(parsed.length, MATRIX.length);
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(MATRIX)));
  for (const c of parsed) {
    assert.ok(typeof c.id === "string" && c.id.length > 0);
    assert.ok(typeof c.title === "string");
    assert.ok(typeof c.covers === "string", `${c.id} must say what it covers`);
    assert.ok(Array.isArray(c.steps) && c.steps.length > 0);
    assert.ok(typeof c.expect.effects === "number");
  }
});

test("M3 every case ends with a stated effect count", () => {
  // The effect count is the only assertion that is never optional, because it
  // is the only number that describes the outside world.
  for (const c of MATRIX) {
    assert.equal(typeof c.expect.effects, "number", `${c.id} has no effect expectation`);
  }
});

test("M4 case ids are unique and ordered", () => {
  const ids = MATRIX.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, [...ids].sort());
});

// ---------------------------------------------------------------------------
// Negative controls
// ---------------------------------------------------------------------------

test("N1 removing a layer turns specific cases red", () => {
  const expected: Record<string, readonly string[]> = {
    "no-fingerprint-check": ["C04"],
    "no-business-uniqueness": ["C06", "C12", "C16"],
    "no-effect-ledger": ["C15"],
    "naive-fingerprint": ["C05"],
  };
  for (const mutation of MUTATIONS) {
    const failed = runMatrix(undefined, mutation).filter((r) => !r.passed).map((r) => r.id);
    assert.ok(failed.length > 0, `removing ${mutation} broke nothing — that layer is untested`);
    assert.deepEqual(
      failed,
      expected[mutation],
      `removing ${mutation} should break exactly ${expected[mutation]!.join(", ")}`,
    );
  }
});

test("N2 each mutation is targeted — it does not break the whole matrix", () => {
  // A mutation that reddens everything proves nothing about which case covers
  // which layer. Each one must leave most of the matrix green.
  for (const mutation of MUTATIONS) {
    const results = runMatrix(undefined, mutation);
    const failed = results.filter((r) => !r.passed).length;
    assert.ok(
      failed <= 3,
      `${mutation} broke ${failed} of ${results.length} cases; the control is too blunt`,
    );
  }
});

test("N3 the matrix is deterministic", () => {
  const a = runMatrix();
  const b = runMatrix();
  assert.deepEqual(
    a.map((r) => [r.id, r.effects, r.arrivals, r.decisions.join(",")]),
    b.map((r) => [r.id, r.effects, r.arrivals, r.decisions.join(",")]),
  );
});

test("N4 a case with a wrong expectation fails", () => {
  // Guards the harness itself: if `runCase` ignored expectations, every test
  // above would pass vacuously.
  const broken = { ...MATRIX[0]!, expect: { ...MATRIX[0]!.expect, effects: 99 } };
  const r = runCase(broken);
  assert.equal(r.passed, false);
  assert.match(r.failures.join(" "), /expected 99/);
});

test("N5 arrivals exceed effects across the matrix", () => {
  // The headline number: many copies arrive, one thing happens.
  const results = runMatrix();
  const arrivals = results.reduce((n, r) => n + r.arrivals, 0);
  const effects = results.reduce((n, r) => n + r.effects, 0);
  assert.ok(arrivals > effects * 1.5, `arrivals ${arrivals} vs effects ${effects}`);
});
