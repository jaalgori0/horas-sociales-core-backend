/**
 * Capa HTTP del catálogo. Responde JSON plano (sin envoltura `{ data }`)
 * porque así lo consume el frontend (services/api.ts → request<T>).
 */
import type { Request, Response } from 'express';
import { catalogService } from '../services/catalog.service.js';
import {
  catalogIdParamsSchema,
  listCareersQuerySchema,
  listFacultiesQuerySchema,
} from '../schemas/catalog.schemas.js';

export const catalogController = {
  async listFaculties(req: Request, res: Response): Promise<void> {
    res.json(await catalogService.listFaculties(listFacultiesQuerySchema.parse(req.query)));
  },

  async getFaculty(req: Request, res: Response): Promise<void> {
    const { id } = catalogIdParamsSchema.parse(req.params);
    res.json(await catalogService.getFaculty(id));
  },

  async listCareers(req: Request, res: Response): Promise<void> {
    res.json(await catalogService.listCareers(listCareersQuerySchema.parse(req.query)));
  },

  async getCareer(req: Request, res: Response): Promise<void> {
    const { id } = catalogIdParamsSchema.parse(req.params);
    res.json(await catalogService.getCareer(id));
  },
};
