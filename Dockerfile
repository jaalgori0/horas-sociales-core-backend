# syntax=docker/dockerfile:1
# =============================================================================
# horas-sociales-core-backend — imagen de producción
#
#   build:   TypeScript → dist/ con todas las dependencias.
#   runtime: solo dependencias de producción + dist/ + los .sql que el código lee
#            en tiempo de ejecución (rutas relativas a /app):
#              src/database/migrations/   → runner de migraciones
#              src/modules/imports/sql/   → clasificación/aplicación de /imports
#
# Al arrancar, docker-entrypoint.sh aplica las migraciones pendientes y luego
# levanta la API (equivalentes compilados de `pnpm db:migrate` y `pnpm start`).
# =============================================================================

FROM node:20-alpine AS base
WORKDIR /app
# pnpm fijado por "packageManager" en package.json.
RUN corepack enable

# ── Dependencias completas (para compilar) ───────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ── Compilación ──────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ── Solo dependencias de producción ──────────────────────────────────────────
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    TZ=America/El_Salvador \
    PORT=3000
RUN apk add --no-cache tzdata
WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node src/database/migrations ./src/database/migrations
COPY --chown=node:node src/modules/imports/sql ./src/modules/imports/sql
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER node
EXPOSE 3000

# start-period amplio: la primera vez se aplican todas las migraciones.
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+(process.env.API_PREFIX||'/api/v1')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
