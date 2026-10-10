# One command runs everything. No cloud project, no credentials, no network.
#
#   make verify

NODE ?= node
NPX  ?= npx
PY   ?= python3

TESTS = tests/identity.test.ts tests/capture.test.ts tests/broker.test.ts \
        tests/delivery.test.ts tests/schema.test.ts tests/replay.test.ts \
        tests/lineage.test.ts

.PHONY: help verify test typecheck report lineage replay secret-scan clean

help:
	@echo "verify        run everything (no cloud project, no credentials, no network)"
	@echo "test          identity, capture, broker, delivery, schema, replay, lineage"
	@echo "typecheck     strict TypeScript check (needs: npm install)"
	@echo "report        run every scenario -> results/"
	@echo "lineage       verify the standard run and every negative control"
	@echo "replay        bounded replay CLI (see: node scripts/replay.ts --help)"
	@echo "secret-scan   credential scan"
	@echo "clean         remove generated results"

verify: typecheck test report lineage secret-scan
	@echo ""
	@echo "verify: PASS"

test:
	@echo "== identity, capture, broker, delivery, schema, replay, lineage =="
	$(NODE) --test $(TESTS)

typecheck:
	@echo "== strict type check =="
	@if [ -d node_modules/typescript ]; then \
		$(NPX) tsc --noEmit -p tsconfig.json && echo "typecheck: PASS"; \
	else \
		echo "typecheck: SKIPPED (run 'npm install' to enable)"; \
	fi

report:
	@echo "== every scenario =="
	@$(NODE) scripts/report.ts

lineage:
	@echo "== lineage gate =="
	@$(NODE) scripts/lineage.ts --controls

replay:
	@$(NODE) scripts/replay.ts --aggregate ord-b

secret-scan:
	@echo "== secret scan =="
	@$(PY) scripts/secret-scan.py

clean:
	rm -rf results/*.json results/*.md results/*.txt
