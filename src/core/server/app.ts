/**
 * Fábrica de la aplicación Express. No abre puertos ni conecta a la BD:
 * eso lo hace `src/main.ts`. Así la app puede instanciarse en pruebas.
 */
import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from '../config/env.js';
import { apiRouter } from './routes.js';
import { requestLogger } from './middlewares/request-logger.js';
import { notFoundHandler } from './middlewares/not-found.js';
import { errorHandler } from './middlewares/error-handler.js';
import { registerSpanishZodMessages } from '../validation/zod-es.js';

export function createApp(): Express {
  registerSpanishZodMessages();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins.includes('*') ? true : env.corsOrigins,
      credentials: true,
      // Descargas (plantilla de revisión): el frontend lee el nombre del archivo y el resumen.
      exposedHeaders: ['Content-Disposition', 'X-Plantilla-Filas', 'X-Plantilla-Filas-Con-Advertencias', 'X-Plantilla-Lineas-No-Reconocidas'],
    }),
  );
  // Las imágenes de proyectos/instituciones llegan como data URL base64 en el JSON.
  app.use(express.json({ limit: env.JSON_BODY_LIMIT }));
  app.use(requestLogger);

  app.use(env.API_PREFIX, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
