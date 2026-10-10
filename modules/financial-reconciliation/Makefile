# One command runs everything. No cloud project, no credentials, no network.
#
#   make verify

NODE ?= node
NPX  ?= npx
PY   ?= python3

TESTS = tests/identity.test.ts tests/ledger.test.ts tests/reconcile.test.ts \
        tests/windows.test.ts tests/replay.test.ts tests/corpus.test.ts

.PHONY: help verify test typecheck report cases determinism clock secret-scan clean

help:
	@echo "verify        run everything (no cloud project, no credentials, no network)"
	@echo "test          identity, ledger, reconciliation, windows, replay, corpus"
	@echo "typecheck     strict TypeScript check (needs: npm install)"
	@echo "report        run every experiment -> results/"
	@echo "cases         check reconciliation-cases.json against the source"
	@echo "determinism   run the report twice and compare the bytes"
	@echo "clock         refuse a wall clock anywhere in src/"
	@echo "secret-scan   credential scan"
	@echo "clean         remove generated results"

verify: typecheck test report cases determinism clock secret-scan
	@echo ""
	@echo "verify: PASS"

test:
	@echo "== identity, ledger, reconciliation, windows, replay, corpus =="
	$(NODE) --test $(TESTS)

typecheck:
	@echo "== strict type check =="
	@if [ -d node_modules/typescript ]; then \
		$(NPX) tsc --noEmit -p tsconfig.json && echo "typecheck: PASS"; \
	else \
		echo "typecheck: SKIPPED (run 'npm install' to enable)"; \
	fi

report:
	@echo "== experiments =="
	@$(NODE) scripts/report.ts

cases:
	@echo "== exported corpus drift check =="
	@$(NODE) scripts/export-cases.ts --check

# A report whose numbers move between two runs of the same experiment is not a
# result. This gate is the difference between claiming reproducibility and
# having it.
determinism:
	@echo "== byte-identical re-run =="
	@cp results/reconciliation.json results/.determinism.json
	@cp results/report.md results/.determinism.md
	@$(NODE) scripts/report.ts > /dev/null
	@cmp -s results/reconciliation.json results/.determinism.json \
	  && cmp -s results/report.md results/.determinism.md \
	  && echo "determinism: PASS" \
	  || (echo "determinism: FAIL - the report is not reproducible"; exit 1)
	@rm -f results/.determinism.json results/.determinism.md

# Every function that needs the time takes it as an argument. A clock reached
# for inside src/ would make the corpus untestable and the report irreproducible.
clock:
	@echo "== no wall clock in src/ =="
	@if grep -n -E "Date\.now|new Date\(\)|performance\.now" src/*.ts; then \
		echo "clock: FAIL - src/ must take the time as a parameter"; exit 1; \
	else \
		echo "clock: PASS"; \
	fi

secret-scan:
	@echo "== secret scan =="
	@$(PY) scripts/secret-scan.py --self-test
	@$(PY) scripts/secret-scan.py

clean:
	rm -rf results/*.json results/*.md results/.determinism.*
