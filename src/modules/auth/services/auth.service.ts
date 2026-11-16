/**
 * Registro e inicio de sesión de usuarios administrativos (tabla `users`).
 *
 * Respuesta = AuthUser del frontend ({ id, nombre, apellido, correo }) + rol.
 * Hoy el frontend solo guarda ese objeto en localStorage: este backend todavía
 * NO emite tokens ni protege rutas por rol (pendiente para cuando el frontend
 * envíe credenciales en cada petición).
 */
import { env } from '../../../core/config/env.js';
import { AppError } from '../../../core/errors/app-error.js';
import { execReturning, selectOne, withTransaction } from '../../../core/database/sql.js';
import type { LoginInput, RegisterInput } from '../schemas/auth.schemas.js';
import { getDummyHash, hashPassword, verifyPassword } from './password.js';
import { loginThrottle } from './login-throttle.js';

export interface AuthUserDTO {
  id: string;
  nombre: string;
  apellido: string;
  correo: string;
  rol: string;
}

interface UserRow {
  id: string;
  nombres: string;
  apellidos: string;
  correo: string;
  rol: string;
  activo: boolean;
  password_hash: string;
}

const INVALID_CREDENTIALS = 'Correo o contraseña incorrectos';

function toDTO(row: Omit<UserRow, 'password_hash' | 'activo'>): AuthUserDTO {
  return { id: row.id, nombre: row.nombres, apellido: row.apellidos, correo: row.correo, rol: row.rol };
}

export const authService = {
  async register(input: RegisterInput): Promise<AuthUserDTO> {
    if (!env.AUTH_ALLOW_REGISTER) throw AppError.forbidden('El registro de cuentas está deshabilitado');

    const passwordHash = await hashPassword(input.password);
    return withTransaction(async (t) => {
      const exists = await selectOne<{ id: string }>('SELECT id FROM users WHERE correo = :correo', { correo: input.correo }, t);
      if (exists) throw AppError.conflict('Ya existe una cuenta con ese correo');

      const [row] = await execReturning<Omit<UserRow, 'password_hash' | 'activo'>>(
        `INSERT INTO users (nombres, apellidos, correo, password_hash, rol)
         VALUES (:nombre, :apellido, :correo, :passwordHash, :rol)
         RETURNING id, nombres, apellidos, correo::text AS correo, rol`,
        { ...input, passwordHash, rol: env.AUTH_REGISTER_ROLE },
        t,
      );
      return toDTO(row!);
    });
  },

  /** `clientKey` identifica el origen (IP) para limitar intentos fallidos. */
  async login(input: LoginInput, clientKey: string): Promise<AuthUserDTO> {
    const throttleKey = `${clientKey}|${input.correo}`;
    const wait = loginThrottle.retryAfter(throttleKey);
    if (wait > 0) {
      throw AppError.tooManyRequests('Demasiados intentos fallidos. Intente de nuevo más tarde.', {
        retryAfterSeconds: wait,
      });
    }

    const user = await selectOne<UserRow>(
      `SELECT id, nombres, apellidos, correo::text AS correo, rol, activo, password_hash
       FROM users WHERE correo = :correo`,
      { correo: input.correo },
    );
    // Siempre se verifica un hash (real o de relleno): mismo tiempo de respuesta exista o no el correo.
    const valid = await verifyPassword(input.password, user?.password_hash ?? (await getDummyHash()));
    if (!user || !valid || !user.activo) {
      loginThrottle.fail(throttleKey);
      throw AppError.unauthorized(INVALID_CREDENTIALS);
    }

    loginThrottle.reset(throttleKey);
    await withTransaction((t) =>
      execReturning('UPDATE users SET ultimo_acceso_en = now() WHERE id = :id RETURNING id', { id: user.id }, t),
    );
    return toDTO(user);
  },
};
