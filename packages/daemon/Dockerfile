# The harvest daemon.
#
# Multi-stage, because the runtime image has no business carrying a package manager, a lockfile or
# the source of every workspace sibling. Smaller is not the point — a smaller attack surface on a
# container that holds a signing key is.

FROM node:22-alpine AS build
WORKDIR /app

# pnpm from corepack, pinned by the version the repo already declares. Installing "latest" here is
# how a build that worked yesterday resolves different dependencies today.
RUN corepack enable

# Manifests first, so the dependency layer is cached until a dependency actually changes. Copying
# the whole tree first makes every source edit re-resolve the lockfile.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/sdk/package.json      packages/sdk/
COPY packages/policy/package.json   packages/policy/
COPY packages/signer/package.json   packages/signer/
COPY packages/daemon/package.json   packages/daemon/
# `--ignore-scripts` because the SDK has a `prepare` script that compiles it, and at this layer only
# the manifests exist — there is no source to compile yet. Splitting them is also the safer default:
# a container build that runs every dependency's lifecycle scripts is a supply-chain surface, and
# the one script we actually need is run explicitly below.
RUN pnpm install --frozen-lockfile --filter @projectx-social/daemon... --ignore-scripts

# The SDK's build ends by writing its source fingerprint with a script that lives at the workspace
# root. The 2026-09-02 build of this image failed on exactly that line — "Cannot find module
# /app/scripts/write-sdk-fingerprint.mjs" — because only the packages had been copied. Same fix as
# packages/mcp/Dockerfile: the two scripts the build runs, and nothing else from the root.
COPY scripts/write-sdk-fingerprint.mjs scripts/sdk-src-fingerprint.mjs scripts/
COPY packages/sdk    packages/sdk
COPY packages/policy packages/policy
COPY packages/signer packages/signer
COPY packages/daemon packages/daemon
# Compiled, not type-stripped. `node --experimental-strip-types` removes the annotations but does
# not rewrite module specifiers, and this codebase imports `./index.js` — the correct ESM specifier
# for a TypeScript source that compiles to `index.js`. Stripping leaves that pointing at a file that
# does not exist until tsc has run, so the container started and immediately died on
# ERR_MODULE_NOT_FOUND. Compiling is also what should happen in a production image regardless.
RUN pnpm --filter @projectx-social/sdk build \
 && pnpm --filter @projectx-social/policy build \
 && pnpm --filter @projectx-social/signer build \
 && pnpm --filter @projectx-social/daemon build

# --- runtime ---
FROM node:22-alpine AS runtime
WORKDIR /app

# Never root. The daemon holds a key whose only power is spending its own gas, but a container
# escape from root is a different conversation from one out of an unprivileged user.
RUN addgroup -S projectx && adduser -S -G projectx projectx

COPY --from=build --chown=projectx:projectx /app /app

USER projectx

# `--once` is the default command on purpose. A container restart policy is a supervisor, and it is
# better at restarting than the in-process loop is at not dying. Override with an empty argument
# list for the loop if you are watching it in a terminal.
ENTRYPOINT ["node", "packages/daemon/dist/main.js"]
CMD ["--once"]

# No ENV for secrets. They arrive at run time from a file or a secret manager — a key baked into an
# image is in every layer, every registry copy and every `docker history` of it, forever.
