/** Capa HTTP de proyectos e inscripciones. JSON plano, como lo consume el frontend. */
import type { Request, Response } from 'express';
import { projectsService } from '../services/projects.service.js';
import { enrollmentsService } from '../services/enrollments.service.js';
import {
  createProjectSchema,
  enrollmentParamsSchema,
  enrollStudentSchema,
  listProjectsQuerySchema,
  projectIdParamsSchema,
  updateEnrollmentSchema,
  updateProjectSchema,
} from '../schemas/project.schemas.js';

export const projectsController = {
  async list(req: Request, res: Response): Promise<void> {
    res.json(await projectsService.list(listProjectsQuerySchema.parse(req.query)));
  },

  async listForMap(_req: Request, res: Response): Promise<void> {
    res.json(await projectsService.listForMap());
  },

  async getById(req: Request, res: Response): Promise<void> {
    const { id } = projectIdParamsSchema.parse(req.params);
    res.json(await projectsService.getById(id));
  },

  async create(req: Request, res: Response): Promise<void> {
    const project = await projectsService.create(createProjectSchema.parse(req.body));
    res.status(201).location(`${req.baseUrl}/${project.id}`).json(project);
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = projectIdParamsSchema.parse(req.params);
    res.json(await projectsService.update(id, updateProjectSchema.parse(req.body)));
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = projectIdParamsSchema.parse(req.params);
    res.json(await projectsService.remove(id));
  },

  // ── Inscripciones ──
  async listEnrollments(req: Request, res: Response): Promise<void> {
    const { id } = projectIdParamsSchema.parse(req.params);
    res.json(await enrollmentsService.list(id));
  },

  /** 201 con { project, student } (InscribirEstudianteModal usa `resp.project`). */
  async enroll(req: Request, res: Response): Promise<void> {
    const { id } = projectIdParamsSchema.parse(req.params);
    const { enrollmentId } = await enrollmentsService.enroll(id, enrollStudentSchema.parse(req.body));
    const project = await projectsService.getById(id);
    const student = project.estudiantes.find((s) => s.id === enrollmentId) ?? null;
    res.status(201).json({ project, student });
  },

  async updateEnrollment(req: Request, res: Response): Promise<void> {
    const { id, enrollmentId } = enrollmentParamsSchema.parse(req.params);
    res.json(await enrollmentsService.update(id, enrollmentId, updateEnrollmentSchema.parse(req.body)));
  },

  async removeEnrollment(req: Request, res: Response): Promise<void> {
    const { id, enrollmentId } = enrollmentParamsSchema.parse(req.params);
    await enrollmentsService.remove(id, enrollmentId);
    res.status(204).end();
  },
};
