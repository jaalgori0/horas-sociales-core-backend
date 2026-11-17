/**
 * Capa HTTP: valida entrada (params/query/body), delega en el servicio y
 * formatea la respuesta. Sin lógica de negocio ni acceso directo a la BD.
 *
 * Express 5 propaga automáticamente los errores de funciones async al
 * middleware global de errores: no hace falta try/catch ni next(err).
 */
import type { Request, Response } from 'express';
import { actorOf } from '../../../core/server/middlewares/require-auth.js';
import { studentsService } from '../services/students.service.js';
import { studentProfileService } from '../services/student-profile.service.js';
import {
  createManualHoursSchema,
  createStudentSchema,
  hourMovementParamsSchema,
  idempotencyKeySchema,
  studentCarnetParamsSchema,
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

  // ─── Perfil y horas manuales (rutas con requireAuth) ──────────────────────

  async getByCarnet(req: Request, res: Response): Promise<void> {
    const { carnet } = studentCarnetParamsSchema.parse(req.params);
    res.json({ data: await studentProfileService.findIdByCarnet(carnet) });
  },

  async getProfile(req: Request, res: Response): Promise<void> {
    const { id } = studentIdParamsSchema.parse(req.params);
    res.json({ data: await studentProfileService.getProfile(id) });
  },

  async listHourMovements(req: Request, res: Response): Promise<void> {
    const { id } = studentIdParamsSchema.parse(req.params);
    res.json({ data: await studentProfileService.listMovements(id) });
  },

  async addManualHours(req: Request, res: Response): Promise<void> {
    const { id } = studentIdParamsSchema.parse(req.params);
    const input = createManualHoursSchema.parse(req.body);
    const idempotencyKey = idempotencyKeySchema.parse(req.get('Idempotency-Key') || undefined) ?? null;
    const result = await studentProfileService.addManualHours(id, input, {
      userId: req.user!.id,
      actor: actorOf(req.user),
      idempotencyKey,
    });
    res
      .status(result.replayed ? 200 : 201)
      .json({ data: result.profile, meta: { movementId: result.movementId, replayed: result.replayed } });
  },

  async deleteManualHours(req: Request, res: Response): Promise<void> {
    const { id, movementId } = hourMovementParamsSchema.parse(req.params);
    const result = await studentProfileService.deleteManualMovement(id, movementId, { actor: actorOf(req.user) });
    res.json({ data: result.profile, meta: { movementId, deletedEnrollment: result.deletedEnrollment } });
  },
};
