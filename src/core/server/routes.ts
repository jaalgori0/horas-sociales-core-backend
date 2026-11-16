/**
 * Registro central de rutas. Cada módulo expone un Router y se monta aquí.
 * Para agregar un módulo nuevo: importe su router y añada `apiRouter.use(...)`.
 */
import express from 'express';
import { sequelize } from '../config/database.js';
import { studentsRouter } from '../../modules/students/index.js';
import { careersRouter, facultiesRouter } from '../../modules/catalog/index.js';
import { institutionsRouter } from '../../modules/institutions/index.js';
import { projectsRouter } from '../../modules/projects/index.js';
import { dashboardController, dashboardRouter } from '../../modules/dashboard/index.js';
import { authRouter } from '../../modules/auth/index.js';

export const apiRouter = express.Router();

apiRouter.get('/health', async (_req, res) => {
  try {
    await sequelize.query('SELECT 1');
    res.json({ status: 'ok', database: 'up', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', database: 'down', timestamp: new Date().toISOString() });
  }
});

// Va ANTES del router de students para que `/:id` no capture "genero-municipio".
apiRouter.get('/students/genero-municipio', dashboardController.generoPorDepartamento);
apiRouter.use('/students', studentsRouter);
apiRouter.use('/faculties', facultiesRouter);
apiRouter.use('/careers', careersRouter);
apiRouter.use('/institutions', institutionsRouter);
apiRouter.use('/projects', projectsRouter);
apiRouter.use('/dashboard', dashboardRouter);
apiRouter.use('/auth', authRouter);
// apiRouter.use('/citas', citasRouter);
