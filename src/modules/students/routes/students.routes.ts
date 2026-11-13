/**
 * Rutas del módulo students. Montadas en `${API_PREFIX}/students`.
 *
 *   GET    /                 Lista paginada (?page, pageSize, q, careerId, activo)
 *   GET    /:id              Detalle
 *   GET    /:id/hours        Saldo de horas sociales (vista v_student_hours)
 *   POST   /                 Crear
 *   PATCH  /:id              Actualizar parcialmente
 *   DELETE /:id              Eliminar (409 si tiene historial)
 */
import express from 'express';
import { studentsController } from '../controllers/students.controller.js';

export const studentsRouter = express.Router();

studentsRouter.get('/', studentsController.list);
studentsRouter.get('/:id', studentsController.getById);
studentsRouter.get('/:id/hours', studentsController.getHours);
studentsRouter.post('/', studentsController.create);
studentsRouter.patch('/:id', studentsController.update);
studentsRouter.delete('/:id', studentsController.remove);
