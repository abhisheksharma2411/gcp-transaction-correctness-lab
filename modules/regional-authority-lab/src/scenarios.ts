import type { AppPolicy, ScenarioConfig } from "./types.ts";

/**
 * Two application policies, identical infrastructure.
 *
 * The article's whole argument is the difference between these two rows, run
 * against a database that behaves impeccably in both.
 */
export const SAFE: AppPolicy = {
  decideFromLocalCache: false,
  cacheStalenessMs: 15_000,
  safeModeOnAuthorityLoss: true,
  sideEffectBeforeCommit: false,
};

/** The configuration that turns a consistent database into an inconsistent business. */
export const UNSAFE: AppPolicy = {
  decideFromLocalCache: true,
  // 15s is the value Spanner's own read documentation offers as reasonable.
  cacheStalenessMs: 15_000,
  safeModeOnAuthorityLoss: false,
  sideEffectBeforeCommit: true,
};

const BASE = {
  seed: 1234,
  durationMs: 60_000,
  // Health-check defaults: 5s interval, 2-probe unhealthy threshold.
  trafficMoveDelayMs: 10_000,
  // Documented as under ten seconds.
  leaderElectionMs: 10_000,
} as const;

export function scenario(
  label: string,
  app: AppPolicy,
  over: Partial<ScenarioConfig> & Pick<ScenarioConfig, "operations">,
): ScenarioConfig {
  return { ...BASE, label, app, ...over };
}

/** Isolate the leader region for a window. */
export const PARTITION_LEADER = { isolate: "us-east", fromMs: 20_000, toMs: 40_000 } as const;
/** Lose the leader region entirely. */
export const LOSE_LEADER = { region: "us-east", fromMs: 20_000, toMs: 40_000 } as const;
