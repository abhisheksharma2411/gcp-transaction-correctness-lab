#!/usr/bin/env python3
"""Repository safety scan.

Two jobs. First, the usual credential patterns. Second, and specific to a
payments repository: refuse to ship anything that looks like a real primary
account number. Test fixtures in this lab are synthetic and must stay that way,
so any Luhn-valid card-length digit string is treated as a finding until a human
says otherwise.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SKIP_DIRS = {".git", "node_modules", ".terraform", "dist", "build", "__pycache__"}
SKIP_FILES = {"package-lock.json", "secret-scan.py"}
TEXT_EXT = {
    ".ts", ".js", ".mjs", ".json", ".sql", ".tf", ".sh", ".md", ".yaml", ".yml",
    ".txt", ".mmd", ".html", ".py", ".env", ".cfg", ".toml",
}

PATTERNS = [
    ("private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("service account json", re.compile(r'"type"\s*:\s*"service_account"')),
    ("google api key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("gcp oauth client secret", re.compile(r"\bGOCSPX-[0-9A-Za-z_\-]{20,}")),
    ("aws access key id", re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("stripe live secret key", re.compile(r"\bsk_live_[0-9A-Za-z]{16,}")),
    ("slack token", re.compile(r"\bxox[abprs]-[0-9A-Za-z\-]{10,}")),
    ("github token", re.compile(r"\bgh[pousr]_[0-9A-Za-z]{36,}")),
    ("bearer literal", re.compile(r"[Aa]uthorization\s*[:=]\s*[\"']?Bearer\s+[A-Za-z0-9._\-]{20,}")),
    ("hardcoded password assignment", re.compile(r"(?i)\b(password|passwd|secret|api_?key)\s*[:=]\s*[\"'][^\"'\s]{8,}[\"']")),
]

# Contexts where a long digit run is legitimately not a card number.
CARD_CANDIDATE = re.compile(r"(?<![0-9])(?:[0-9][ -]?){12,18}[0-9](?![0-9])")


def luhn_ok(digits: str) -> bool:
    total = 0
    parity = len(digits) % 2
    for i, ch in enumerate(digits):
        d = int(ch)
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def scan_file(path: str) -> list[str]:
    findings = []
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
    except OSError as exc:
        return [f"{path}: unreadable ({exc})"]

    for lineno, line in enumerate(lines, 1):
        if "secret-scan-allow" in line:
            continue
        for label, pattern in PATTERNS:
            if pattern.search(line):
                findings.append(f"{path}:{lineno}: {label}")
        for match in CARD_CANDIDATE.finditer(line):
            digits = re.sub(r"[ -]", "", match.group(0))
            if 13 <= len(digits) <= 19 and luhn_ok(digits):
                findings.append(
                    f"{path}:{lineno}: Luhn-valid {len(digits)}-digit sequence "
                    f"(possible PAN): {digits[:4]}...{digits[-2:]}"
                )
    return findings


def main() -> int:
    findings: list[str] = []
    scanned = 0
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if name in SKIP_FILES:
                continue
            ext = os.path.splitext(name)[1]
            if ext and ext not in TEXT_EXT:
                continue
            path = os.path.join(dirpath, name)
            scanned += 1
            findings.extend(scan_file(path))

    rel = lambda p: os.path.relpath(p, ROOT)  # noqa: E731
    if findings:
        print(f"secret scan FAILED: {len(findings)} finding(s) across {scanned} files")
        for f in findings:
            print(f"  - {rel(f) if f.startswith(ROOT) else f}")
        return 1
    print(f"secret scan passed: {scanned} files, 0 findings")
    return 0


if __name__ == "__main__":
    sys.exit(main())
