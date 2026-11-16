/** Capa HTTP de instituciones. JSON plano, como lo consume el frontend. */
import type { Request, Response } from 'express';
import { institutionsService } from '../services/institutions.service.js';
import {
  createInstitutionSchema,
  institutionIdParamsSchema,
  listInstitutionsQuerySchema,
  updateInstitutionSchema,
} from '../schemas/institution.schemas.js';

export const institutionsController = {
  async list(req: Request, res: Response): Promise<void> {
    res.json(await institutionsService.list(listInstitutionsQuerySchema.parse(req.query)));
  },

  async getById(req: Request, res: Response): Promise<void> {
    const { id } = institutionIdParamsSchema.parse(req.params);
    res.json(await institutionsService.getById(id));
  },

  async create(req: Request, res: Response): Promise<void> {
    const institution = await institutionsService.create(createInstitutionSchema.parse(req.body));
    res.status(201).location(`${req.baseUrl}/${institution.id}`).json(institution);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = institutionIdParamsSchema.parse(req.params);
    res.json(await institutionsService.update(id, updateInstitutionSchema.parse(req.body)));
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = institutionIdParamsSchema.parse(req.params);
    await institutionsService.remove(id);
    res.status(204).end();
  },
};
