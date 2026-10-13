# What this model is not

Every way `settlement-reconciliation` departs from a deployed system on Google
Cloud, and from the real behaviour of payment providers and banks. Written to
be unflattering: the numbers in the article are this model's numbers, not
production's.

## Nothing runs on Google Cloud

No project was created, no credential used, no API called. Cloud Storage,
Eventarc, Pub/Sub, Workflows, Cloud Run, Cloud SQL, BigQuery, Cloud KMS and
Sensitive Data Protection appear in the article as a reference design, and
nowhere in the code. The module is an in-memory pipeline over strings.

Specifically:

- **Object immutability is a convention here, not a precondition.**
  `EvidenceStore` never overwrites because it never offers a method that
  could. A real bucket needs `ifGenerationMatch=0` on every write and an
  Object Retention Lock configuration, and the test that it works is an IAM
  test, not a unit test.
- **CRC32C is computed, never compared with a platform.** The module hashes
  its own bytes. Cloud Storage's server-side validation is a different
  mechanism, on a different side of the wire, and the model does not
  exercise it.
- **There is no event delivery.** Files appear in an array, in order. In a
  deployment they arrive as `OBJECT_FINALIZE` notifications that may be
  delivered more than once and out of order, which is a redelivery problem
  this model does not have because `admit()` is called once per file.
- **There is no orchestration.** No Workflows execution, no retry policy, no
  callback, no Cloud Tasks queue, no partial failure halfway through a batch.
  Everything is one synchronous pass.
- **There is no concurrency.** Two files cannot arrive at once, two
  investigators cannot disposition the same case, and no transaction is
  retried. Every race a deployment would have is absent.

## The files are not real settlement files

- **Two formats, both invented.** `acq-csv` and `psp-jsonl` are shaped like
  reports that providers publish, with the fields the article needs. No real
  provider's schema is reproduced, and no real provider's file was read.
- **No camt.053, no BAI2, no ISO 20022 anything.** The bank statement is a
  small JSON document with an `entries` array. A real statement has balances,
  opening and closing positions, value dates distinct from booking dates,
  structured and unstructured remittance fields, and reversal indicators.
- **Remittance matching is a split on whitespace.** Real remittance text is
  truncated, re-cased, stripped of punctuation by intermediaries, and
  sometimes absent. Deposit-to-batch matching in production is the hardest
  part of this problem and the model makes it the easiest.
- **One account, one bank, one statement.** No multi-account sweeping, no
  intermediary, no correspondent banking, no cut-off time at the bank.
- **Two currencies, both with 100 minor units.** No JPY, no three-decimal
  currencies, no FX conversion, no rate, no conversion fee, no settlement in
  a currency other than the presentment currency.

## The money model is thin

- **The fee model is `round(gross × 0.029) + 30`.** It is a parameter, not a
  published schedule. No interchange, no scheme fees, no assessment, no
  blended versus interchange-plus pricing, no monthly minimum, no invoice.
- **A refund carries no fee, and a chargeback carries a flat 1,500.** Both
  are choices made to keep the arithmetic legible.
- **Reserves are not modelled.** The article defines a reserve; the code has
  no rolling reserve, no reserve release, no held balance.
- **Disputes are a `Kind` and nothing else.** No lifecycle, no deadline, no
  representment, no provisional credit. Article 21 owns all of it.
- **There is no tax.** No withholding, no VAT on fees, no 1099-K reporting.

## The corpus is constructed, not sampled

- **The defects offset by construction.** The period difference is zero
  because the amounts were chosen so that it would be. That is the experiment:
  it demonstrates that a zero difference is compatible with seven defects. It
  is *not* evidence about how often real defects offset, and the article says
  so. A real period's defects offset partially and by accident.
- **180 expectations is small.** Nothing here says anything about matching at
  a million rows a day, where the join strategy, not the rule set, is the
  design.
- **The generator is a linear congruential sequence with a fixed seed.**
  Amounts are uniform in [5.00, 250.00]. Real settlement amounts are not
  uniform and the tail matters.
- **Every internal expectation is correct except where a defect was planted.**
  No duplicate internal records, no capture recorded twice, no missing
  internal record for a real payment.

## The matching is deliberately narrow

- **Five rules, and no fuzzy matching anywhere in the decision path.** The
  heuristic in `src/suggest.ts` is scored and never applied, which is the
  design, but it also means the model never shows the hard case: an exception
  queue that a person can only clear with judgement.
- **`M4_SPLIT_TO_ONE` requires the grosses to sum exactly.** A real split
  settlement arrives across different days and different batches.
- **`M5_PARTIAL_SETTLEMENT` fires on the first smaller row it finds.** With
  several partials against one expectation it would need an allocation rule,
  and the model has none.
- **Tolerance is a single number in minor units, applied to the fee only.** A
  real tolerance policy is per corridor, per currency, often proportional, and
  is reviewed.
- **The duplicate test is exact-signature.** A provider that re-sends a row
  with a cosmetic difference would read as two different rows.

## The exception workflow is a data structure

- **No queue, no assignment algorithm, no ageing, no SLA, no escalation, no
  investigator tooling.** A case is an object with a state and a history.
- **The evidence digest proves the actor saw the same bytes, not that they
  read them.**
- **A write-off posts an adjustment instruction. Nothing checks an approval
  limit**, and in a real finance organisation the amount decides who may
  approve it.

## The posting decision is a boundary, not a ledger

- **`PostingInstruction` is not a journal.** It has no accounts, no debit and
  credit sides, no period, no balance. Article 14's module owns that shape,
  and nothing here imports it.
- **`POST_SETTLEMENT` requires a confirmed deposit. That is stricter than
  many real designs**, which post on settlement-file receipt and treat the
  deposit as a separate control. The stricter rule is defended in ADR-002; it
  is a choice, not a law.
- **Nothing reverses.** A posting instruction issued against a file that is
  later corrected would need a reversal, and the model regenerates the whole
  period instead. That works because the period is small and the pipeline is
  pure; it does not work at scale.

## Time is simplified

- **Dates are UTC days.** No time zones, no provider cut-off in CET, no
  banking days, no weekends, no holidays. A funding date three calendar days
  later may be five banking days later in reality.
- **There is one business cutoff for the whole period.** Real reconciliation
  runs several cutoffs at once: an operational one, an accounting one, and a
  regulatory one.
- **Arrival time is the `receivedAt` on the fixture.** There is no clock skew
  between the provider's timestamp and ours, and no notification latency.

## The oracle is independent, but not infallible

- It re-reads the raw bytes and sums them by field name, so a positional
  parser bug cannot hide. It cannot catch an error in the *corpus*: if the
  fixture generator writes a wrong number, both the pipeline and the oracle
  read the same wrong number and agree.
- Its decimal reader uses `parseFloat`, which is a different implementation
  from the pipeline's regex but is not an independent *specification*. Both
  assume two decimal places in the file.
- `providerNetFromRaw` ignores the settlement summary and the bank statement.
  The deposit tie-out therefore has no independent path, and the review
  records that as an open gap rather than a solved problem.
