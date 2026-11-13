/**
 * Capa HTTP: valida entrada (params/query/body), delega en el servicio y
 * formatea la respuesta. Sin lógica de negocio ni acceso directo a la BD.
 *
 * Express 5 propaga automáticamente los errores de funciones async al
 * middleware global de errores: no hace falta try/catch ni next(err).
 */
import type { Request, Response } from 'express';
import { studentsService } from '../services/students.service.js';
import {
  createStudentSchema,
  listStudentsQuerySchema,
  studentIdParamsSchema,
  updateStudentSchema,
} from '../schemas/student.schemas.js';

export const studentsController = {
  async list(req: Request, res: Response): Promise<void> {
    const query = listStudentsQuerySchema.parse(req.query);
    res.json(await studentsService.list(query));
  },

  async getById(req: Request, res: Response): Promise<void> {
    const { id } = studentIdParamsSchema.parse(req.params);
    res.json({ data: await studentsService.getById(id) });
  },

  async getHours(req: Request, res: Response): Promise<void> {
    const { id } = studentIdParamsSchema.parse(req.params);
    res.json({ data: await studentsService.getHours(id) });
  },

  async create(req: Request, res: Response): Promise<void> {
    const input = createStudentSchema.parse(req.body);
    const student = await studentsService.create(input);
    res.status(201).location(`${req.baseUrl}/${student.id}`).json({ data: student });
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = studentIdParamsSchema.parse(req.params);
    const input = updateStudentSchema.parse(req.body);
    res.json({ data: await studentsService.update(id, input) });
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = studentIdParamsSchema.parse(req.params);
    await studentsService.remove(id);
    res.status(204).end();
  },
};
