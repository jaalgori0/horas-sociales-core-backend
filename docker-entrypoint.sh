#!/bin/sh
# Arranque del contenedor del backend:
#   1. Aplica las migraciones pendientes (equivalente compilado de `pnpm db:migrate`).
#      Si alguna falla, el contenedor se detiene y NO levanta la API.
#   2. Levanta la API (equivalente de `pnpm start`). `exec` deja a Node como PID 1
#      para que reciba SIGTERM y haga el apagado ordenado.
set -e

echo "[entrypoint] Aplicando migraciones..."
node dist/database/migrate.js up

echo "[entrypoint] Iniciando API..."
exec node --enable-source-maps dist/main.js
