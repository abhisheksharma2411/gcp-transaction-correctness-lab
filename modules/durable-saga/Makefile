# One command runs everything. No cloud project, no credentials, no network.
#
#   make verify

NODE ?= node
NPX  ?= npx
PY   ?= python3

TESTS = tests/definition.test.ts tests/forward.test.ts tests/compensation.test.ts \
        tests/callbacks.test.ts tests/cancel.test.ts tests/manual.test.ts \
        tests/version.test.ts tests/audit.test.ts tests/matrix.test.ts \
        tests/diagram.test.ts tests/controls.test.ts

.PHONY: help verify test typecheck report generate drift inspect secret-scan clean

help:
	@echo "verify        run everything (no cloud project, no credentials, no network)"
	@echo "test          definition, forward, compensation, callbacks, cancel, manual, version, audit, matrix, diagram, controls"
	@echo "typecheck     strict TypeScript check (needs: npm install)"
	@echo "report        run every scenario and the failure matrix, and write results/"
	@echo "generate      regenerate saga.json, docs/SAGA.md and the three diagram sources"
	@echo "drift         fail if the generated artifacts no longer match src/saga.ts"
	@echo "inspect       print one saga's timeline (see: node scripts/inspect.ts --help)"
	@echo "secret-scan   credential scan"
	@echo "clean         remove generated results"

verify: typecheck test report drift secret-scan
	@echo ""
	@echo "verify: PASS"

test:
	@echo "== definition, forward, compensation, callbacks, cancel, manual, version, audit, matrix, diagram, controls =="
	$(NODE) --test $(TESTS)

typecheck:
	@echo "== strict type check =="
	@if [ -d node_modules/typescript ]; then \
		$(NPX) tsc --noEmit -p tsconfig.json && echo "typecheck: PASS"; \
	else \
		echo "typecheck: SKIPPED (run 'npm install' to enable)"; \
	fi

report:
	@echo "== scenarios, failure matrix, negative controls =="
	@$(NODE) scripts/report.ts > /dev/null
	@echo "wrote results/report.json, report.md, matrix.md and timeline.md"

generate:
	@$(NODE) scripts/generate.ts

drift:
	@echo "== generated-artifact drift check =="
	@$(NODE) scripts/generate.ts --check

inspect:
	@$(NODE) scripts/inspect.ts --scenario S7

secret-scan:
	@echo "== secret scan =="
	@$(PY) scripts/secret-scan.py

clean:
	rm -rf results/*.json results/*.md results/*.mmd results/*.svg
