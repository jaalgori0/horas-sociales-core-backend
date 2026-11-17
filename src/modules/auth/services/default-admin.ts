/**
 * Administrador por defecto. Se ejecuta en cada arranque (main.ts) y es idempotente:
 *
 *   - Si el correo no existe, crea la cuenta ADMIN activa con la contraseña
 *     inicial, hasheada con hashPassword() (el mismo scrypt del registro/login).
 *   - Si ya existe, NO toca nada: ni contraseña, ni rol, ni estado. Un cambio de
 *     clave posterior nunca se sobrescribe.
 *   - INSERT ... ON CONFLICT DO NOTHING cubre el caso de dos instancias arrancando
 *     a la vez.
 *
 * El alta queda en `auditoria` (trigger de users) con el actor `sistema:admin-por-defecto`.
 */
import { execReturning, selectOne, withTransaction } from '../../../core/database/sql.js';
import { logger } from '../../../core/logger.js';
import { hashPassword } from './password.js';

const DEFAULT_ADMIN = {
  nombres: 'Oscar',
  apellidos: 'Arias',
  correo: 'oarias@uca.edu.sv',
  passwordInicial: '1234abc',
  rol: 'ADMIN',
} as const;

export async function ensureDefaultAdmin(): Promise<void> {
  const exists = await selectOne<{ id: string }>('SELECT id FROM users WHERE correo = :correo', {
    correo: DEFAULT_ADMIN.correo,
  });
  if (exists) return;

  const passwordHash = await hashPassword(DEFAULT_ADMIN.passwordInicial);
  const created = await withTransaction(
    (t) =>
      execReturning<{ id: string }>(
        `INSERT INTO users (nombres, apellidos, correo, password_hash, rol, activo)
         VALUES (:nombres, :apellidos, :correo, :passwordHash, :rol, true)
         ON CONFLICT ON CONSTRAINT uq_users_correo DO NOTHING
         RETURNING id`,
        { ...DEFAULT_ADMIN, passwordHash },
        t,
      ),
    'sistema:admin-por-defecto',
  );

  if (created.length > 0) {
    logger.warn(
      `Usuario administrador por defecto creado (${DEFAULT_ADMIN.correo}). Cambie su contraseña inicial.`,
    );
  }
}
