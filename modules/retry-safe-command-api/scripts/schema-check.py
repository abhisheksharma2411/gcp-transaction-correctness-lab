#!/usr/bin/env python3
"""Sanity checks on infra/schema.sql.

Not a Spanner parser. It asserts the handful of properties the article
actually depends on, so a careless schema edit fails the build instead of
silently removing a safety property.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = os.path.join(ROOT, "infra", "schema.sql")

REQUIRED = [
    ("payment_operations table", r"CREATE TABLE payment_operations\b"),
    ("effect_claims table", r"CREATE TABLE effect_claims\b"),
    ("outbox table", r"CREATE TABLE payment_outbox\b"),
    ("consumer inbox table", r"CREATE TABLE consumer_inbox\b"),
    ("ledger table", r"CREATE TABLE ledger_entries\b"),
    ("unique business-reference index", r"CREATE UNIQUE NULL_FILTERED INDEX uq_operation_business_reference\b"),
    ("generated active_business_reference column", r"active_business_reference\s+STRING\(128\)\s+AS\s*\("),
    ("row deletion policy on operations", r"ROW DELETION POLICY \(OLDER_THAN\(expires_at"),
    ("inbox keyed on effect identity", r"CREATE TABLE consumer_inbox[\s\S]*?PRIMARY KEY \(effect_id\)"),
    ("ledger keyed on effect identity", r"CREATE TABLE ledger_entries[\s\S]*?PRIMARY KEY \(effect_id\)"),
]

FORBIDDEN = [
    (
        "expires_at must stay nullable so an unknown outcome is never TTL-deleted",
        r"expires_at\s+TIMESTAMP\s+NOT NULL",
    ),
]


def main() -> int:
    if not os.path.exists(SCHEMA):
        print(f"schema-check FAILED: {SCHEMA} not found")
        return 1
    sql = open(SCHEMA, encoding="utf-8").read()

    failures = []
    for label, pattern in REQUIRED:
        if not re.search(pattern, sql):
            failures.append(f"missing: {label}")
    for label, pattern in FORBIDDEN:
        if re.search(pattern, sql):
            failures.append(f"forbidden: {label}")

    # Strip comment lines before counting, otherwise a comment block attached
    # to a statement hides it from the count.
    stripped = "\n".join(
        line for line in sql.splitlines() if not line.lstrip().startswith("--")
    )
    statements = [s for s in stripped.split(";") if s.strip()]
    if len(statements) < 8:
        failures.append(f"expected at least 8 DDL statements, found {len(statements)}")

    if failures:
        print(f"schema-check FAILED: {len(failures)} problem(s)")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"schema-check passed: {len(REQUIRED)} properties, {len(statements)} DDL statements")
    return 0


if __name__ == "__main__":
    sys.exit(main())
