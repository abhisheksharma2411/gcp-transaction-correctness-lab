# One command runs everything that can be verified without a cloud project.
#
#   make verify
#
# This module has no cloud mode at all. It is a deterministic simulator, and
# the README says plainly what that does and does not prove.

NODE ?= node
NPX  ?= npx
PY   ?= python3

TESTS = tests/admission.test.ts tests/invariants.test.ts tests/negative-control.test.ts

.PHONY: help verify test typecheck report secret-scan clean

help:
	@echo "verify        run everything (no cloud project, no credentials, no network)"
	@echo "test          admission units, invariants, and negative controls"
	@echo "typecheck     strict TypeScript check (needs: npm install)"
	@echo "report        run every experiment -> results/*.json and results/experiments.md"
	@echo "secret-scan   credential scan"
	@echo "clean         remove generated results"

verify: typecheck test report secret-scan
	@echo ""
	@echo "verify: PASS"

# Explicit file list, not a glob, for the same reason as the Article 1 module:
# a test count that depends on what happens to be on disk is not a test count.
test:
	@echo "== admission units, invariants, negative controls =="
	$(NODE) --test $(TESTS)

typecheck:
	@echo "== strict type check =="
	@if [ -d node_modules/typescript ]; then \
		$(NPX) tsc --noEmit -p tsconfig.json && echo "typecheck: PASS"; \
	else \
		echo "typecheck: SKIPPED (run 'npm install' to enable)"; \
	fi

report:
	@echo "== experiment matrix =="
	@$(NODE) scripts/experiments.ts > /dev/null
	@echo "wrote results/experiments.md and results/*.json"

secret-scan:
	@echo "== secret scan =="
	@$(PY) scripts/secret-scan.py

clean:
	rm -rf results/*.json results/*.md
