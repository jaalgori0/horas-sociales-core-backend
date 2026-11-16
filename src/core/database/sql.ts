/**
 * Utilidades de acceso SQL para los módulos de lectura agregada (proyectos,
 * instituciones, catálogos). Todas las consultas usan parámetros con nombre
 * (`:param`): nunca se concatenan valores del cliente en el SQL.
 */
import { QueryTypes, type Transaction } from 'sequelize';
import { sequelize } from '../config/database.js';

type Replacements = Record<string, unknown>;

/** SELECT que devuelve todas las filas. */
export async function selectAll<T extends object>(
  sql: string,
  replacements: Replacements = {},
  transaction?: Transaction,
): Promise<T[]> {
  return sequelize.query<T>(sql, { type: QueryTypes.SELECT, replacements, transaction });
}

/** SELECT que devuelve la primera fila o `null`. */
export async function selectOne<T extends object>(
  sql: string,
  replacements: Replacements = {},
  transaction?: Transaction,
): Promise<T | null> {
  const rows = await selectAll<T>(sql, replacements, transaction);
  return rows[0] ?? null;
}

/** INSERT/UPDATE/DELETE ... RETURNING: devuelve las filas afectadas. */
export async function execReturning<T extends object>(
  sql: string,
  replacements: Replacements = {},
  transaction?: Transaction,
): Promise<T[]> {
  const [rows] = await sequelize.query(sql, { replacements, transaction });
  return rows as T[];
}

/**
 * Ejecuta `work` en una transacción y fija `app.actor` (lo lee el trigger de
 * auditoría vía fn_current_actor()). Hasta que exista autenticación por token,
 * el actor por defecto es `api`.
 */
export async function withTransaction<T>(work: (t: Transaction) => Promise<T>, actor = 'api'): Promise<T> {
  return sequelize.transaction(async (t) => {
    await sequelize.query("SELECT set_config('app.actor', :actor, true)", { replacements: { actor }, transaction: t });
    return work(t);
  });
}

/** Escapa comodines de LIKE/ILIKE (usar con `ESCAPE '\\'`). */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Espejo en JS de fn_normalize_text() (SQL): minúsculas, sin tildes, espacios colapsados. */
export function normalizeText(value: string): string {
  const from = 'ÁÉÍÓÚÜÑáéíóúüñ';
  const to = 'AEIOUUNaeiouun';
  return [...value.trim()]
    .map((char) => {
      const index = from.indexOf(char);
      return index === -1 ? char : to[index];
    })
    .join('')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
