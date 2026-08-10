# syntax=docker/dockerfile:1

# Supply the real Node binary used by package scripts and Next's build process.
FROM node:20-alpine AS node-toolchain

# Install and build in one cached stage. Keeping node_modules in this stage
# avoids a slow cross-stage copy while bun.lock still makes installs frozen.
FROM oven/bun:1.3.14-alpine AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
# Keep registry downloads conservative; highly parallel fetches are unreliable
# on some residential/VPN connections and can corrupt retried tarballs.
ENV BUN_CONFIG_MAX_HTTP_REQUESTS=16

COPY package.json bun.lock ./
RUN --mount=type=cache,id=localfi-bun-cache-v1,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

COPY --from=node-toolchain /usr/local/bin/node /usr/local/bin/node
COPY . .

RUN mkdir -p data
RUN bun run db:setup
RUN --mount=type=cache,id=localfi-next-cache,target=/app/.next/cache bun run build

# The standalone Next output remains on the production Node runtime.
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/data ./data
COPY --from=builder --chown=nextjs:nodejs /app/drizzle/migrations ./drizzle/migrations
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js

# Compose runs the app as the host UID so bind-mounted ledger files stay owned
# by the host user. That UID may differ from `nextjs` (1001), while Next still
# writes ISR/prerender entries under .next at runtime.
RUN chmod -R a+rwX /app/.next

USER nextjs

EXPOSE 1313

ENV PORT=1313
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
