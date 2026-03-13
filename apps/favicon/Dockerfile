FROM node:22-bookworm-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN cd apps/favicon && pnpm exec tsdown

FROM oven/bun:1-slim

WORKDIR /app
COPY --from=builder /app/apps/favicon/dist ./dist

ENV NODE_ENV=production
EXPOSE 3010

CMD ["bun", "run", "dist/index.mjs"]
