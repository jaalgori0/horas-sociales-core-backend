/** Capa HTTP del dashboard. JSON plano, como lo consume el frontend. */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { dashboardService } from '../services/dashboard.service.js';

/**
 * Filtro general de año: `?anio=2026` (ese año) o `?anio=todos` (acumulado, → null).
 * Sin el parámetro queda `undefined`: cada endpoint decide su valor por defecto.
 */
const anioFiltroSchema = z
  .string()
  .regex(/^(todos|\d{4})$/, "anio debe ser un año de 4 dígitos o 'todos'")
  .refine((v) => v === 'todos' || (Number(v) >= 1900 && Number(v) <= 2100), 'anio inválido')
  .transform((v) => (v === 'todos' ? null : Number(v)))
  .optional();

const filtroAnioQuerySchema = z.object({ anio: anioFiltroSchema });

const tablaQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  anio: anioFiltroSchema,
});

const generoQuerySchema = z.object({
  facultyId: z.string().uuid('facultyId debe ser un UUID').optional(),
  anio: anioFiltroSchema,
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
  async anios(_req: Request, res: Response): Promise<void> {
    res.json(await dashboardService.anios());
  },
  /** Sin `anio`: el año por defecto (más reciente con participaciones). */
  async summary(req: Request, res: Response): Promise<void> {
    const { anio } = filtroAnioQuerySchema.parse(req.query);
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
    const { facultyId, anio } = generoQuerySchema.parse(req.query);
    res.json(await dashboardService.genero(facultyId, anio ?? null));
  },
  async tendenciaAnual(_req: Request, res: Response): Promise<void> {
    res.json(await dashboardService.tendenciaAnual());
  },
  async estudiantesMunicipio(req: Request, res: Response): Promise<void> {
    const { anio } = filtroAnioQuerySchema.parse(req.query);
    res.json(await dashboardService.estudiantesPorMunicipio(anio ?? null));
  },
  async proyectosMunicipio(req: Request, res: Response): Promise<void> {
    const { anio } = filtroAnioQuerySchema.parse(req.query);
    res.json(await dashboardService.proyectosPorMunicipio(anio ?? null));
  },
  async tablaInstitucion(req: Request, res: Response): Promise<void> {
    const { limit, anio } = tablaQuerySchema.parse(req.query);
    res.json(await dashboardService.tablaInstitucion(limit, anio ?? null));
  },
  async estudiantesMultiProyecto(req: Request, res: Response): Promise<void> {
    const { anio } = filtroAnioQuerySchema.parse(req.query);
    res.json(await dashboardService.estudiantesMultiProyecto(anio ?? null));
  },
  async completaron600(req: Request, res: Response): Promise<void> {
    const { anio, facultyId } = completaron600QuerySchema.parse(req.query);
    res.json(await dashboardService.completaron600(anio, facultyId));
  },
  async generoPorDepartamento(_req: Request, res: Response): Promise<void> {
    res.json(await dashboardService.generoPorDepartamento());
  },
};
