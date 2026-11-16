/**
 * Limitador de peticiones por ventana fija, en memoria (por proceso).
 *
 * Clave = usuario autenticado (req.user) si existe; si no, la IP. Se monta después
 * de requireAuth para que varios usuarios detrás de la misma IP (red del campus)
 * no compartan el cupo. Responde 429 con Retry-After.
 *
 * Suficiente para una sola instancia; con varias réplicas debe moverse a un
 * almacén compartido (p. ej. Redis), igual que login-throttle.
 */
import type { RequestHandler } from 'express';
import { AppError } from '../../errors/app-error.js';

const MAX_KEYS = 10_000;

interface Window {
  count: number;
  startedAt: number;
}

export function rateLimit({ limit, windowMs }: { limit: number; windowMs: number }): RequestHandler {
  const windows = new Map<string, Window>();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.user ? `user:${req.user.id}` : `ip:${req.ip ?? 'desconocido'}`;

    if (windows.size >= MAX_KEYS) {
      for (const [k, w] of windows) if (now - w.startedAt >= windowMs) windows.delete(k);
    }

    let window = windows.get(key);
    if (!window || now - window.startedAt >= windowMs) {
      window = { count: 0, startedAt: now };
      windows.set(key, window);
    }
    window.count += 1;

    const resetSeconds = Math.max(1, Math.ceil((window.startedAt + windowMs - now) / 1000));
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - window.count)));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (window.count > limit) {
      res.setHeader('Retry-After', String(resetSeconds));
      next(
        AppError.tooManyRequests('Demasiadas peticiones de importación. Espere un momento e intente de nuevo.', {
          retryAfterSeconds: resetSeconds,
        }),
      );
      return;
    }
    next();
  };
}
