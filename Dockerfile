FROM node:20-alpine AS node-toolchain

FROM oven/bun:1.3.14-alpine AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
ENV BUN_CONFIG_MAX_HTTP_REQUESTS=16

COPY package.json bun.lock ./
RUN --mount=type=cache,id=localfi-bun-cache-v1,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

COPY --from=node-toolchain /usr/local/bin/node /usr/local/bin/node
COPY . .

RUN --mount=type=cache,id=localfi-next-cache,target=/app/.next/cache bun run build

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/drizzle/migrations ./drizzle/migrations
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js
COPY --from=builder /app/node_modules/libsodium-sumo ./node_modules/libsodium-sumo
COPY --from=builder /app/node_modules/libsodium-wrappers-sumo ./node_modules/libsodium-wrappers-sumo

RUN chmod -R a+rwX /app/.next
RUN install -d -o nextjs -g nodejs -m 0700 /app/data

USER nextjs

EXPOSE 1313

ENV PORT=1313
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
