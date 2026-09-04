# One command runs everything that can be verified without a cloud project.
#
#   make verify
#
# Anything that needs Google Cloud is a separate, opt-in target and is reported
# as skipped rather than quietly passed.

NODE ?= node
NPX  ?= npx
PY   ?= python3

.PHONY: help verify test typecheck report schema-check secret-scan tf-check emulator-up emulator-down emulator-test clean

help:
	@echo "verify        run everything that works with no cloud project"
	@echo "test          conformance and negative-control suites"
	@echo "typecheck     strict TypeScript check (needs: npm install)"
	@echo "report        failure-injection matrix -> results/effect-report.{json,md}"
	@echo "schema-check  sanity-check infra/schema.sql"
	@echo "secret-scan   credential and synthetic-PAN scan"
	@echo "tf-check      terraform fmt + validate (skipped if terraform is absent)"
	@echo "emulator-up   start the Spanner emulator and apply infra/schema.sql"
	@echo "emulator-test Spanner schema semantics against the real engine (needs docker)"
	@echo "emulator-down remove the emulator container"
	@echo "clean         remove generated results"

verify: typecheck test report schema-check secret-scan tf-check
	@echo ""
	@echo "verify: PASS"

# Explicit file list, not a glob: the emulator suite must never sneak into
# `verify`, or the result would depend on whether Docker happened to be up.
test:
	@echo "== conformance and negative controls =="
	$(NODE) --test tests/conformance.test.ts tests/negative-control.test.ts

typecheck:
	@echo "== strict type check =="
	@if [ -d node_modules/typescript ]; then \
		$(NPX) tsc --noEmit -p tsconfig.json && echo "typecheck: PASS"; \
	else \
		echo "typecheck: SKIPPED (run 'npm install' to enable)"; \
	fi

report:
	@echo "== failure-injection matrix =="
	$(NODE) scripts/effect-report.ts

schema-check:
	@echo "== schema sanity =="
	@$(PY) scripts/schema-check.py

secret-scan:
	@echo "== secret scan =="
	@$(PY) scripts/secret-scan.py

tf-check:
	@echo "== terraform =="
	@if command -v terraform >/dev/null 2>&1; then \
		terraform -chdir=infra fmt -check && \
		terraform -chdir=infra init -backend=false -input=false >/dev/null && \
		terraform -chdir=infra validate; \
	else \
		echo "terraform: SKIPPED (terraform not installed)"; \
	fi

emulator-up:
	@docker ps --format '{{.Names}}' | grep -qx spanner-emulator || \
		docker run -d --name spanner-emulator -p 9010:9010 -p 9020:9020 \
			gcr.io/cloud-spanner-emulator/emulator:latest >/dev/null
	@sleep 3
	@$(NODE) scripts/spanner-setup.ts

emulator-down:
	@docker rm -f spanner-emulator >/dev/null 2>&1 || true
	@echo "emulator removed"

emulator-test:
	@echo "== Spanner emulator schema semantics =="
	@if docker info >/dev/null 2>&1; then \
		$(MAKE) emulator-up && $(NODE) --test tests/spanner-emulator.test.ts; \
	else \
		echo "emulator-test: SKIPPED (docker is not running)"; \
		echo "  These tests check schema behaviour against the real engine."; \
		echo "  The conformance suite in 'make test' does not need them."; \
	fi

clean:
	rm -rf results/*.json results/*.md
