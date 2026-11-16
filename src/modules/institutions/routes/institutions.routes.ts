/**
 * Rutas de instituciones. Montadas en `${API_PREFIX}/institutions`.
 *
 *   GET    /        Listado (?search, type, sortBy=nombre-asc|nombre-desc)
 *   GET    /:id     Detalle con proyectos agrupados por estado
 *   POST   /        Crear
 *   PUT    /:id     Actualizar (parcial; mismo contrato que usa el frontend)
 *   PATCH  /:id     Alias de PUT
 *   DELETE /:id     Eliminar (409 si tiene proyectos)
 */
import express from 'express';
import { institutionsController } from '../controllers/institutions.controller.js';

export const institutionsRouter = express.Router();

institutionsRouter.get('/', institutionsController.list);
institutionsRouter.get('/:id', institutionsController.getById);
institutionsRouter.post('/', institutionsController.create);
institutionsRouter.put('/:id', institutionsController.update);
institutionsRouter.patch('/:id', institutionsController.update);
institutionsRouter.delete('/:id', institutionsController.remove);
