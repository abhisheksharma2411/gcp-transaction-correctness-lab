# Changelog

All notable changes to this repository are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] - 2026-09-03

### Added

- `modules/retry-safe-command-api`: companion lab for Article 1.
  - Operation ledger with caller-supplied operation identity, canonical request
    fingerprint, and a derived provider idempotency key.
  - `OUTCOME_UNKNOWN` as a durable state that stores no response snapshot and
    cannot be removed by a retention policy.
  - Two-tier retention: a short-lived operation record and a long-lived effect
    claim, so a retry arriving after pruning cannot become a second charge.
  - Transactional outbox written in the same commit as the state change, an
    at-least-once bus, and a consumer whose inbox is keyed on effect identity.
  - Bounded reconciliation with escalation to `MANUAL_REVIEW` rather than a
    guessed terminal state.
  - Business-effect invariant harness that audits provider effects, operation
    state, and ledger postings against each other.
  - 14 conformance tests, 4 negative controls, 4 Spanner emulator schema tests.
  - Spanner DDL, applied and verified against the Cloud Spanner emulator.
  - Opt-in Terraform profile with cost notes, validated with `terraform validate`.
  - Secret scan covering credential patterns and Luhn-valid card-length
    sequences.
  - Three architecture decision records and a comparison of the Stripe, PayPal,
    and AWS idempotency contracts.
