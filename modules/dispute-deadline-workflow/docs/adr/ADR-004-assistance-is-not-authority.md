# ADR-004: Generated material may be evidence, never approval

## Context

Dispute work is document work: pulling a receipt, finding a delivery
confirmation, writing a short narrative explaining why the charge was
legitimate. All of it looks like work a model could help with, and some of it
is.

There is a line, and the question is where to draw it in code rather than in a
policy document nobody reads.

## Options considered

**A. Keep models out entirely.** No generated material enters the case.

**B. Allow generated material as evidence, with provenance, and require that a
human approve the packet.**

**C. Allow a model to assemble and approve a packet when its confidence is
high, with human review by exception.**

## Decision

B.

## Why this option

C is the option this article's playbook forbids, and the reason is not that
models are unreliable. It is that approval is the act that creates
accountability. A packet is submitted once, it cannot usually be amended, and
losing costs money. "The system approved it" is not an answer anybody can give
to the question of why the wrong document was sent, and building a system that
makes that the only available answer is a design failure rather than a
modelling one.

A is safe and gives up something real: extracting a shipping date from a
carrier PDF is genuinely useful and genuinely tedious.

B keeps the usefulness and keeps the accountability, provided the provenance
survives. `EvidenceItem.origin` carries one of `HUMAN_UPLOAD`, `SYSTEM_EXPORT`
or `MODEL_SUGGESTED`, and it is part of the item, not metadata beside it.

## What is enforced

`approve()` refuses a packet whose every item is `MODEL_SUGGESTED`. Mixed
packets are allowed. The approver is recorded by name, with a reason, and both
are required: an approval without a reason is refused, and there is a mutation
in `scripts/mutate.ts` that removes that check and turns the test red.

This is a deliberately weak rule. It does not prevent a reviewer from approving
a packet they did not read, and nothing in software can. What it does is make
the record say who did it.

## Consequences

Document AI's managed Human in the Loop feature, which would have been the
obvious place to put the review step, was deprecated on 16 January 2024
according to Document AI's own deprecations page. The human step is therefore
the application's to build, which is the practical reason this module models it
rather than pointing at a product.

## Conditions that would change this decision

None that are about model quality. A rule that made submissions amendable and
cheap would change the economics of a wrong packet, and would be the thing to
revisit.
