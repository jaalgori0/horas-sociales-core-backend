/**
 * Rutas de proyectos. Montadas en `${API_PREFIX}/projects`.
 *
 *   GET    /                                  Listado (?search, status, location, faculty, institutionId)
 *   GET    /map                               Proyectos para el mapa (conteo por género)
 *   GET    /:id                               Detalle con estudiantes, horas acumuladas y movimientos
 *   POST   /                                  Crear (crea/actualiza la institución si viene por nombre)
 *   PUT    /:id                               Actualizar (parcial)
 *   DELETE /:id                               Eliminar (409 si hay horas registradas)
 *   GET    /:id/enrollments                   Estudiantes inscritos
 *   POST   /:id/enrollments                   Inscribir (crea el estudiante si el carnet no existe)
 *   PUT    /:id/enrollments/:enrollmentId     Editar estudiante inscrito / estado de la inscripción
 *   DELETE /:id/enrollments/:enrollmentId     Retirar (409 si tiene horas registradas)
 */
import express from 'express';
import { projectsController } from '../controllers/projects.controller.js';

export const projectsRouter = express.Router();

projectsRouter.get('/', projectsController.list);
projectsRouter.get('/map', projectsController.listForMap);
projectsRouter.get('/:id', projectsController.getById);
projectsRouter.post('/', projectsController.create);
projectsRouter.put('/:id', projectsController.update);
projectsRouter.patch('/:id', projectsController.update);
projectsRouter.delete('/:id', projectsController.remove);

projectsRouter.get('/:id/enrollments', projectsController.listEnrollments);
projectsRouter.post('/:id/enrollments', projectsController.enroll);
projectsRouter.put('/:id/enrollments/:enrollmentId', projectsController.updateEnrollment);
projectsRouter.patch('/:id/enrollments/:enrollmentId', projectsController.updateEnrollment);
projectsRouter.delete('/:id/enrollments/:enrollmentId', projectsController.removeEnrollment);
