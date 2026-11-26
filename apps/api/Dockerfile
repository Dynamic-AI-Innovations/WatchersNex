# Build context: repository root (the pnpm workspace).
# docker build -f apps/api/Dockerfile .

FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @watchersnex/api
COPY apps/api apps/api
RUN pnpm --filter @watchersnex/api build \
 && pnpm --filter @watchersnex/api deploy --prod /out

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Production dependencies plus the package's "files" (dist, migrations) only.
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
