# One command runs everything. No cloud project, no credentials, no network.
#
#   make verify

NODE ?= node
NPX  ?= npx
PY   ?= python3

TESTS = tests/machine.test.ts tests/guards.test.ts tests/lease.test.ts \
        tests/timers.test.ts tests/crash.test.ts tests/verify.test.ts \
        tests/migrate.test.ts tests/drivers.test.ts tests/controls.test.ts

.PHONY: help verify test typecheck report generate drift inspect secret-scan clean

help:
	@echo "verify        run everything (no cloud project, no credentials, no network)"
	@echo "test          machine, guards, lease, timers, crash, verify, migrate, drivers, controls"
	@echo "typecheck     strict TypeScript check (needs: npm install)"
	@echo "report        run every scenario and write results/"
	@echo "generate      regenerate state-machine.json, docs/STATE_MACHINE.md, results/state-machine.mmd"
	@echo "drift         fail if the generated artifacts no longer match src/spec.ts"
	@echo "inspect       print one scenario's transition history (see: node scripts/inspect.ts --help)"
	@echo "secret-scan   credential scan"
	@echo "clean         remove generated results"

verify: typecheck test report drift secret-scan
	@echo ""
	@echo "verify: PASS"

test:
	@echo "== machine, guards, lease, timers, crash, verification, migration, drivers, controls =="
	$(NODE) --test $(TESTS)

typecheck:
	@echo "== strict type check =="
	@if [ -d node_modules/typescript ]; then \
		$(NPX) tsc --noEmit -p tsconfig.json && echo "typecheck: PASS"; \
	else \
		echo "typecheck: SKIPPED (run 'npm install' to enable)"; \
	fi

report:
	@echo "== scenarios, crash matrix, verification, negative controls =="
	@$(NODE) scripts/report.ts > /dev/null
	@echo "wrote results/report.json and results/report.md"

generate:
	@$(NODE) scripts/generate.ts

drift:
	@echo "== generated-artifact drift check =="
	@$(NODE) scripts/generate.ts --check

inspect:
	@$(NODE) scripts/inspect.ts --scenario S17

secret-scan:
	@echo "== secret scan =="
	@$(PY) scripts/secret-scan.py

clean:
	rm -rf results/*.json results/*.md results/*.mmd
