/** Capa HTTP de auth. JSON plano (AuthUser), como lo consume el frontend. */
import type { Request, Response } from 'express';
import { AppError } from '../../../core/errors/app-error.js';
import { authService } from '../services/auth.service.js';
import { loginSchema, registerSchema } from '../schemas/auth.schemas.js';

export const authController = {
  async register(req: Request, res: Response): Promise<void> {
    const user = await authService.register(registerSchema.parse(req.body));
    res.status(201).json(user);
  },

  async login(req: Request, res: Response): Promise<void> {
    try {
      res.json(await authService.login(loginSchema.parse(req.body), req.ip ?? 'desconocido'));
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 429) {
        const seconds = (error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
        if (seconds) res.setHeader('Retry-After', String(seconds));
      }
      throw error;
    }
  },
};
