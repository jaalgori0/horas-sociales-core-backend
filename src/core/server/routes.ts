/**
 * Registro central de rutas. Cada módulo expone un Router y se monta aquí.
 * Para agregar un módulo nuevo: importe su router y añada `apiRouter.use(...)`.
 */
import express from 'express';
import { sequelize } from '../config/database.js';
import { studentsRouter } from '../../modules/students/index.js';

export const apiRouter = express.Router();

apiRouter.get('/health', async (_req, res) => {
  try {
    await sequelize.query('SELECT 1');
    res.json({ status: 'ok', database: 'up', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', database: 'down', timestamp: new Date().toISOString() });
  }
});

apiRouter.use('/students', studentsRouter);
// apiRouter.use('/projects', projectsRouter);
// apiRouter.use('/citas', citasRouter);
// apiRouter.use('/auth', authRouter);
