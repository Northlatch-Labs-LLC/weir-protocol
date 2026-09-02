# The hosted, keyless weir-mcp — public, read-only, no secrets anywhere in this image.
#
# Same construction as packages/daemon/Dockerfile —
# multi-stage, corepack-pinned pnpm, manifests before sources, never root — with one deliberate
# difference: this image must never receive a key. `WEIR_AGENT_KEY` set under `--http` makes the
# server exit 78 before it listens (packages/mcp/src/transport.ts resolveOptions), and nothing here
# declares, copies or mounts one. Every variable this image reads is public: the six chain ids,
# the coin type, the base URL, and the server's own host/port/allow-lists.
#
# Build context is the REPOSITORY ROOT (the workspace), e.g. from the root:
#   docker build -f packages/mcp/Dockerfile -t weir-mcp .
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
# Manifests first, so the dependency layer is cached until a dependency actually changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/sdk/package.json    packages/sdk/
COPY packages/agent/package.json  packages/agent/
COPY packages/policy/package.json packages/policy/
COPY packages/signer/package.json packages/signer/
COPY packages/mcp/package.json    packages/mcp/
# `--ignore-scripts`: the SDK's `prepare` compiles it and there is no source at this layer; the one
# build we need runs explicitly below. `--filter .` includes the workspace root, whose
# devDependencies carry `tsx`, which the canary and transport checks still use; the server itself
# now runs from its compiled dist like every library it depends on.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @projectx-social/mcp... --filter .
# Both fingerprint scripts: the writer imports `./sdk-src-fingerprint.mjs`, and the first Cloud Build
# of this image (2026-09-02, build 82ca11ed) failed at the SDK build step with ERR_MODULE_NOT_FOUND
# because only the writer had been copied. A COPY line is a claim about a module graph; this one
# now carries the whole graph the SDK build needs.
COPY scripts/write-sdk-fingerprint.mjs scripts/sdk-src-fingerprint.mjs scripts/
COPY packages/sdk    packages/sdk
COPY packages/agent  packages/agent
COPY packages/policy packages/policy
COPY packages/signer packages/signer
COPY packages/mcp    packages/mcp
RUN pnpm --filter @projectx-social/sdk build \
 && pnpm --filter @projectx-social/policy build \
 && pnpm --filter @projectx-social/signer build \
 && pnpm --filter @projectx-social/agent build \
 && pnpm --filter @projectx-social/mcp build

# --- runtime ---
FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable && addgroup -S projectx && adduser -S -G projectx projectx
COPY --from=build --chown=projectx:projectx /app /app
USER projectx
# Cloud Run injects PORT; the server reads WEIR_MCP_HTTP_PORT. Both say 8080 so they cannot
# disagree. 0.0.0.0 is said deliberately — the server's default is loopback, and a container that
# listens on loopback is a container nobody can reach.
ENV NODE_ENV=production \
    PORT=8080 \
    WEIR_MCP_HTTP_HOST=0.0.0.0 \
    WEIR_MCP_HTTP_PORT=8080
EXPOSE 8080
# The Host allowlist (the DNS-rebinding control), the base URL and the eight chain variables are
# supplied by the service definition at deploy time, never baked here — see
# packages/mcp/deploy/cloudrun.service.yaml. No secret is ever an ENV in this file.
ENTRYPOINT ["node", "packages/mcp/dist/index.js", "--http"]
