# ADR-003: The packet, not the document, is what a human approves

## Context

Evidence arrives one document at a time. Approval is a human act. The obvious
model is to let a reviewer approve documents as they arrive and submit whatever
is approved when the deadline nears.

One provider's public API reference describes a rule that makes this model
unsafe. Of the dispute evidence object it says: "Updating any field in the hash
submits all fields in the hash for review." And of the submission counter:
"The number of times evidence has been submitted. Typically, you may only
submit evidence once."

## Options considered

**A. Per-document approval.** Each item carries an approved flag.

**B. Per-packet approval.** The unit of approval is the whole evidence set,
identified by a hash over its members and their content digests.

**C. Per-packet approval with mutable packets.** One packet per case, edited in
place as evidence changes.

## Decision

B. Packets are immutable and versioned; changing any member mints a new version
and leaves the previous one untouched.

## Why this option

Under a provider rule where any update re-submits everything, A records
approval of something that cannot be submitted on its own. A reviewer who
approved three documents has, in effect, approved whatever the fourth turns out
to be, and the record will say otherwise.

C loses the thing that matters most after the fact: what was actually sent. A
packet that is edited in place cannot answer "what did we submit on the
fourteenth", and that is precisely the question an audit asks.

B costs a version every time a document changes after approval, which looks
like churn and is actually the record working. `results/report.md` shows one
case where the analyst replaced a receipt with a signed copy after approval:
two packet versions, two manifest hashes, both reproducible, and a diff between
them in the audit trail.

## What the manifest commits to

Sorted item identifiers and their content digests, plus the rule version and
the deadline basis. Not the approver and not the approval time: those identify
the approval event rather than the thing approved, and two reviewers approving
the same evidence must produce the same manifest. There is a test for that.

## Consequences

`approve()` is idempotent for an unchanged set -- re-approving returns the
existing packet rather than minting v2 of identical content. Replacing a
document while the case is `AWAITING_APPROVAL` moves it back to
`COLLECTING_EVIDENCE`, so an approval can never be inherited by evidence the
approver did not see.

## Conditions that would change this decision

A provider that accepted genuine incremental evidence, with per-document
acknowledgement and no limit on submissions, would make A defensible. Even
then, the version history is cheap and the audit value is the same.
