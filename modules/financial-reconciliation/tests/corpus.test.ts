// The corpus, its negative controls, and a guard on the harness itself.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { BLUNT_MUTATION, CASES, MUTATIONS, runCase, runCorpus } from "../src/cases.ts";
import type { Weaknesses } from "../src/pipeline.ts";

/** Which named cases each removed mechanism is required to redden. */
const REQUIRED_RED: Readonly<Record<string, readonly string[]>> = {
  noDeliveryDedup: ["R02"],
  noRawImmutability: ["R18"],
  noStatementDedup: ["R03", "R04", "R09"],
  naiveIdentity: ["R04"],
  noCorrelation: ["R05", "R06"],
  noEntryDedup: ["R10"],
  noFinalityGate: ["R12"],
};

describe("the corpus", () => {
  it("passes every case", () => {
    const failures = runCorpus().filter((r) => !r.passed);
    assert.deepEqual(failures.map((f) => `${f.id}: ${f.failures.join("; ")}`), []);
  });

  it("has a unique id and a stated coverage for every case", () => {
    const ids = CASES.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const c of CASES) {
      assert.ok(c.covers.length > 0, `${c.id} does not say what it covers`);
      assert.ok(c.steps.length > 0, `${c.id} has no steps`);
    }
  });

  it("leaves the ledger balanced in every case", () => {
    for (const r of runCorpus()) assert.equal(r.observed.balanced, true, r.id);
  });
});

describe("negative controls", () => {
  for (const mutation of MUTATIONS) {
    it(`removing ${mutation} turns its named cases red`, () => {
      const red = runCorpus({ [mutation]: true } as Weaknesses)
        .filter((r) => !r.passed).map((r) => r.id).sort();
      assert.deepEqual(red, [...(REQUIRED_RED[mutation] ?? [])].sort());
    });
  }

  it("each control stays localised rather than reddening the whole corpus", () => {
    for (const mutation of MUTATIONS) {
      const red = runCorpus({ [mutation]: true } as Weaknesses).filter((r) => !r.passed);
      assert.ok(red.length > 0, `${mutation} is not detected by any case`);
      assert.ok(
        red.length < CASES.length / 2,
        `${mutation} reddens ${red.length} cases, which localises nothing`,
      );
    }
  });

  it("rejects a control blunt enough to break almost everything", () => {
    // Keeping this one as a *rejection* rather than a pass is the point. A
    // mutation that reddens the corpus proves that the corpus runs, not that
    // any particular case covers any particular mechanism.
    const red = runCorpus({ [BLUNT_MUTATION]: true } as Weaknesses).filter((r) => !r.passed);
    assert.ok(
      red.length >= CASES.length / 2,
      "the blunt control was expected to be blunt; if it is not, it is no longer a control",
    );
  });
});

describe("the harness itself", () => {
  it("fails a case whose expectation is wrong", () => {
    // Without this, a bug that made every comparison succeed would leave the
    // corpus green and meaningless.
    const real = CASES.find((c) => c.id === "R01")!;
    const tampered = { ...real, expect: { ...real.expect, entries: real.expect.entries + 1 } };
    const result = runCase(tampered);
    assert.equal(result.passed, false);
    assert.match(result.failures.join(" "), /entries/);
  });

  it("fails a case whose expected exception list is wrong", () => {
    const real = CASES.find((c) => c.id === "R14")!;
    const tampered = { ...real, expect: { ...real.expect, exceptions: [] as const } };
    assert.equal(runCase(tampered).passed, false);
  });

  it("fails a case that expects an unbalanced ledger when the ledger balances", () => {
    const real = CASES.find((c) => c.id === "R01")!;
    const tampered = { ...real, expect: { ...real.expect, balanced: false } };
    assert.equal(runCase(tampered).passed, false);
  });

  it("reports the same result for the same case every time", () => {
    const real = CASES.find((c) => c.id === "R12")!;
    assert.equal(runCase(real).observed.digest, runCase(real).observed.digest);
  });
});
