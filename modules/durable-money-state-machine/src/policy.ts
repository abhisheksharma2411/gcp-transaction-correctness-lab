// The two rules that are not in the transition table, and the mutations that
// are used to prove the tests are measuring something.

import type { Spec } from "./spec.ts";
import type { Input, Payout, State } from "./types.ts";

const terminalCache = new WeakMap<Spec, Set<State>>();

export function TERMINAL_OF(spec: Spec): Set<State> {
  let s = terminalCache.get(spec);
  if (s === undefined) {
    s = new Set(spec.terminal);
    terminalCache.set(spec, s);
  }
  return s;
}

/**
 * When a worker must hold a lease before it may move the entity.
 *
 * The first transition creates the process. Everything a worker does after
 * that is *resumption*, and resumption needs an owner and a deadline -- which
 * is the whole difference between a process that is running slowly and one
 * that stopped. External arrivals (a provider callback, an operator decision)
 * are not resuming anything, so they are governed by the version check alone.
 */
export function leaseRequired(payout: Payout, input: Input): boolean {
  return input.actor.kind === "service" && payout.state !== "DRAFT";
}

/**
 * Deliberate defects.
 *
 * A suite written by the same hand as the implementation proves nothing until
 * each check has been shown to fail when the thing it checks is removed. Each
 * mutation below must turn *specific, named* scenarios red; a mutation that
 * reddens everything is rejected by its own control, because "everything
 * broke" is not evidence that any particular scenario is doing work.
 */
export type Mutation =
  | "no-terminal-check"
  | "no-version-check"
  | "no-lease-check"
  | "no-guards"
  | "no-callback-correlation"
  | "history-not-appended";

export const MUTATIONS: readonly Mutation[] = [
  "no-terminal-check",
  "no-version-check",
  "no-lease-check",
  "no-guards",
  "no-callback-correlation",
  "history-not-appended",
];
