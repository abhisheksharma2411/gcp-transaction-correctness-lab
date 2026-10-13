// The definition, checked before anything runs.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SAGA_V1, SAGA_V2, compensableSteps, forwardOnlySteps, isTerminal,
  pivotIndex, stepByName, transitionFor, verifyDefinition,
} from "../src/saga.ts";
import { PARTICIPANTS } from "../src/types.ts";

for (const def of [SAGA_V1, SAGA_V2]) {
  test(`version ${def.version}: every static check passes`, () => {
    for (const f of verifyDefinition(def)) {
      assert.equal(f.ok, true, `${f.check}: ${f.detail}`);
    }
  });

  test(`version ${def.version}: exactly one step is the pivot`, () => {
    assert.equal(def.steps.filter((s) => s.pivot).length, 1);
    assert.equal(def.steps[pivotIndex(def)]!.name, "capture_payment");
  });

  test(`version ${def.version}: every compensable step is before the pivot`, () => {
    for (const s of compensableSteps(def)) {
      assert.ok(def.steps.indexOf(s) < pivotIndex(def), `${s.name} is compensable after the pivot`);
    }
  });

  test(`version ${def.version}: nothing from the pivot onward declares a compensation`, () => {
    for (const s of forwardOnlySteps(def)) assert.equal(s.compensation, null);
  });

  test(`version ${def.version}: the irreversible step is last`, () => {
    const irreversible = def.steps.filter((s) => s.irreversible);
    assert.equal(irreversible.length, 1);
    assert.equal(def.steps[def.steps.length - 1]!.name, irreversible[0]!.name);
  });

  test(`version ${def.version}: every participant is a known service`, () => {
    for (const s of def.steps) assert.ok(PARTICIPANTS.includes(s.participant));
  });

  test(`version ${def.version}: every step note is a real sentence`, () => {
    for (const s of def.steps) assert.ok(s.note.length > 40, s.name);
  });
}

test("the two versions differ in exactly one step", () => {
  const a = SAGA_V1.steps.map((s) => s.name);
  const b = SAGA_V2.steps.map((s) => s.name);
  assert.equal(a.length, b.length);
  const differing = a.filter((n, i) => n !== b[i]);
  assert.deepEqual(differing, ["book_shipment"]);
  assert.equal(b[2], "schedule_delivery");
});

test("version 2 has no compensation for version 1's carrier step", () => {
  assert.equal(stepByName(SAGA_V2, "book_shipment"), undefined);
  assert.notEqual(stepByName(SAGA_V1, "book_shipment"), undefined);
});

test("the terminal states are sinks", () => {
  for (const s of SAGA_V1.terminal) {
    assert.equal(SAGA_V1.transitions.some((t) => t.from === s), false, s);
    assert.equal(isTerminal(SAGA_V1, s), true);
  }
});

test("both states a person owns name the person", () => {
  assert.equal(SAGA_V1.owned.MANUAL_REPAIR, "payments operations");
  assert.equal(SAGA_V1.owned.COMPENSATION_FAILED, "payments operations");
});

test("every reachable state can reach a terminal state", () => {
  const reach = (from: string): boolean => {
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (SAGA_V1.terminal.includes(cur as never)) return true;
      for (const t of SAGA_V1.transitions) {
        if (t.from === cur && !seen.has(t.to)) { seen.add(t.to); queue.push(t.to); }
      }
    }
    return false;
  };
  for (const s of SAGA_V1.states) assert.equal(reach(s), true, s);
});

test("there is no transition out of a terminal state, and asking for one yields nothing", () => {
  assert.equal(transitionFor(SAGA_V1, "COMPLETED", "operator_retried"), undefined);
});

test("reason codes are unique per source state", () => {
  const seen = new Set<string>();
  for (const t of SAGA_V1.transitions) {
    const key = `${t.from}|${t.reasonCode}`;
    assert.equal(seen.has(key), false, key);
    seen.add(key);
  }
});

test("every transition has a declared route for the generated diagram", () => {
  for (const t of SAGA_V1.transitions) {
    assert.notEqual(SAGA_V1.routes[`${t.from}|${t.trigger}`], undefined,
      `${t.from}|${t.trigger}`);
  }
});

test("every state has a layout position", () => {
  for (const s of SAGA_V1.states) assert.notEqual(SAGA_V1.layout[s], undefined, s);
});

test("no two states share a grid cell", () => {
  const cells = SAGA_V1.states.map((s) => `${SAGA_V1.layout[s].col},${SAGA_V1.layout[s].row}`);
  assert.equal(new Set(cells).size, cells.length);
});
