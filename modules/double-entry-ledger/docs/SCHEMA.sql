-- Spanner GoogleSQL schema for the ledger this module models.
--
-- Not executed by the test suite. It is written out because the TypeScript
-- model deliberately does not simulate DDL, and the schema is where several of
-- the article's decisions actually live. Every choice below is annotated with
-- the reason, including the ones that cost something.
--
-- Nothing here has been run against a Spanner instance. Treat it as a design
-- document, not as a migration.

-- ---------------------------------------------------------------------------
-- Accounts: the chart of accounts.
-- ---------------------------------------------------------------------------
-- One currency per account. A "multi-currency account" is several accounts,
-- which is what keeps the balance check from summing currencies together.

CREATE TABLE Accounts (
  LedgerId            STRING(64) NOT NULL,
  AccountId           STRING(64) NOT NULL,
  Kind                STRING(16) NOT NULL,   -- ASSET | LIABILITY | EQUITY | REVENUE | EXPENSE
  Currency            STRING(3)  NOT NULL,
  Path                STRING(MAX) NOT NULL,  -- chart-of-accounts path; postings name a leaf
  IsPending           BOOL NOT NULL,
  OpenedEffectiveAt   DATE NOT NULL,
  ClosedEffectiveAt   DATE,
  CreatedAt           TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
  CONSTRAINT AccountKindKnown CHECK (
    Kind IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')
  ),
) PRIMARY KEY (LedgerId, AccountId);

-- ---------------------------------------------------------------------------
-- Journals: the atomic accounting unit.
-- ---------------------------------------------------------------------------
-- JournalId is a hash of (LedgerId, BusinessRef). Three things follow:
--
--   1. It is not monotonic, so it does not drive every insert at the end of
--      the key space. The schema-design guidance is explicit that a
--      monotonically increasing first key part creates a hotspot.
--   2. A read-write transaction body that runs twice derives the same id both
--      times, so the primary key refuses the second write.
--   3. The same business reference cannot be posted twice, without a separate
--      uniqueness index to maintain.
--
-- RecordedAt is a commit timestamp column, and it is deliberately NOT part of
-- the primary key: a commit timestamp as the first key part is named in the
-- documentation as a hotspot even at low write rates.

CREATE TABLE Journals (
  LedgerId            STRING(64) NOT NULL,
  JournalId           STRING(72) NOT NULL,   -- jnl_<hash of ledger + business ref>
  BusinessRef         STRING(128) NOT NULL,
  EffectiveAt         DATE NOT NULL,         -- when the economic event happened
  RecordedAt          TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
  Description         STRING(MAX) NOT NULL,
  ReversesJournalId   STRING(72),            -- set only on a reversal
  FxFromCurrency      STRING(3),
  FxToCurrency        STRING(3),
  FxRateNumerator     INT64,
  FxRateDenominator   INT64,
  FxRateSource        STRING(MAX),
  ContentHash         STRING(32) NOT NULL,   -- covers the journal and its postings
  ChainHash           STRING(32) NOT NULL,   -- covers ContentHash and the previous link
) PRIMARY KEY (LedgerId, JournalId);

-- One business reference, one journal. The hash already makes a second write
-- collide on the primary key; this index says so in a way an auditor can read,
-- and catches a JournalId supplied from outside rather than derived.
CREATE UNIQUE INDEX JournalsByBusinessRef
  ON Journals (LedgerId, BusinessRef);

-- ---------------------------------------------------------------------------
-- Postings: immutable lines.
-- ---------------------------------------------------------------------------
-- Interleaved in Journals, for two reasons, one of them a correctness reason:
--
--   * Write locality. A journal and its postings commit against one split,
--     which is what the transaction guidance means by "Transactions are
--     fastest when all reads and writes access data in the same part of the
--     key space."
--   * Retention atomicity. A TTL sweep deletes a batch "along with any
--     indexes and interleaved children" in one transaction, while "deletes
--     across batches happens in different transactions". A postings table with
--     its own retention policy can therefore lose half a journal. Interleaving
--     makes the journal the unit a sweep can act on.
--
-- ON DELETE NO ACTION, not CASCADE. With CASCADE, deleting one journal row
-- silently removes every posting beneath it and the deletion counts as one
-- mutation. NO ACTION forces the child rows to be deleted first, which the
-- writer role has no privilege to do.
--
-- AmountMinor is an integer count of minor units, not a float. Spanner's own
-- numeric-data page explains why: FLOAT64 stores 0.2 as 0.20000000000000001.
-- NUMERIC (precision 38, scale 9 in GoogleSQL) is the other defensible
-- choice; INT64 is used here because the scale belongs to the currency, not
-- to the column.

CREATE TABLE Postings (
  LedgerId            STRING(64) NOT NULL,
  JournalId           STRING(72) NOT NULL,
  LineNumber          INT64 NOT NULL,
  PostingId           STRING(72) NOT NULL,   -- derived from JournalId and LineNumber
  AccountId           STRING(64) NOT NULL,
  Direction           STRING(6)  NOT NULL,
  Currency            STRING(3)  NOT NULL,
  AmountMinor         INT64 NOT NULL,
  Memo                STRING(MAX) NOT NULL,
  CONSTRAINT DirectionKnown CHECK (Direction IN ('DEBIT', 'CREDIT')),
  -- The direction carries the sign. A negative debit is a credit in disguise
  -- and defeats every report that groups by direction.
  CONSTRAINT AmountPositive CHECK (AmountMinor > 0),
) PRIMARY KEY (LedgerId, JournalId, LineNumber),
  INTERLEAVE IN PARENT Journals ON DELETE NO ACTION;

-- Reading an account's postings is the balance rebuild, and under the
-- interleaved key it is not a contiguous range. This index buys that range
-- back. It is not free: index entries count toward the 80,000 mutations per
-- commit, so a journal's cost is its own columns plus one index entry per
-- posting.
CREATE INDEX PostingsByAccount
  ON Postings (LedgerId, AccountId, JournalId, LineNumber)
  STORING (Direction, Currency, AmountMinor);

-- ---------------------------------------------------------------------------
-- Derived state. Not authority.
-- ---------------------------------------------------------------------------
-- A cache of a sum the postings already determine, maintained by a consumer
-- of the change stream, rebuilt and compared by the invariant checker. It is
-- in a separate table with separate privileges precisely so that nothing can
-- mistake it for the ledger.

CREATE TABLE AccountBalances (
  LedgerId            STRING(64) NOT NULL,
  AccountId           STRING(64) NOT NULL,
  Currency            STRING(3)  NOT NULL,
  SignedMinor         INT64 NOT NULL,        -- debits positive, credits negative
  LastAppliedAt       TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
) PRIMARY KEY (LedgerId, AccountId);

-- The consumer's inbox. Without it, a redelivered change record applies twice.
-- Records are returned once per partition query, but a consumer that crashes
-- before committing its checkpoint re-reads from the last one it committed,
-- so the effect at this layer is at-least-once regardless.
CREATE TABLE ProjectionInbox (
  LedgerId            STRING(64) NOT NULL,
  PostingId           STRING(72) NOT NULL,
  AppliedAt           TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
) PRIMARY KEY (LedgerId, PostingId);

CREATE TABLE ProjectionCheckpoints (
  LedgerId            STRING(64) NOT NULL,
  PartitionToken      STRING(MAX) NOT NULL,
  Position            TIMESTAMP NOT NULL,
  UpdatedAt           TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp = true),
) PRIMARY KEY (LedgerId, PartitionToken);

-- ---------------------------------------------------------------------------
-- The change stream.
-- ---------------------------------------------------------------------------
-- Retention is between one and thirty days, seven by default. That is a
-- transport window, not an archive: the postings table is the record, and the
-- stream is how projections hear about it. Reducing the retention limit makes
-- everything older than the new limit "immediately and permanently
-- unavailable to that change stream's readers".

CREATE CHANGE STREAM LedgerPostingsStream
  FOR Postings
  OPTIONS (retention_period = '7d', value_capture_type = 'NEW_ROW');

-- ---------------------------------------------------------------------------
-- Privileges.
-- ---------------------------------------------------------------------------
-- The documented sample use case for fine-grained access control is "A ledger
-- that permits SELECT and INSERT operations but not UPDATE and DELETE
-- operations." This is that, written out.
--
-- Two things are easy to get wrong here:
--
--   * A privilege granted on Journals does not propagate to the interleaved
--     Postings. Both grants are written separately below, on purpose.
--   * Fine-grained roles do not override database-level IAM. A principal
--     holding roles/spanner.databaseUser can still delete a posting. The
--     documentation says to revoke the database-level role once the database
--     role is in place, "so that the principal's access control is managed by
--     only one method", and none of this is immutability until that is done.

CREATE ROLE ledger_writer;
GRANT SELECT, INSERT ON TABLE Journals TO ROLE ledger_writer;
GRANT SELECT, INSERT ON TABLE Postings TO ROLE ledger_writer;
GRANT SELECT ON TABLE Accounts TO ROLE ledger_writer;

CREATE ROLE ledger_projector;
GRANT SELECT ON TABLE Postings TO ROLE ledger_projector;
GRANT SELECT, INSERT, UPDATE ON TABLE AccountBalances TO ROLE ledger_projector;
GRANT SELECT, INSERT ON TABLE ProjectionInbox TO ROLE ledger_projector;
GRANT SELECT, INSERT, UPDATE ON TABLE ProjectionCheckpoints TO ROLE ledger_projector;
GRANT SELECT ON CHANGE STREAM LedgerPostingsStream TO ROLE ledger_projector;
GRANT EXECUTE ON TABLE FUNCTION READ_LedgerPostingsStream TO ROLE ledger_projector;

CREATE ROLE ledger_auditor;
GRANT SELECT ON TABLE Journals TO ROLE ledger_auditor;
GRANT SELECT ON TABLE Postings TO ROLE ledger_auditor;
GRANT SELECT ON TABLE Accounts TO ROLE ledger_auditor;

-- ---------------------------------------------------------------------------
-- What is deliberately absent.
-- ---------------------------------------------------------------------------
-- * No ROW DELETION POLICY on Journals or Postings. Retention for accounting
--   records is set by the obligation, not by storage cost, and the obligation
--   can be open-ended.
-- * No UPDATE privilege on Postings for any role.
-- * No foreign key from Postings to Accounts. The validation layer resolves
--   the account before the journal is built; a foreign key would add a backing
--   index whose entries count toward the per-commit mutation limit, for a
--   check that has already happened.
-- * No sequence or auto-increment anywhere. Every identifier is derived from
--   content that the caller already chose.
