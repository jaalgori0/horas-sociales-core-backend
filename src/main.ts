/**
 * Punto de entrada: valida configuración, conecta a la BD, levanta HTTP
 * y gestiona el apagado ordenado (SIGINT/SIGTERM).
 */
import { env } from './core/config/env.js';
import { assertDatabaseConnection, closeDatabase } from './core/config/database.js';
import { assertSecurityConfig } from './core/security/crypto.js';
import { assertAuthConfig } from './core/security/token.js';
import { createApp } from './core/server/app.js';
import { logger } from './core/logger.js';
import { ensureDefaultAdmin } from './modules/auth/index.js';
import { startProjectStatusSync } from './modules/projects/index.js';

async function bootstrap(): Promise<void> {
  assertSecurityConfig();
  assertAuthConfig();
  await assertDatabaseConnection();
  // Idempotente: crea el ADMIN por defecto solo si su correo no existe (ver default-admin.ts).
  await ensureDefaultAdmin();
  // Proyectos ACTIVO cuyo cierre ya venció → FINALIZADO (al arrancar y cada hora).
  const stopProjectStatusSync = startProjectStatusSync();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`API escuchando en http://localhost:${env.PORT}${env.API_PREFIX} (${env.NODE_ENV})`);
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopProjectStatusSync();
    logger.info(`${signal} recibido: cerrando servidor...`);

    const forceExit = setTimeout(() => {
      logger.error('Cierre forzado tras 10 s');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close(async (error) => {
      await closeDatabase().catch((dbError: unknown) => logger.error('Error cerrando la BD', dbError));
      process.exit(error ? 1 : 0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((error: unknown) => {
  logger.error('No se pudo iniciar la aplicación', error);
  process.exit(1);
});
