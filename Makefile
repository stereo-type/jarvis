NODE_IMAGE := node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920
DEV_IMAGE := jarvis-config-dev:local
CONNECTION ?= examples/services/filmobot.connection.json
WORKFLOW ?= examples/workflows/cinema-search.json

.PHONY: lock dev-image test validate
lock:
	docker run --rm --user "$$(id -u):$$(id -g)" -e HOME=/tmp -v "$(CURDIR):/app" -w /app $(NODE_IMAGE) npm install --ignore-scripts --package-lock-only --no-audit --no-fund

dev-image:
	docker build --build-arg NODE_IMAGE=$(NODE_IMAGE) -f Dockerfile.dev -t $(DEV_IMAGE) .

test: dev-image
	docker run --rm --network none $(DEV_IMAGE) npm run check
	docker run --rm --network none $(DEV_IMAGE) npm test

validate: dev-image
	docker run --rm --network none -v "$(CURDIR):/project:ro" -w /project $(DEV_IMAGE) node /app/src/validate.ts "$(CONNECTION)" "$(WORKFLOW)"

.PHONY: test-runner
test-runner: dev-image
	@set -eu; project="jarvis-runner-$$$$"; \
	trap 'docker compose -p "$$project" -f tests/runner/compose.yaml down' EXIT; \
	docker compose -p "$$project" -f tests/runner/compose.yaml up --build --abort-on-container-exit --exit-code-from tests tests

.PHONY: test-miniapp
test-miniapp: dev-image
	@set -eu; project="jarvis-miniapp-$$$$"; \
	trap 'docker compose -p "$$project" -f tests/runner/compose.yaml -f tests/miniapp/compose.yaml down' EXIT; \
	docker compose -p "$$project" -f tests/runner/compose.yaml -f tests/miniapp/compose.yaml up --build --abort-on-container-exit --exit-code-from tests tests

.PHONY: test-deploy
test-deploy:
	@set -eu; project="jarvis-ubuntu-smoke-$$$$"; \
	export JARVIS_BOT_TOKEN=1000:fixture JARVIS_ALLOWED_USER_IDS=42 JARVIS_ADMIN_USER_IDS='' JARVIS_DB_PASSWORD=fixture JARVIS_PORT=0; \
	export JARVIS_PROXY_NETWORK=fixture-ingress; \
	docker compose --env-file .env.example -p "$$project" -f compose.yaml -f compose.proxy.yaml config --quiet; \
	stack() { docker compose --env-file .env.example -p "$$project" -f compose.yaml -f tests/miniapp/standalone.yaml "$$@"; }; \
	trap 'stack down -v' EXIT; \
	stack up -d --build --wait --wait-timeout 90; \
	stack exec -T app node --input-type=module < tests/miniapp/standalone.mjs

.PHONY: test-editor
test-editor: dev-image
	@set -eu; project="jarvis-editor-$$$$"; \
	export JARVIS_BOT_TOKEN=1000:fixture JARVIS_ALLOWED_USER_IDS=42,43 JARVIS_ADMIN_USER_IDS=42 JARVIS_DB_PASSWORD=fixture JARVIS_PORT=0; \
	stack() { docker compose --env-file .env.example -p "$$project" -f compose.yaml -f tests/miniapp/editor.yaml "$$@"; }; \
	trap 'stack down -v' EXIT; \
	stack up --build --abort-on-container-exit --exit-code-from tests tests

include Makefile.n8n
