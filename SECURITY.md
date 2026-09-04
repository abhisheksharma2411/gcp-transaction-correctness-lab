# Security policy

## Scope

This repository contains teaching labs. Nothing here is intended for
production use, and none of it processes real payment data.

Every module in this repository:

- uses synthetic data only;
- contains no real credentials, card numbers, or employer endpoints;
- runs locally by default, with cloud deployment opt-in and bounded.

## Reporting a vulnerability

If you find a security problem in this code — including a sample that would
teach an unsafe pattern — open a GitHub issue describing the problem and the
file. Please do not include real credentials or real cardholder data in an
issue under any circumstances.

For anything you believe should not be public, open an issue asking for a
private contact channel rather than posting details.

## What counts as a finding here

Because this is teaching code, the following are in scope even though they
would be "working as intended" elsewhere:

- a sample that would leak data if copied into a real system;
- an IAM binding broader than the module needs;
- a Terraform default that creates unexpected cost or public exposure;
- a test that appears to prove a safety property it does not actually prove;
- a claim in a README or article that the code does not support.

The last one matters as much as the others.

## Automated checks

`make verify` in each module runs a secret scan that flags credential
patterns and any Luhn-valid 13-to-19 digit sequence, so a real primary account
number fails the build rather than reaching a branch.
