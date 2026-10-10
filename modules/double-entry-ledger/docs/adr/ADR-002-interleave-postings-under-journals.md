# ADR-002 — Postings are interleaved under Journals, not keyed by account

**Status:** accepted
**Date:** 2026-10-09

## Context

A ledger has two dominant access patterns and they want opposite keys.

Writing wants locality by journal: one journal and its postings commit
together, and the transaction guidance says transactions "are fastest when all
reads and writes access data in the same part of the key space."

Reading wants locality by account: rebuilding a balance means scanning every
posting for one account, and under a journal-first key those rows are scattered
across the whole table.

Only one of them can have the primary key.

## Decision

`Postings` is `INTERLEAVE IN PARENT Journals ON DELETE NO ACTION`, keyed
`(LedgerId, JournalId, LineNumber)`. The account access path is a secondary
index, `PostingsByAccount`, storing direction, currency and amount so the
rebuild does not go back to the base table.

## Why the write side won

Three reasons, and the third is the one that settled it.

**Write locality is on the critical path; the rebuild is not.** Every posted
journal pays the write cost. A balance rebuild is an audit operation and a
periodic check.

**An account-first key concentrates writes on hot accounts.** A clearing
account or a fee account receives a posting from nearly every journal. Under
`(LedgerId, AccountId, ...)` those all land in one contiguous key range. The
schema-design guidance is about monotonic keys specifically, but the mechanism
is the same: a high write rate into one narrow range is one server's problem.

**Retention cannot tear a journal in half.** The time-to-live documentation
says a sweep "parallelizes the actual deletes in batches", that "the rows in a
given batch, along with any indexes and interleaved children, are deleted
atomically", and that "deletes across batches happens in different
transactions". A standalone postings table with its own row deletion policy
can therefore lose some postings of a journal and keep others — an imbalance
produced by a retention policy rather than by a bug. Interleaving makes the
journal the unit such a sweep acts on.

## What it costs

The secondary index is not free. Index entries count toward the 80,000
mutations per commit, so every posting costs its own columns plus an index
entry, and the `STORING` clause widens that entry. The report in
`results/report.md` counts the base-table columns only and therefore
understates the real figure; that is noted there and in `docs/MODEL.md`.

Interleaving is also permanent: "After you interleave a table, it's permanent.
You can't undo the interleaving." Changing this decision later means creating
a new table and migrating, on a table that by then holds every posting ever
made.

## The alternative that was rejected and why

**Account-first key, journal as a secondary index.** This makes the rebuild a
contiguous range scan and makes posting a journal a scatter write across as
many splits as it has distinct accounts. It also puts the retention problem on
the side that matters: a sweep over an account-keyed table would delete
postings in account order, which has no relationship at all to journal
boundaries.

**`ON DELETE CASCADE`.** This is the ordinary choice for interleaved children
and it is wrong here. With cascade, deleting one journal row removes every
posting beneath it, and the documentation notes that such a delete counts as
one mutation "regardless of the number of interleaved child rows present". One
cheap statement, an arbitrary number of postings gone. `NO ACTION` forces the
children to be deleted first, and the writer role has no privilege to delete
either.
