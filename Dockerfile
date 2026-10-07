FROM node:24.21.0-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY src ./src
COPY scripts/build.mjs ./scripts/build.mjs
RUN pnpm build && pnpm prune --prod --ignore-scripts

FROM node:24.21.0-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 SYNC_INTERVAL_SECONDS=0
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 8787
CMD ["node", "dist/main.mjs"]
