/** Capa HTTP de la importación masiva. El actor de auditoría sale del token (req.user). */
import type { Request, Response } from 'express';
import { actorOf } from '../../../core/server/middlewares/require-auth.js';
import { importsService } from '../services/imports.service.js';
import { importReviewService } from '../services/import-review.service.js';
import {
  confirmBodySchema,
  decisionBodySchema,
  editRowBodySchema,
  importIdParamsSchema,
  importItemsQuerySchema,
  importRowParamsSchema,
  listImportsQuerySchema,
  projectLinkBodySchema,
  rowActionBodySchema,
} from '../schemas/import.schemas.js';

export const importsController = {
  /** POST / — sube archivos y devuelve la vista previa clasificada (no escribe en el maestro). */
  async create(req: Request, res: Response): Promise<void> {
    const uploads = Array.isArray(req.files) ? req.files : [];
    const batch = await importsService.createPreview(uploads, actorOf(req.user));
    res.status(201).location(`${req.baseUrl}/${batch.id}`).json(batch);
  },

  /** POST /review-template — PDF → plantilla .xlsx para revisar antes de importar (no escribe nada). */
  async reviewTemplate(req: Request, res: Response): Promise<void> {
    const uploads = Array.isArray(req.files) ? req.files : [];
    const result = await importsService.buildReviewTemplate(uploads);
    res
      .status(200)
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .attachment(result.filename)
      .set({
        'Cache-Control': 'no-store',
        'X-Plantilla-Filas': String(result.filas),
        'X-Plantilla-Filas-Con-Advertencias': String(result.filasConAdvertencias),
        'X-Plantilla-Lineas-No-Reconocidas': String(result.lineasNoReconocidas),
      })
      .send(result.buffer);
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
    const { huella } = confirmBodySchema.parse(req.body ?? {});
    res.json(await importsService.confirm(id, actorOf(req.user), huella));
  },

  // ── Revisión en línea ────────────────────────────────────────────────────
  /** PATCH /:id/filas/:rowId — corrige estado/horas/fechas de una fila del PDF. */
  async editRow(req: Request, res: Response): Promise<void> {
    const { id, rowId } = importRowParamsSchema.parse(req.params);
    res.json(await importReviewService.editRow(id, rowId, editRowBodySchema.parse(req.body), actorOf(req.user)));
  },
  /** POST /:id/filas/:rowId/excluir */
  async excludeRow(req: Request, res: Response): Promise<void> {
    const { id, rowId } = importRowParamsSchema.parse(req.params);
    res.json(await importReviewService.excludeRow(id, rowId, rowActionBodySchema.parse(req.body), actorOf(req.user)));
  },
  /** POST /:id/filas/:rowId/restaurar */
  async restoreRow(req: Request, res: Response): Promise<void> {
    const { id, rowId } = importRowParamsSchema.parse(req.params);
    res.json(await importReviewService.restoreRow(id, rowId, rowActionBodySchema.parse(req.body), actorOf(req.user)));
  },
  /** POST /:id/decisiones — ACEPTAR_REPORTE / CONSERVAR_BD en una participación. */
  async decide(req: Request, res: Response): Promise<void> {
    const { id } = importIdParamsSchema.parse(req.params);
    res.json(await importReviewService.decide(id, decisionBodySchema.parse(req.body), actorOf(req.user)));
  },
  /** POST /:id/proyectos/vincular — VINCULAR a un proyecto de la app o CREAR_NUEVO. */
  async linkProject(req: Request, res: Response): Promise<void> {
    const { id } = importIdParamsSchema.parse(req.params);
    res.json(await importReviewService.linkProject(id, projectLinkBodySchema.parse(req.body), actorOf(req.user)));
  },
  /** POST /:id/renovar — 24 h más de vigencia (también si ya venció y no se purgó). */
  async renew(req: Request, res: Response): Promise<void> {
    const { id } = importIdParamsSchema.parse(req.params);
    res.json(await importReviewService.renew(id, actorOf(req.user)));
  },
  /** GET /:id/revision — bitácora de la revisión. */
  async reviewLog(req: Request, res: Response): Promise<void> {
    const { id } = importIdParamsSchema.parse(req.params);
    res.json(await importReviewService.log(id));
  },

  async discard(req: Request, res: Response): Promise<void> {
    const { id } = importIdParamsSchema.parse(req.params);
    await importsService.discard(id, actorOf(req.user));
    res.status(204).end();
  },
};
