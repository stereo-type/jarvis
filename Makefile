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
