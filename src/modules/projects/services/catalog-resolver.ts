/**
 * Traduce los nombres de facultad/carrera que envía el frontend a llaves del
 * catálogo oficial (003). Comparación sin tildes, mayúsculas ni el prefijo
 * "Facultad de"; las carreras aceptan el sufijo de modalidad "(presencial)".
 */
import type { Transaction } from 'sequelize';
import { AppError } from '../../../core/errors/app-error.js';
import { normalizeText, selectAll, selectOne } from '../../../core/database/sql.js';
import { facultyShortLabel } from '../../shared/labels.js';

const MODALIDAD = /\s*\((presencial|semipresencial|virtual)\)\s*$/i;

export function normalizeCareerName(nombre: string): string {
  return normalizeText(nombre.replace(MODALIDAD, ''));
}

export async function resolveFacultyId(
  input: { facultyId?: string | null; facultad?: string | null },
  t: Transaction,
): Promise<string | null> {
  if (input.facultyId) {
    const row = await selectOne<{ id: string }>('SELECT id FROM faculties WHERE id = :id', { id: input.facultyId }, t);
    if (!row) throw AppError.unprocessable('La facultad indicada no existe', { facultyId: input.facultyId });
    return row.id;
  }
  if (!input.facultad) return null;
  const faculties = await selectAll<{ id: string; nombre: string }>('SELECT id, nombre FROM faculties', {}, t);
  const wanted = normalizeText(facultyShortLabel(input.facultad));
  const match = faculties.find((f) => normalizeText(facultyShortLabel(f.nombre)) === wanted);
  if (!match) {
    throw AppError.unprocessable(`La facultad "${input.facultad}" no existe en el catálogo oficial`, {
      disponibles: faculties.map((f) => f.nombre),
    });
  }
  return match.id;
}

export async function resolveCareerIds(
  input: { careerIds?: string[] | null; carreras?: string[] | null },
  t: Transaction,
): Promise<string[] | null> {
  if (input.careerIds) {
    if (input.careerIds.length === 0) return [];
    const rows = await selectAll<{ id: string }>('SELECT id FROM careers WHERE id IN (:ids)', { ids: input.careerIds }, t);
    if (rows.length !== new Set(input.careerIds).size) {
      throw AppError.unprocessable('Alguna de las carreras indicadas no existe', { careerIds: input.careerIds });
    }
    return rows.map((r) => r.id);
  }
  if (!input.carreras) return null;
  if (input.carreras.length === 0) return [];
  const careers = await selectAll<{ id: string; nombre: string }>('SELECT id, nombre FROM careers', {}, t);
  const byName = new Map(careers.map((c) => [normalizeCareerName(c.nombre), c.id]));
  const unknown: string[] = [];
  const ids = new Set<string>();
  for (const nombre of input.carreras) {
    const id = byName.get(normalizeCareerName(nombre));
    if (id) ids.add(id);
    else unknown.push(nombre);
  }
  if (unknown.length > 0) {
    throw AppError.unprocessable('Carreras que no existen en el catálogo oficial', { desconocidas: unknown });
  }
  return [...ids];
}

export async function resolveCareerId(
  input: { careerId?: string | null; carrera?: string | null },
  t: Transaction,
): Promise<string | null> {
  const ids = await resolveCareerIds(
    { careerIds: input.careerId ? [input.careerId] : null, carreras: input.carrera ? [input.carrera] : null },
    t,
  );
  return ids?.[0] ?? null;
}
