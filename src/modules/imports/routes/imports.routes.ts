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
 * Revisión en línea (migración 013), sin editar Excel. Todas reciben { huella, justificacion }
 * y devuelven el lote reclasificado (409 REVISION_DESACTUALIZADA si otra persona lo cambió):
 *   PATCH  /:id/filas/:rowId            corrige estado/horas/fechas ({ cambios })
 *   POST   /:id/filas/:rowId/excluir    excluye la fila del lote
 *   POST   /:id/filas/:rowId/restaurar  devuelve la fila al lote
 *   POST   /:id/decisiones              { clave, decision: ACEPTAR_REPORTE | CONSERVAR_BD }
 *   POST   /:id/proyectos/vincular      { clave, decision: VINCULAR (+ projectId) | CREAR_NUEVO }
 *   POST   /:id/renovar                 24 h más de vigencia
 *   GET    /:id/revision                bitácora (original, anterior, nuevo, quién, cuándo)
 *
 * Todas exigen sesión (Authorization: Bearer <token> de POST /auth/login). Subir, generar
 * la plantilla y confirmar comparten IMPORT_RATE_LIMIT_PER_MIN por minuto y usuario; la
 * revisión (muchas acciones pequeñas) tiene su propio cupo, IMPORT_REVIEW_RATE_LIMIT_PER_MIN.
 */
import express from 'express';
import { env } from '../../../core/config/env.js';
import { rateLimit } from '../../../core/server/middlewares/rate-limit.js';
import { requireAuth } from '../../../core/server/middlewares/require-auth.js';
import { importUpload } from '../../../core/server/middlewares/upload.js';
import { importsController } from '../controllers/imports.controller.js';

export const importsRouter = express.Router();

const importLimit = rateLimit({ limit: env.IMPORT_RATE_LIMIT_PER_MIN, windowMs: 60_000 });
const reviewLimit = rateLimit({ limit: env.IMPORT_REVIEW_RATE_LIMIT_PER_MIN, windowMs: 60_000 });

importsRouter.use(requireAuth);

importsRouter.post('/', importLimit, ...importUpload, importsController.create);
importsRouter.post('/review-template', importLimit, ...importUpload, importsController.reviewTemplate);
importsRouter.get('/', importLimit, importsController.list);
importsRouter.get('/:id', importLimit, importsController.getById);
importsRouter.post('/:id/confirm', importLimit, importsController.confirm);
importsRouter.delete('/:id', importLimit, importsController.discard);

importsRouter.patch('/:id/filas/:rowId', reviewLimit, importsController.editRow);
importsRouter.post('/:id/filas/:rowId/excluir', reviewLimit, importsController.excludeRow);
importsRouter.post('/:id/filas/:rowId/restaurar', reviewLimit, importsController.restoreRow);
importsRouter.post('/:id/decisiones', reviewLimit, importsController.decide);
importsRouter.post('/:id/proyectos/vincular', reviewLimit, importsController.linkProject);
importsRouter.post('/:id/renovar', reviewLimit, importsController.renew);
importsRouter.get('/:id/revision', reviewLimit, importsController.reviewLog);
