# Stage 1: Dependencies
FROM node:20-alpine AS deps
WORKDIR /app

COPY package*.json ./
RUN npm ci

# Stage 2: Builder
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN mkdir -p data
RUN npm run db:setup
RUN npm run build

# Stage 3: Runner
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/data ./data
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
