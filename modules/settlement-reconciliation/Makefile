# One command runs everything. No cloud project, no credentials, no network.
#
#   make verify

NODE ?= node
NPX  ?= npx
PY   ?= python3

TESTS = tests/intake.test.ts tests/parsers.test.ts tests/matching.test.ts \
        tests/posting.test.ts tests/exceptions.test.ts \
        tests/conservation.test.ts tests/replay.test.ts tests/controls.test.ts

.PHONY: help verify test typecheck report controls explain secret-scan clean

help:
	@echo "verify        run everything (no cloud project, no credentials, no network)"
	@echo "test          intake, parsers, matching, posting, exceptions, conservation, replay, controls"
	@echo "typecheck     strict TypeScript check (needs: npm install)"
	@echo "report        run the corpus and write results/"
	@echo "controls      print the negative-control matrix"
	@echo "explain       explain one row (see: node scripts/explain.ts --help)"
	@echo "secret-scan   credential and card-number scan"
	@echo "clean         remove generated results"

verify: typecheck test report controls secret-scan
	@echo ""
	@echo "verify: PASS"

test:
	@echo "== intake, parsing, matching, posting, exceptions, conservation, replay, controls =="
	$(NODE) --test $(TESTS)

typecheck:
	@echo "== strict type check =="
	@if [ -d node_modules/typescript ]; then \
		$(NPX) tsc --noEmit -p tsconfig.json && echo "typecheck: PASS"; \
	else \
		echo "typecheck: SKIPPED (run 'npm install' to enable)"; \
	fi

report:
	@echo "== corpus, reconciliation and explanation report =="
	@$(NODE) scripts/report.ts > /dev/null
	@echo "wrote results/reconciliation.json, explanations.json, evidence-manifest.json, report.md"

controls:
	@echo "== negative controls =="
	@$(NODE) scripts/controls.ts

explain:
	@$(NODE) scripts/explain.ts --subject exp-9201

secret-scan:
	@echo "== secret scan =="
	@$(PY) scripts/secret-scan.py

clean:
	rm -rf results/*.json results/*.md
