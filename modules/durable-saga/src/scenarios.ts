// Nine named scenarios, each the shortest run that exercises one thing.
//
// The tests and the report both read this file, so a scenario cannot mean one
// thing in a test and another in a table. Each one states what it covers; the
// report prints that, and `tests/scenarios.test.ts` asserts the outcome.

import { run } from "./matrix.ts";
import type { Run, RunOptions } from "./matrix.ts";

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly covers: string;
  readonly run: () => Run;
}

function sc(id: string, title: string, covers: string, opts: RunOptions): Scenario {
  return { id, title, covers, run: () => run(id.toLowerCase(), opts) };
}

export const SCENARIOS: readonly Scenario[] = [
  sc("S1", "Every participant says yes",
    "the whole chain, and that an irreversible step sits after the pivot",
    {}),

  sc("S2", "A compensable step is refused",
    "failure before the pivot, and the compensation chain in reverse order",
    { faults: [{ step: "authorize_payment", direction: "forward", at: "reject" }] }),

  sc("S3", "Failure before any durable effect",
    "the first step refusing, which leaves nothing to compensate",
    { faults: [{ step: "reserve_stock", direction: "forward", at: "reject" }] }),

  sc("S4", "The carrier answers after the saga gave up",
    "a delayed callback arriving once compensation has already run",
    { cancelWhileWaiting: true }),

  sc("S5", "Cancellation loses the race",
    "a cancellation arriving after the pivot committed, and being refused",
    { cancelDuring: "capture_payment" }),

  sc("S6", "The orchestrator dies mid-pivot",
    "a restart between the participant acting and the answer being recorded",
    { faults: [{ step: "capture_payment", direction: "forward", at: "crash" }] }),

  sc("S7", "A compensation fails, then an operator retries it",
    "compensation exhaustion, the state a person owns, and a resumed chain",
    {
      repair: "retry",
      faults: [
        { step: "capture_payment", direction: "forward", at: "reject" },
        { step: "void_authorization", direction: "compensate", at: "error" },
        { step: "void_authorization", direction: "compensate", at: "error" },
        { step: "void_authorization", direction: "compensate", at: "error" },
      ],
    }),

  sc("S8", "A step after the pivot runs out of attempts",
    "manual repair resuming rather than replaying committed work",
    {
      repair: "resume",
      faults: [
        { step: "post_ledger_entry", direction: "forward", at: "error" },
        { step: "post_ledger_entry", direction: "forward", at: "error" },
        { step: "post_ledger_entry", direction: "forward", at: "error" },
        { step: "post_ledger_entry", direction: "forward", at: "error" },
      ],
    }),

  sc("S9", "The answer is lost, not the work",
    "an unknown outcome resolved by asking the participant what it recorded",
    { faults: [{ step: "authorize_payment", direction: "forward", at: "lost" }] }),
];

export function scenarioById(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (s === undefined) throw new Error(`no scenario ${id}`);
  return s;
}
