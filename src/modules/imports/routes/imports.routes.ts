/**
 * Rutas de importación masiva. Montadas en `${API_PREFIX}/imports`.
 *
 *   POST   /              multipart/form-data, campo "files" (PDF/XLS/XLSX) → 201 + vista previa
 *   GET    /              historial de lotes (?limit)
 *   GET    /:id           lote + archivos + resumen + ítems (?estado, ?entidad)
 *   POST   /:id/confirm   inserción estricta; 409 PREVIEW_DESACTUALIZADA si el maestro cambió
 *   DELETE /:id           descarta una vista previa (204)
 *
 * TODO(producción): proteger con rol ADMIN/COORDINADOR (hoy abiertas para pruebas punta a punta).
 */
import express from 'express';
import { importUpload } from '../../../core/server/middlewares/upload.js';
import { importsController } from '../controllers/imports.controller.js';

export const importsRouter = express.Router();

importsRouter.post('/', importUpload, importsController.create);
importsRouter.get('/', importsController.list);
importsRouter.get('/:id', importsController.getById);
importsRouter.post('/:id/confirm', importsController.confirm);
importsRouter.delete('/:id', importsController.discard);
