# One command runs everything. No cloud project, no credentials, no network.
#
#   make verify

NODE ?= node
NPX  ?= npx
PY   ?= python3

TESTS = tests/money.test.ts tests/journal.test.ts tests/ledger.test.ts \
        tests/spanner.test.ts tests/projection.test.ts \
        tests/invariants.test.ts tests/mutations.test.ts

.PHONY: help verify test typecheck report determinism trace secret-scan clean

help:
	@echo "verify        run everything (no cloud project, no credentials, no network)"
	@echo "test          money, journal, ledger, spanner, projection, invariants, mutations"
	@echo "typecheck     strict TypeScript check (needs: npm install)"
	@echo "report        run the ledger and write the proof report -> results/"
	@echo "determinism   re-run the report and require byte-identical output"
	@echo "trace         trace one journal and its reversal (see: --ref)"
	@echo "secret-scan   credential scan"
	@echo "clean         remove generated results"

verify: typecheck test report determinism secret-scan
	@echo ""
	@echo "verify: PASS"

test:
	@echo "== money, journals, ledger, spanner semantics, projection, invariants, negative controls =="
	$(NODE) --test $(TESTS)

typecheck:
	@echo "== strict type check =="
	@if [ -d node_modules/typescript ]; then \
		$(NPX) tsc --noEmit -p tsconfig.json && echo "typecheck: PASS"; \
	else \
		echo "typecheck: SKIPPED (run 'npm install' to enable)"; \
	fi

report:
	@echo "== proof report, mutation matrix, audit export =="
	@$(NODE) scripts/report.ts > /dev/null
	@echo "wrote results/proof.json, results/mutations.json, results/audit-export.json, results/report.md"

determinism:
	@echo "== re-running the report must change nothing =="
	@cp results/proof.json results/.proof.prev
	@cp results/audit-export.json results/.audit.prev
	@$(NODE) scripts/report.ts > /dev/null
	@cmp -s results/proof.json results/.proof.prev && cmp -s results/audit-export.json results/.audit.prev \
		&& echo "determinism: PASS" \
		|| (echo "determinism: FAIL -- the report is not reproducible" && rm -f results/.proof.prev results/.audit.prev && exit 1)
	@rm -f results/.proof.prev results/.audit.prev

trace:
	@$(NODE) scripts/trace.ts --ref fee-9004

secret-scan:
	@echo "== secret scan =="
	@$(PY) scripts/secret-scan.py

clean:
	rm -rf results/*.json results/*.md results/.*.prev
