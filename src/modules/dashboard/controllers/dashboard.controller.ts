/** Capa HTTP del dashboard. JSON plano, como lo consume el frontend. */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { dashboardService } from '../services/dashboard.service.js';

const tablaQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const dashboardController = {
  async summary(_req: Request, res: Response): Promise<void> {
    res.json(await dashboardService.summary());
  },
  async mapMarkers(_req: Request, res: Response): Promise<void> {
    res.json(await dashboardService.mapMarkers());
  },
  async carreraAnio(_req: Request, res: Response): Promise<void> {
    res.json(await dashboardService.carreraAnio());
  },
  async genero(_req: Request, res: Response): Promise<void> {
    res.json(await dashboardService.genero());
  },
  async tendenciaAnual(_req: Request, res: Response): Promise<void> {
    res.json(await dashboardService.tendenciaAnual());
  },
  async estudiantesMunicipio(_req: Request, res: Response): Promise<void> {
    res.json(await dashboardService.estudiantesPorMunicipio());
  },
  async proyectosMunicipio(_req: Request, res: Response): Promise<void> {
    res.json(await dashboardService.proyectosPorMunicipio());
  },
  async tablaInstitucion(req: Request, res: Response): Promise<void> {
    const { limit } = tablaQuerySchema.parse(req.query);
    res.json(await dashboardService.tablaInstitucion(limit));
  },
  async generoPorDepartamento(_req: Request, res: Response): Promise<void> {
    res.json(await dashboardService.generoPorDepartamento());
  },
};
