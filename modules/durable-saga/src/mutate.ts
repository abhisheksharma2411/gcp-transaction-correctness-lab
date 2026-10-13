// Four ways to break the definition itself.
//
// The seven static checks in `verifyDefinition` are easy to write and hard to
// trust, so each one is run against a definition deliberately broken in the
// way it claims to catch. A check that stays green against its own mutation is
// not a check.

import { SAGA_V1 } from "./saga.ts";
import type { Definition, Step, Transition } from "./saga.ts";
import type { SpecMutation } from "./policy.ts";

export function mutateDefinition(m: SpecMutation): Definition {
  const base = SAGA_V1;
  switch (m) {
    case "two-pivots": {
      const steps: Step[] = base.steps.map((s) =>
        s.name === "post_ledger_entry" ? { ...s, pivot: true } : s);
      return { ...base, steps };
    }
    case "compensation-after-pivot": {
      const steps: Step[] = base.steps.map((s) =>
        s.name === "post_ledger_entry"
          ? { ...s, compensation: "reverse_ledger_entry", compensationDoes: "writes the opposite entry" }
          : s);
      return { ...base, steps };
    }
    case "irreversible-before-pivot": {
      const steps: Step[] = base.steps.map((s) =>
        s.name === "reserve_stock" ? { ...s, irreversible: true } : s);
      return { ...base, steps };
    }
    case "terminal-state-with-an-exit": {
      const extra: Transition = {
        from: "COMPLETED", trigger: "operator_retried", to: "COMPENSATING",
        reasonCode: "REOPEN", note: "a way out of a terminal state, which is what the check is for",
      };
      return { ...base, transitions: [...base.transitions, extra] };
    }
  }
}
