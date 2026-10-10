# One command runs everything. No cloud project, no credentials, no network.
#
#   make verify

NODE ?= node
NPX  ?= npx
PY   ?= python3

TESTS = tests/zones.test.ts tests/deadline.test.ts tests/manifest.test.ts \
        tests/case.test.ts tests/timers.test.ts tests/governance.test.ts \
        tests/controls.test.ts

.PHONY: help verify test typecheck report mutate tz-drift secret-scan clean

help:
	@echo "verify        run everything (no cloud project, no credentials, no network)"
	@echo "test          zones, deadlines, manifests, cases, timers, governance, controls"
	@echo "typecheck     strict TypeScript check (needs: npm install)"
	@echo "report        regenerate every figure the article quotes -> results/"
	@echo "mutate        break each mechanism and check the named tests go red"
	@echo "tz-drift      compare the pinned zone table with the host's (informational)"
	@echo "secret-scan   credential scan"
	@echo "clean         remove generated results"

verify: typecheck test report mutate secret-scan
	@echo ""
	@echo "verify: PASS"

test:
	@echo "== deadlines, manifests, cases, timers, governance =="
	$(NODE) --test $(TESTS)

typecheck:
	@echo "== strict type check =="
	@if [ -d node_modules/typescript ]; then \
		$(NPX) tsc --noEmit -p tsconfig.json && echo "typecheck: PASS"; \
	else \
		echo "typecheck: SKIPPED (run 'npm install' to enable)"; \
	fi

report:
	@echo "== deadline fixtures, manifests, sweeps and tallies =="
	@$(NODE) scripts/report.ts > /dev/null
	@echo "wrote results/report.md and results/deadlines.json"

mutate:
	@echo "== negative controls =="
	@$(NODE) scripts/mutate.ts --check

tz-drift:
	@$(NODE) scripts/tz-drift.ts

secret-scan:
	@echo "== secret scan =="
	@$(PY) scripts/secret-scan.py

clean:
	rm -rf results/*.json results/*.md
