-- Spanner (GoogleSQL dialect) schema for the retry-safe command API.
--
-- Design notes that matter more than the column list:
--
-- 1. `expires_at` is NULL until the operation reaches a terminal state.
--    Spanner's row deletion policy does not delete rows whose timestamp is
--    NULL, so an operation whose outcome is still unknown can never be
--    garbage-collected out from under a retry.
--
-- 2. `active_business_reference` is NULL for FAILED_FINAL operations. Combined
--    with a UNIQUE NULL_FILTERED index, that releases the order for a new
--    attempt when no money moved, while still refusing a second concurrent
--    charge for the same order. A UNIQUE NULL_FILTERED index does not enforce
--    uniqueness when a key part is NULL, which is exactly the behaviour wanted
--    here.
--
-- 3. `effect_claims` is a separate table with a much longer retention than
--    `payment_operations`. The operation row answers "what did we reply?";
--    the claim answers "did this order already move money?". The second
--    question stays relevant long after the first stops being useful.

CREATE TABLE payment_operations (
  operation_id                STRING(64)  NOT NULL,
  operation_type              STRING(16)  NOT NULL,
  business_reference          STRING(128) NOT NULL,
  request_fingerprint         STRING(64)  NOT NULL,
  amount_minor                INT64       NOT NULL,
  currency                    STRING(3)   NOT NULL,
  state                       STRING(24)  NOT NULL,
  provider_operation_key      STRING(64)  NOT NULL,
  provider_effect_id          STRING(64),
  failure_code                STRING(64),
  response_snapshot           JSON,
  attempt_count               INT64       NOT NULL,
  reconcile_attempts          INT64       NOT NULL,
  lease_owner                 STRING(64),
  lease_expires_at            TIMESTAMP,
  created_at                  TIMESTAMP   NOT NULL OPTIONS (allow_commit_timestamp = true),
  updated_at                  TIMESTAMP   NOT NULL OPTIONS (allow_commit_timestamp = true),
  -- Set only on the transition to SUCCEEDED or FAILED_FINAL.
  expires_at                  TIMESTAMP,
  active_business_reference   STRING(128) AS (
    IF(state = 'FAILED_FINAL', NULL, business_reference)
  ) STORED,
) PRIMARY KEY (operation_id),
  ROW DELETION POLICY (OLDER_THAN(expires_at, INTERVAL 0 DAY));

-- Second line of defence. The application takes an explicit claim in
-- effect_claims; this index makes a forgotten claim fail the commit instead of
-- silently allowing a second charge for the same order.
CREATE UNIQUE NULL_FILTERED INDEX uq_operation_business_reference
  ON payment_operations (operation_type, active_business_reference);

CREATE INDEX idx_operations_open_by_state
  ON payment_operations (state, updated_at)
  STORING (business_reference, provider_operation_key);

CREATE TABLE effect_claims (
  operation_type       STRING(16)  NOT NULL,
  business_reference   STRING(128) NOT NULL,
  operation_id         STRING(64)  NOT NULL,
  state                STRING(24)  NOT NULL,
  provider_effect_id   STRING(64),
  created_at           TIMESTAMP   NOT NULL OPTIONS (allow_commit_timestamp = true),
  updated_at           TIMESTAMP   NOT NULL OPTIONS (allow_commit_timestamp = true),
) PRIMARY KEY (operation_type, business_reference);

-- Written in the same transaction as the state change it reports.
CREATE TABLE payment_outbox (
  outbox_id      STRING(128) NOT NULL,
  operation_id   STRING(64)  NOT NULL,
  event_type     STRING(64)  NOT NULL,
  effect_id      STRING(64)  NOT NULL,
  payload        JSON        NOT NULL,
  created_at     TIMESTAMP   NOT NULL OPTIONS (allow_commit_timestamp = true),
  published_at   TIMESTAMP,
) PRIMARY KEY (outbox_id);

CREATE INDEX idx_outbox_unpublished
  ON payment_outbox (published_at, created_at);

-- Consumer-side deduplication, keyed on effect identity rather than message id
-- so that a publish-side duplicate with a fresh message id is still caught.
CREATE TABLE consumer_inbox (
  effect_id       STRING(64) NOT NULL,
  event_type      STRING(64) NOT NULL,
  first_seen_at   TIMESTAMP  NOT NULL OPTIONS (allow_commit_timestamp = true),
) PRIMARY KEY (effect_id);

CREATE TABLE ledger_entries (
  effect_id            STRING(64)  NOT NULL,
  operation_id         STRING(64)  NOT NULL,
  business_reference   STRING(128) NOT NULL,
  amount_minor         INT64       NOT NULL,
  currency             STRING(3)   NOT NULL,
  direction            STRING(8)   NOT NULL,
  posted_at            TIMESTAMP   NOT NULL OPTIONS (allow_commit_timestamp = true),
) PRIMARY KEY (effect_id);
