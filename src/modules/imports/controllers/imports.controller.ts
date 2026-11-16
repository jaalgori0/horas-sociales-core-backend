/** Capa HTTP de la importación masiva. El actor de auditoría sale del token (req.user). */
import type { Request, Response } from 'express';
import { actorOf } from '../../../core/server/middlewares/require-auth.js';
import { importsService } from '../services/imports.service.js';
import { importIdParamsSchema, importItemsQuerySchema, listImportsQuerySchema } from '../schemas/import.schemas.js';

export const importsController = {
  /** POST / — sube archivos y devuelve la vista previa clasificada (no escribe en el maestro). */
  async create(req: Request, res: Response): Promise<void> {
    const uploads = Array.isArray(req.files) ? req.files : [];
    const batch = await importsService.createPreview(uploads, actorOf(req.user));
    res.status(201).location(`${req.baseUrl}/${batch.id}`).json(batch);
  },

  async list(req: Request, res: Response): Promise<void> {
    const { limit } = listImportsQuerySchema.parse(req.query);
    res.json(await importsService.list(limit));
  },

  async getById(req: Request, res: Response): Promise<void> {
    const { id } = importIdParamsSchema.parse(req.params);
    res.json(await importsService.getBatch(id, importItemsQuerySchema.parse(req.query)));
  },

  /** POST /:id/confirm — inserción estricta. 409 si la vista previa quedó desactualizada. */
  async confirm(req: Request, res: Response): Promise<void> {
    const { id } = importIdParamsSchema.parse(req.params);
    res.json(await importsService.confirm(id, actorOf(req.user)));
  },

  async discard(req: Request, res: Response): Promise<void> {
    const { id } = importIdParamsSchema.parse(req.params);
    await importsService.discard(id, actorOf(req.user));
    res.status(204).end();
  },
};
