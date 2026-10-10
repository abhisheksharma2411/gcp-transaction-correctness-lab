// The audit trail.
//
// Every component appends to one trace. The lineage verifier reads nothing else
// -- not the stores, not the broker's internals -- because an auditor in a real
// system has the same restriction: it gets the records the system chose to
// write, and it has to decide from those whether the system is sound.
//
// That constraint is deliberate and it has teeth. A mechanism that works but
// leaves no trace is indistinguishable here from one that does not work, which
// is also true in production at three in the morning.

import type { TraceEvent } from "./types.ts";

export class Trace {
  private readonly events: TraceEvent[] = [];

  record(event: TraceEvent): void {
    this.events.push(event);
  }

  all(): readonly TraceEvent[] {
    return this.events;
  }

  of<K extends TraceEvent["kind"]>(kind: K): Extract<TraceEvent, { kind: K }>[] {
    return this.events.filter((e): e is Extract<TraceEvent, { kind: K }> => e.kind === kind);
  }

  count(kind: TraceEvent["kind"]): number {
    return this.events.reduce((n, e) => (e.kind === kind ? n + 1 : n), 0);
  }

  /**
   * A stable, human-readable rendering. Used by the report and by failing tests.
   *
   * Timestamps are rendered as ISO-8601 rather than as epoch milliseconds. That
   * started as a readability preference and became a requirement: a 13-digit
   * epoch timestamp is a 13-digit number, some of them are Luhn-valid, and the
   * repository's credential scan flags Luhn-valid 13-to-19-digit runs as
   * possible card numbers. It was right to.
   */
  lines(): string[] {
    return this.events.map((e) => {
      const { kind, atMs, ...rest } = e as TraceEvent & { atMs: number };
      const fields = Object.entries(rest)
        .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(",")}]` : String(v)}`)
        .join(" ");
      return `${new Date(atMs).toISOString()}  ${kind.padEnd(18, " ")} ${fields}`;
    });
  }
}
