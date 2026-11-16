/**
 * Autenticación por token de sesión (Authorization: Bearer <token>).
 *
 *   requireAuth            401 si no hay token válido o la cuenta está inactiva.
 *                          Deja el usuario en `req.user` (id, correo, rol).
 *   requireRole(...roles)  403 si el rol no está en la lista. Va DESPUÉS de requireAuth.
 *
 * Uso en un router:   router.use(requireAuth)   o   router.post('/', requireAuth, requireRole('ADMIN'), ...)
 */
import type { RequestHandler } from 'express';
import { selectOne } from '../../database/sql.js';
import { AppError } from '../../errors/app-error.js';
import { verifyToken } from '../../security/token.js';

export type UserRole = 'ADMIN' | 'COORDINADOR' | 'CONSULTA';

export interface AuthContext {
  id: string;
  correo: string;
  rol: UserRole;
}

declare global {
  namespace Express {
    interface Request {
      /** Usuario autenticado; solo existe en rutas protegidas con requireAuth. */
      user?: AuthContext;
    }
  }
}

const BEARER = /^Bearer\s+(\S+)$/i;

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const match = BEARER.exec(req.headers.authorization ?? '');
  // La firma se verifica en memoria antes de tocar la BD: un token falso no cuesta una consulta.
  const payload = match ? verifyToken(match[1]!) : null;
  if (!payload) {
    next(AppError.unauthorized('Sesión no válida o vencida. Inicie sesión de nuevo.'));
    return;
  }

  const user = await selectOne<AuthContext & { activo: boolean }>(
    'SELECT id, correo::text AS correo, rol, activo FROM users WHERE id = :id',
    { id: payload.sub },
  );
  if (!user || !user.activo) {
    next(AppError.unauthorized('Sesión no válida o vencida. Inicie sesión de nuevo.'));
    return;
  }

  req.user = { id: user.id, correo: user.correo, rol: user.rol };
  next();
};

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      next(AppError.unauthorized());
      return;
    }
    if (!roles.includes(req.user.rol)) {
      next(AppError.forbidden('Su rol no tiene permiso para esta operación'));
      return;
    }
    next();
  };
}

/** Actor para la auditoría (app.actor → fn_current_actor()). */
export function actorOf(user: AuthContext | undefined): string {
  return user ? `${user.correo} (${user.id})` : 'api';
}
