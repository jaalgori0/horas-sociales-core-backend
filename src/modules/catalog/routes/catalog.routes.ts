/**
 * Rutas del catálogo académico (solo lectura).
 *
 *   GET /faculties[?incluirInactivas=true]          Facultades
 *   GET /faculties/:id                              Facultad con sus carreras
 *   GET /careers[?facultyId=<uuid>|faculty_id=…]    Carreras (filtro opcional por facultad)
 *   GET /careers/:id                                Carrera
 */
import express from 'express';
import { catalogController } from '../controllers/catalog.controller.js';

export const facultiesRouter = express.Router();
facultiesRouter.get('/', catalogController.listFaculties);
facultiesRouter.get('/:id', catalogController.getFaculty);

export const careersRouter = express.Router();
careersRouter.get('/', catalogController.listCareers);
careersRouter.get('/:id', catalogController.getCareer);
