# syntax=docker/dockerfile:1.4
# Cohub API Dockerfile

FROM node:24-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

FROM base AS builder
COPY .npmrc pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/identity/package.json ./packages/identity/package.json
COPY packages/identity/tsconfig.json ./packages/identity/tsconfig.json
COPY packages/identity/tsconfig.build.json ./packages/identity/tsconfig.build.json
COPY packages/billing/package.json ./packages/billing/package.json
COPY packages/billing/tsconfig.json ./packages/billing/tsconfig.json
COPY packages/billing/tsconfig.build.json ./packages/billing/tsconfig.build.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/core/tsconfig.json ./packages/core/tsconfig.json
COPY packages/core/tsconfig.build.json ./packages/core/tsconfig.build.json
COPY packages/sandbox-controller/package.json ./packages/sandbox-controller/package.json
COPY packages/sandbox-controller/tsconfig.json ./packages/sandbox-controller/tsconfig.json
COPY packages/sandbox-controller/tsconfig.build.json ./packages/sandbox-controller/tsconfig.build.json
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/protocol/tsconfig.json ./packages/protocol/tsconfig.json
COPY packages/protocol/tsconfig.build.json ./packages/protocol/tsconfig.build.json
COPY packages/infra/package.json ./packages/infra/package.json
COPY packages/infra/tsconfig.json ./packages/infra/tsconfig.json
COPY packages/infra/tsconfig.build.json ./packages/infra/tsconfig.build.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/db/tsconfig.json ./packages/db/tsconfig.json
COPY packages/db/tsconfig.build.json ./packages/db/tsconfig.build.json
COPY packages/space-fs/package.json ./packages/space-fs/package.json
COPY packages/space-fs/tsconfig.json ./packages/space-fs/tsconfig.json
COPY packages/space-fs/tsconfig.build.json ./packages/space-fs/tsconfig.build.json
COPY apps/api/package.json ./apps/api/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  --mount=type=secret,id=gitea_npm_token \
  GITEA_NPM_TOKEN="$(cat /run/secrets/gitea_npm_token 2>/dev/null || true)" && \
  export GITEA_NPM_TOKEN && \
  if [ -z "$GITEA_NPM_TOKEN" ]; then \
    echo "Missing required build secret: gitea_npm_token"; \
    exit 1; \
  fi && \
  if [ -n "$GITEA_NPM_TOKEN" ]; then \
    printf '\n//git.talesofai.com/api/packages/talesofai/npm/:_authToken=%s\n' "$GITEA_NPM_TOKEN" >> /root/.npmrc; \
  fi && \
  pnpm config set store-dir /pnpm/store && \
  pnpm install --frozen-lockfile --ignore-scripts --filter @cohub/api... && \
  if [ -n "$GITEA_NPM_TOKEN" ]; then \
    sed -i '/git.talesofai.com\/api\/packages\/talesofai\/npm\/:_authToken=/d' /root/.npmrc; \
  fi

COPY packages/identity ./packages/identity
COPY packages/billing ./packages/billing
COPY packages/core ./packages/core
COPY packages/sandbox-controller ./packages/sandbox-controller
COPY packages/protocol ./packages/protocol
COPY packages/infra ./packages/infra
COPY packages/db ./packages/db
COPY packages/space-fs ./packages/space-fs
COPY apps/api/src ./apps/api/src
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json ./apps/api/
COPY apps/api/drizzle ./apps/api/drizzle

RUN pnpm --filter @cohub/api... build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  --mount=type=secret,id=gitea_npm_token \
  GITEA_NPM_TOKEN="$(cat /run/secrets/gitea_npm_token 2>/dev/null || true)" && \
  export GITEA_NPM_TOKEN && \
  if [ -z "$GITEA_NPM_TOKEN" ]; then \
    echo "Missing required build secret: gitea_npm_token"; \
    exit 1; \
  fi && \
  printf '\n//git.talesofai.com/api/packages/talesofai/npm/:_authToken=%s\n' "$GITEA_NPM_TOKEN" >> /root/.npmrc && \
  pnpm --filter @cohub/api --prod deploy /prod/api && \
  sed -i '/git.talesofai.com\/api\/packages\/talesofai\/npm\/:_authToken=/d' /root/.npmrc

FROM node:24-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8787

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && \
  rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /prod/api ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8787/healthz', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "--import", "./dist/register-otel-esm-hook.js", "dist/index.js"]
