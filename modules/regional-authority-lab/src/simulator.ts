import { MAJORITY, REPLICAS, tryCommit, VOTING, type DurableLog } from "./quorum.ts";
import type {
  AppDecision,
  BusinessOutcome,
  CommitResult,
  RegionId,
  ScenarioConfig,
  ScenarioResult,
} from "./types.ts";

const ALL_REGIONS: readonly RegionId[] = ["us-east", "us-west", "witness"];

/**
 * Which regions a given vantage point can reach at time t.
 *
 * A partition isolates one region from the others. A region loss removes it
 * from everyone's view, including its own.
 */
function reachableFrom(
  vantage: RegionId,
  cfg: ScenarioConfig,
  atMs: number,
): Set<RegionId> {
  const lost =
    cfg.regionLoss && atMs >= cfg.regionLoss.fromMs && atMs < cfg.regionLoss.toMs
      ? cfg.regionLoss.region
      : undefined;

  const partitioned =
    cfg.partition && atMs >= cfg.partition.fromMs && atMs < cfg.partition.toMs
      ? cfg.partition.isolate
      : undefined;

  const set = new Set<RegionId>();
  for (const r of ALL_REGIONS) {
    if (r === lost) continue;
    if (vantage === lost) continue; // a lost region sees nothing
    if (partitioned) {
      // The isolated region sees only itself; everyone else sees everyone but it.
      if (vantage === partitioned && r !== partitioned) continue;
      if (vantage !== partitioned && r === partitioned) continue;
    }
    set.add(r);
  }
  return set;
}

/**
 * Where the leader is at time t.
 *
 * Documented behaviour: leaders live in the default leader region; on loss of
 * that region, "new leader replicas are chosen from the second read-write
 * region", after a detection and election delay. The lab makes that delay a
 * parameter so the article can talk about the window rather than pretend it is
 * zero.
 */
function leaderAt(cfg: ScenarioConfig, atMs: number): { leader: RegionId; electing: boolean } {
  const preferred: RegionId = "us-east";
  const secondary: RegionId = "us-west";

  const leaderGone =
    (cfg.regionLoss && cfg.regionLoss.region === preferred &&
      atMs >= cfg.regionLoss.fromMs && atMs < cfg.regionLoss.toMs) ||
    (cfg.partition && cfg.partition.isolate === preferred &&
      atMs >= cfg.partition.fromMs && atMs < cfg.partition.toMs);

  if (!leaderGone) return { leader: preferred, electing: false };

  const since = Math.max(
    cfg.regionLoss?.fromMs ?? Number.POSITIVE_INFINITY,
    cfg.partition?.fromMs ?? Number.NEGATIVE_INFINITY,
  );
  const start = cfg.regionLoss?.region === preferred ? cfg.regionLoss.fromMs : cfg.partition!.fromMs;
  const electing = atMs < start + cfg.leaderElectionMs;
  void since;
  return { leader: electing ? preferred : secondary, electing };
}

export function runScenario(cfg: ScenarioConfig): ScenarioResult {
  const commits: CommitResult[] = [];
  const decisions: AppDecision[] = [];
  const leaderRegionOverTime: { atMs: number; leader: RegionId }[] = [];
  const durableLog: DurableLog = new Map<string, CommitResult>();
  const outcomesByOperation = new Map<string, Set<BusinessOutcome>>();
  let safeModeCount = 0;
  let sideEffectsWithoutCommit = 0;
  let unconfirmedFulfilments = 0;

  for (let t = 0; t <= cfg.durationMs; t += 500) {
    leaderRegionOverTime.push({ atMs: t, leader: leaderAt(cfg, t).leader });
  }

  for (const op of cfg.operations) {
    const { leader, electing } = leaderAt(cfg, op.atMs);
    const reachable = reachableFrom(op.region, cfg, op.atMs);
    const canSeeLeader = reachable.has(leader) && !electing;

    // --- Application layer decides first, which is exactly the problem ---
    let outcome: BusinessOutcome;
    let fromLocalState = false;

    if (canSeeLeader) {
      const result = tryCommit(op.id, leader, reachable, op.atMs, durableLog);
      commits.push(result);
      if (result.outcome === "COMMITTED" || result.outcome === "REJECTED_DUPLICATE") {
        // Both are correct answers. A duplicate converges on the durable
        // outcome rather than creating a second one -- see quorum intersection.
        outcome = "FULFILLED";
      } else {
        outcome = cfg.app.safeModeOnAuthorityLoss ? "SAFE_MODE" : "REFUSED";
      }
    } else if (cfg.app.decideFromLocalCache) {
      // No authority, but the application answers anyway from regional state.
      // The database is still perfectly consistent. The business is not.
      fromLocalState = true;
      outcome = "FULFILLED";
      if (cfg.app.sideEffectBeforeCommit) sideEffectsWithoutCommit += 1;
      const attempted = tryCommit(op.id, leader, reachable, op.atMs, durableLog);
      commits.push(attempted);
      // What the application knew at the time it answered, not in hindsight.
      if (attempted.outcome === "NO_QUORUM") unconfirmedFulfilments += 1;
      else unconfirmedFulfilments += 1; // decided before any confirmation either way
    } else if (cfg.app.safeModeOnAuthorityLoss) {
      outcome = "SAFE_MODE";
      safeModeCount += 1;
      commits.push(tryCommit(op.id, leader, reachable, op.atMs, durableLog));
    } else {
      outcome = "REFUSED";
      commits.push(tryCommit(op.id, leader, reachable, op.atMs, durableLog));
    }

    decisions.push({
      operationId: op.id,
      decidedIn: op.region,
      outcome,
      fromLocalState,
      atMs: op.atMs,
    });

    const set = outcomesByOperation.get(op.id) ?? new Set<BusinessOutcome>();
    set.add(outcome);
    outcomesByOperation.set(op.id, set);
  }

  // Application-layer split brain: the business said yes, nothing durable
  // backs it. FULFILLED beside SAFE_MODE is NOT this -- that is the system
  // behaving correctly, and counting it as divergence would flatter the
  // unsafe configuration by making every configuration look equally bad.
  const unbackedFulfilments = decisions
    .filter((d) => d.outcome === "FULFILLED" && d.fromLocalState)
    .filter((d) => !durableLog.has(d.operationId))
    .map((d) => d.operationId);

  // Double commit: the property the database must never violate. Counted from
  // actual COMMITTED results, not from how many attempts were made.
  const commitCounts = new Map<string, number>();
  for (const c of commits) {
    if (c.outcome === "COMMITTED") {
      commitCounts.set(c.operationId, (commitCounts.get(c.operationId) ?? 0) + 1);
    }
  }
  const doubleCommits = [...commitCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id);

  return {
    label: cfg.label,
    commits,
    decisions,
    unbackedFulfilments,
    doubleCommits,
    safeModeCount,
    sideEffectsWithoutCommit,
    unconfirmedFulfilments,
    leaderRegionOverTime,
  };
}

export { MAJORITY, REPLICAS, VOTING };
