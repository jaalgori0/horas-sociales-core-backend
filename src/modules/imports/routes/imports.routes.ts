/**
 * Rutas de importación masiva. Montadas en `${API_PREFIX}/imports`.
 *
 *   POST   /              multipart/form-data, campo "files" (PDF/XLS/XLSX) → 201 + vista previa
 *   POST   /review-template  multipart, campo "files" (PDF «Detalle de Horas») → .xlsx para revisar
 *                         y corregir antes de importar (no escribe en la base). La plantilla corregida
 *                         se sube luego por POST / como cualquier otro archivo.
 *   GET    /              historial de lotes (?limit)
 *   GET    /:id           lote + archivos + resumen + ítems (?estado, ?entidad)
 *   POST   /:id/confirm   inserción estricta; 409 PREVIEW_DESACTUALIZADA si el maestro cambió,
 *                         400 DESCUADRE_TOTALES si algún archivo no cuadra con su reporte
 *   DELETE /:id           descarta una vista previa (204)
 *
 * Todas exigen sesión (Authorization: Bearer <token> de POST /auth/login) y comparten
 * un cupo de IMPORT_RATE_LIMIT_PER_MIN peticiones por minuto por usuario.
 */
import express from 'express';
import { env } from '../../../core/config/env.js';
import { rateLimit } from '../../../core/server/middlewares/rate-limit.js';
import { requireAuth } from '../../../core/server/middlewares/require-auth.js';
import { importUpload } from '../../../core/server/middlewares/upload.js';
import { importsController } from '../controllers/imports.controller.js';

export const importsRouter = express.Router();

importsRouter.use(requireAuth, rateLimit({ limit: env.IMPORT_RATE_LIMIT_PER_MIN, windowMs: 60_000 }));

importsRouter.post('/', ...importUpload, importsController.create);
importsRouter.post('/review-template', ...importUpload, importsController.reviewTemplate);
importsRouter.get('/', importsController.list);
importsRouter.get('/:id', importsController.getById);
importsRouter.post('/:id/confirm', importsController.confirm);
importsRouter.delete('/:id', importsController.discard);
