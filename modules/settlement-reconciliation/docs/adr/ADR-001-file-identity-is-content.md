# ADR-001 — A file's identity is its content, and its name is a label

**Status:** accepted
**Date:** 2026-10-09

## Context

Providers re-send settlement files. They re-send them under the same name, and
under a new name with a date suffix, and occasionally with one row changed and
no announcement that anything changed. Any reconciliation that keys on the
filename treats the first case as an overwrite, the second as new work, and the
third as truth.

Cloud Storage offers two mechanisms that bear on this, and they do different
jobs. The data-validation page says of checksums that "CRC32C is the
recommended validation method for performing integrity checks", and describes
what happens when the client's checksum and the server's disagree: "If the
checksums don't match, the write request is rejected with a
BadRequestException: 400 error." The request-preconditions page describes a
create-if-absent write: with a generation-match precondition of zero, "the
request only proceeds if no object with the specified name exists in the bucket
or if there are only noncurrent versions of the object in the bucket."

One of those answers *did the bytes arrive intact*. The other answers *is this
name already taken*. Neither answers *have I seen these bytes before*.

## Decision

Three identifiers, kept apart:

- **Content identity** is SHA-256 over the bytes. It is what `admit()` keys on,
  and it is what makes a re-delivery a re-delivery whatever it is called.
- **Integrity** is CRC32C, computed on every arrival and stored. It mirrors
  what the platform would compute, and it is what an auditor recomputes.
- **The declared name** is a label. It participates in exactly one decision: a
  name already held by a live file, offered again with different bytes and no
  declared correction, is a `CONTENT_CONFLICT` and is not ingested.

A correction is a file that *declares* what it supersedes. The superseded file
is retired and kept.

## Alternatives considered

**Key on the filename, and treat a repeat as an overwrite.** This is what the
generation-match precondition alone gives you if the name is the object name:
the second write fails with a 412 and the operator is told the file is already
there. It is the common design and it is wrong in one specific case, which the
corpus contains: the same bytes under a new name are ingested twice and every
row becomes a duplicate.

**Key on a provider-supplied file id.** Better, and still the provider's
choice. A provider that reuses an id for a corrected file leaves no way to tell
a correction from a repeat, and a provider that mints a new id for a
byte-identical re-send leaves no way to tell a re-send from new work. The
digest answers both without asking the provider anything.

**CRC32C as the content identity, dropping SHA-256.** Tempting, because it is
the checksum the platform already carries. Rejected: 32 bits is an integrity
check against corruption, not an identity against two different files. The cost
of keeping both is one extra hash per file.

## Consequences

- A re-delivery is recorded as `DUPLICATE_IGNORED` rather than dropped
  silently, so the operational question "is this provider re-sending?" has an
  answer.
- Two guards overlap: the digest test and the name test both catch the
  same-name re-delivery. Removing the digest test reddens two probes, not one,
  and only the renamed re-delivery depends on the digest alone. The negative
  control records the overlap instead of pretending each guard is load-bearing.
- A provider that corrects a file without declaring the correction produces a
  conflict that a person must resolve. That is the intended outcome and it is
  work.

## Conditions that would change this

A provider contract that guarantees a stable file identifier and a distinct
correction indicator would make the digest redundant for de-duplication. It
would not make it redundant for the conflict case, because the guarantee would
still be the provider's and not ours.
