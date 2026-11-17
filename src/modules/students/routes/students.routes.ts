/**
 * Rutas del módulo students. Montadas en `${API_PREFIX}/students`.
 *
 *   GET    /                 Lista paginada (?page, pageSize, q, careerId, activo)
 *   GET    /:id              Detalle
 *   GET    /:id/hours        Saldo de horas sociales (vista v_student_hours)
 *   POST   /                 Crear
 *   PATCH  /:id              Actualizar parcialmente
 *   DELETE /:id              Eliminar (409 si tiene historial)
 *
 * Perfil detallado (requieren sesión; las rutas anteriores siguen públicas por ahora):
 *   GET    /by-carnet/:carnet     Resuelve carnet → id
 *   GET    /:id/profile           Datos, progreso hacia 600 h y participaciones
 *   GET    /:id/hour-movements    Movimientos de horas (importados y manuales)
 *   POST   /:id/hour-movements    Asignación manual (ADMIN | COORDINADOR). Cabecera Idempotency-Key opcional.
 *   DELETE /:id/hour-movements/:movementId   Revoca un movimiento MANUAL (ADMIN | COORDINADOR); 403 si es importado.
 */
import express from 'express';
import { requireAuth, requireRole } from '../../../core/server/middlewares/require-auth.js';
import { studentsController } from '../controllers/students.controller.js';

export const studentsRouter = express.Router();

// Antes de `/:id` para que "by-carnet" no se interprete como id.
studentsRouter.get('/by-carnet/:carnet', requireAuth, studentsController.getByCarnet);
studentsRouter.get('/:id/profile', requireAuth, studentsController.getProfile);
studentsRouter.get('/:id/hour-movements', requireAuth, studentsController.listHourMovements);
studentsRouter.post(
  '/:id/hour-movements',
  requireAuth,
  requireRole('ADMIN', 'COORDINADOR'),
  studentsController.addManualHours,
);
studentsRouter.delete(
  '/:id/hour-movements/:movementId',
  requireAuth,
  requireRole('ADMIN', 'COORDINADOR'),
  studentsController.deleteManualHours,
);

studentsRouter.get('/', studentsController.list);
studentsRouter.get('/:id', studentsController.getById);
studentsRouter.get('/:id/hours', studentsController.getHours);
studentsRouter.post('/', studentsController.create);
studentsRouter.patch('/:id', studentsController.update);
studentsRouter.delete('/:id', studentsController.remove);
