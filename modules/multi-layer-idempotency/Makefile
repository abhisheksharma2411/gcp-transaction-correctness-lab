# One command runs everything. No cloud project, no credentials, no network.
#
#   make verify

NODE ?= node
NPX  ?= npx
PY   ?= python3

TESTS = tests/contract.test.ts tests/fingerprint.test.ts tests/layers.test.ts \
        tests/boundaries.test.ts tests/conformance.test.ts

.PHONY: help verify test typecheck report matrix replay secret-scan clean

help:
	@echo "verify        run everything (no cloud project, no credentials, no network)"
	@echo "test          contract, fingerprint, layers, boundaries, conformance"
	@echo "typecheck     strict TypeScript check (needs: npm install)"
	@echo "report        run the conformance matrix and tallies -> results/"
	@echo "matrix        check conformance-matrix.json against the source"
	@echo "replay        operator replay demo (see: node scripts/replay.ts --help)"
	@echo "secret-scan   credential scan"
	@echo "clean         remove generated results"

verify: typecheck test report matrix secret-scan
	@echo ""
	@echo "verify: PASS"

test:
	@echo "== contract, boundaries, conformance =="
	$(NODE) --test $(TESTS)

typecheck:
	@echo "== strict type check =="
	@if [ -d node_modules/typescript ]; then \
		$(NPX) tsc --noEmit -p tsconfig.json && echo "typecheck: PASS"; \
	else \
		echo "typecheck: SKIPPED (run 'npm install' to enable)"; \
	fi

report:
	@echo "== conformance matrix and tallies =="
	@$(NODE) scripts/report.ts > /dev/null
	@echo "wrote results/conformance.json and results/report.md"

matrix:
	@echo "== exported matrix drift check =="
	@$(NODE) scripts/export-matrix.ts --check

replay:
	@$(NODE) scripts/replay.ts --op op-7741 --ref order-7741 --amount 2500 --evicted

secret-scan:
	@echo "== secret scan =="
	@$(PY) scripts/secret-scan.py

clean:
	rm -rf results/*.json results/*.md
