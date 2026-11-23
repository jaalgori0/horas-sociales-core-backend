/** Capa HTTP del dashboard. JSON plano, como lo consume el frontend. */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { dashboardService } from '../services/dashboard.service.js';

const tablaQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const generoQuerySchema = z.object({
  facultyId: z.string().uuid('facultyId debe ser un UUID').optional(),
});

const completaron600QuerySchema = z.object({
  anio: z.coerce.number().int().min(1900, 'anio inválido').max(2100, 'anio inválido').optional(),
  facultyId: z.string().uuid('facultyId debe ser un UUID').optional(),
});

const anioQuerySchema = z.object({
  anio: z.coerce.number().int().min(1900, 'anio inválido').max(2100, 'anio inválido').optional(),
});

const carreraAnioQuerySchema = z.object({
  metrica: z.enum(['estudiantes', 'participaciones']).default('estudiantes'),
});

export const dashboardController = {
  async summary(req: Request, res: Response): Promise<void> {
    const { anio } = anioQuerySchema.parse(req.query);
    res.json(await dashboardService.summary(anio));
  },
  async conciliacion(req: Request, res: Response): Promise<void> {
    const { anio } = anioQuerySchema.parse(req.query);
    res.json(await dashboardService.conciliacion(anio));
  },
  async mapMarkers(_req: Request, res: Response): Promise<void> {
    res.json(await dashboardService.mapMarkers());
  },
  async carreraAnio(req: Request, res: Response): Promise<void> {
    const { metrica } = carreraAnioQuerySchema.parse(req.query);
    res.json(await dashboardService.carreraAnio(metrica));
  },
  async genero(req: Request, res: Response): Promise<void> {
    const { facultyId } = generoQuerySchema.parse(req.query);
    res.json(await dashboardService.genero(facultyId));
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
  async estudiantesMultiProyecto(_req: Request, res: Response): Promise<void> {
    res.json(await dashboardService.estudiantesMultiProyecto());
  },
  async completaron600(req: Request, res: Response): Promise<void> {
    const { anio, facultyId } = completaron600QuerySchema.parse(req.query);
    res.json(await dashboardService.completaron600(anio, facultyId));
  },
  async generoPorDepartamento(_req: Request, res: Response): Promise<void> {
    res.json(await dashboardService.generoPorDepartamento());
  },
};
