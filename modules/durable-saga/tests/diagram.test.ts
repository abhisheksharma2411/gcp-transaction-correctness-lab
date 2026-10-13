// The generated diagrams, and the assertion that replaces looking.
//
// Three articles in this programme have shipped a rendered diagram that
// contradicted their own text, and in every case the defect was invisible in
// the SVG source. The generalisation is "never route a line through a box", so
// here it is a build failure rather than a habit.

import { test } from "node:test";
import assert from "node:assert/strict";

import { SAGA_V1, SAGA_V2 } from "../src/saga.ts";
import type { Definition, Route } from "../src/saga.ts";
import { sagaFlowSvg, sagaStatesSvg } from "../src/svg.ts";

const flow = sagaFlowSvg(SAGA_V1);
const states = sagaStatesSvg(SAGA_V1);

test("both diagrams carry a title and a full description", () => {
  for (const svg of [flow, states]) {
    assert.match(svg, /<title>[^<]{20,}<\/title>/);
    assert.match(svg, /<desc>[^<]{200,}<\/desc>/);
  }
});

test("the flow diagram names every step and every participant", () => {
  for (const s of SAGA_V1.steps) {
    assert.ok(flow.includes(s.name), s.name);
    assert.ok(flow.includes(s.participant), s.participant);
  }
});

test("the flow diagram names every compensation", () => {
  for (const s of SAGA_V1.steps) {
    if (s.compensation === null) continue;
    assert.ok(flow.includes(s.compensation), s.compensation);
  }
});

test("the flow diagram draws no compensation for a step after the pivot", () => {
  assert.equal(flow.includes("post_ledger_entry</text></g>"), false);
  const compBoxes = flow.match(/compensation<\/text>/g) ?? [];
  assert.equal(compBoxes.length, 3);
});

test("the state diagram names every state", () => {
  for (const s of SAGA_V1.states) assert.ok(states.includes(s), s);
});

test("the state diagram names every trigger", () => {
  for (const t of SAGA_V1.transitions) assert.ok(states.includes(t.trigger), t.trigger);
});

test("the state diagram draws one path per transition plus none spare", () => {
  const paths = states.match(/<path d="M [^"]+" fill="none"/g) ?? [];
  assert.equal(paths.length, SAGA_V1.transitions.length);
});

test("both diagrams are deterministic", () => {
  assert.equal(sagaFlowSvg(SAGA_V1), flow);
  assert.equal(sagaStatesSvg(SAGA_V1), states);
});

test("version 2 renders too, with its own step names", () => {
  const v2 = sagaFlowSvg(SAGA_V2);
  assert.ok(v2.includes("schedule_delivery"));
  assert.equal(v2.includes("book_shipment"), false);
});

test("a transition with no declared route makes the generator throw", () => {
  const broken: Definition = {
    ...SAGA_V1,
    transitions: [...SAGA_V1.transitions, {
      from: "RUNNING", trigger: "operator_closed", to: "CLOSED_MANUALLY",
      reasonCode: "X", note: "added without redrawing anything",
    }],
  };
  assert.throws(() => sagaStatesSvg(broken), /has no route/);
});

test("a route that would send an arrow through a box makes the generator throw", () => {
  // Routing COMPENSATING's exit over the top of the diagram sends it straight
  // up through PIVOTED, which is the defect this check exists for.
  const routes: Record<string, Route> = {
    ...SAGA_V1.routes, "COMPENSATING|compensations_complete": "lane-above",
  };
  const broken: Definition = { ...SAGA_V1, routes };
  assert.throws(() => sagaStatesSvg(broken), /passes through box/);
});

test("the crossing check names the box it found and where", () => {
  const routes: Record<string, Route> = {
    ...SAGA_V1.routes, "COMPENSATING|compensations_complete": "lane-above",
  };
  const broken: Definition = { ...SAGA_V1, routes };
  assert.throws(() => sagaStatesSvg(broken), /box PIVOTED at \(\d+, \d+\)/);
});

test("every node the argument depends on has at least one arrow", () => {
  // A box with no inbound and no outbound arrow is the other half of the
  // defect: the picture shows a participant nothing ever reaches.
  for (const s of SAGA_V1.states) {
    const touched = SAGA_V1.transitions.some((t) => t.from === s || t.to === s);
    assert.equal(touched, true, s);
  }
});
