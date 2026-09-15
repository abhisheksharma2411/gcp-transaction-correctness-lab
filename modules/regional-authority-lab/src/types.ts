// Vocabulary for the regional authority lab.
//
// The lab models two things at once, and keeping them separate in the types is
// the whole point:
//
//   * the DATABASE layer, which uses a documented majority-quorum rule and
//     therefore cannot accept two conflicting writes for one operation;
//   * the APPLICATION layer, which has no quorum, and which can absolutely
//     produce two divergent business outcomes from the same partition.
//
// Article 3's argument is that the second risk survives the first being solved.

export type RegionId = "us-east" | "us-west" | "witness";

export type ReplicaRole = "read-write" | "witness" | "read-only";

export interface Replica {
  readonly id: string;
  readonly region: RegionId;
  readonly role: ReplicaRole;
  /** Witness replicas vote but hold no servable data. Read-only replicas do not vote. */
  readonly votes: boolean;
}

/** Outcome of asking the database to commit. */
export type CommitOutcome =
  | "COMMITTED"
  | "NO_QUORUM" // a partitioned minority cannot commit, by construction
  | "REJECTED_DUPLICATE"; // the operation id already has a durable outcome

export interface CommitResult {
  readonly operationId: string;
  readonly outcome: CommitOutcome;
  /** Replicas that acknowledged. Present so tests can assert a real majority. */
  readonly acks: readonly string[];
  readonly leaderRegion: RegionId;
  readonly atMs: number;
}

/**
 * What the application decided, which is not the same thing as what the
 * database committed. The gap between these two is the article.
 */
export type BusinessOutcome =
  | "FULFILLED"
  | "REFUSED"
  | "SAFE_MODE" // refused because authority could not be confirmed
  | "DIVERGENT"; // two regions produced different answers for one operation

export interface AppDecision {
  readonly operationId: string;
  readonly decidedIn: RegionId;
  readonly outcome: BusinessOutcome;
  /** True when the decision was taken from regional state rather than authority. */
  readonly fromLocalState: boolean;
  readonly atMs: number;
}

export interface AppPolicy {
  /**
   * Read a local cache instead of the authority when deciding.
   *
   * This is the single most common way a correct database is turned into an
   * incorrect system, and the lab exists to measure it.
   */
  readonly decideFromLocalCache: boolean;
  /** Staleness of that cache, in ms. Spanner's docs offer 15s as reasonable. */
  readonly cacheStalenessMs: number;
  /**
   * Refuse rather than guess when the authority cannot be reached.
   * Turning this off is how an application invents a second authority.
   */
  readonly safeModeOnAuthorityLoss: boolean;
  /** Fire an external side effect before the commit is confirmed. */
  readonly sideEffectBeforeCommit: boolean;
}

export interface ScenarioConfig {
  readonly label: string;
  readonly seed: number;
  readonly durationMs: number;
  /** Regions that cannot reach each other, as pairs, active for a window. */
  readonly partition?: {
    readonly isolate: RegionId;
    readonly fromMs: number;
    readonly toMs: number;
  };
  /** Region whose replicas are entirely lost. */
  readonly regionLoss?: {
    readonly region: RegionId;
    readonly fromMs: number;
    readonly toMs: number;
  };
  /** Traffic routing moves this long after a region becomes unreachable. */
  readonly trafficMoveDelayMs: number;
  /** Leader re-election takes this long once the leader region is lost. */
  readonly leaderElectionMs: number;
  readonly app: AppPolicy;
  /** Business operations issued during the run, with the region they land in. */
  readonly operations: readonly { id: string; atMs: number; region: RegionId }[];
}

export interface ScenarioResult {
  readonly label: string;
  readonly commits: readonly CommitResult[];
  readonly decisions: readonly AppDecision[];
  /**
   * Operations the application fulfilled without a durable commit behind them.
   *
   * This is the application-layer split brain, and it is the number the
   * article is actually about. The database can be perfectly consistent while
   * this is non-zero.
   */
  readonly unbackedFulfilments: readonly string[];
  /**
   * Fulfilments where, AT THE MOMENT OF DECIDING, no commit had succeeded.
   *
   * `unbackedFulfilments` is computed at the end of the run and is therefore
   * retroactively generous: an operation fulfilled blindly in a minority
   * region, and later committed by the majority side, looks backed in
   * hindsight. The application never knew that. This counter records what the
   * application actually knew when it answered the customer, which is the
   * honest measure of the risk it took.
   */
  readonly unconfirmedFulfilments: number;
  /**
   * Operations with more than one COMMITTED write.
   *
   * Must always be empty. A majority quorum makes it structurally impossible,
   * and if this is ever non-empty the model is wrong, not Spanner.
   */
  readonly doubleCommits: readonly string[];
  readonly safeModeCount: number;
  readonly sideEffectsWithoutCommit: number;
  readonly leaderRegionOverTime: readonly { atMs: number; leader: RegionId }[];
}
