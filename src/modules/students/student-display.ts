/**
 * Presentación de estudiantes hacia el frontend. ÚNICA fuente de la regla del
 * nombre visible, para que nunca llegue `null` ni `"null null"`:
 *
 *   nombre = TRIM(nombres || ' ' || apellidos)  si existen (alumnos de la app)
 *          = nombre_completo                    en su defecto (histórico del CSS,
 *                                               "APELLIDO1, APELLIDO2 NOMBRES")
 *
 * Se ofrece en SQL (consultas agregadas) y en JS (DTOs de Sequelize).
 */
import type { Genero } from './models/student.model.js';

/** Expresión SQL del nombre visible para el alias de tabla `students` indicado. */
export function studentNameSql(alias: string): string {
  return `COALESCE(NULLIF(btrim(concat_ws(' ', ${alias}.nombres, ${alias}.apellidos)), ''), ${alias}.nombre_completo)`;
}

export function studentDisplayName(student: {
  nombres: string | null;
  apellidos: string | null;
  nombreCompleto: string;
}): string {
  const joined = [student.nombres, student.apellidos]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .trim();
  return joined || student.nombreCompleto;
}

/** Género del frontend (Masculino/Femenino) ↔ BD (HOMBRE/MUJER). */
export type GeneroUI = 'Masculino' | 'Femenino';

export function generoToUI(genero: string | null | undefined): GeneroUI | null {
  if (genero === 'HOMBRE') return 'Masculino';
  if (genero === 'MUJER') return 'Femenino';
  return null;
}

export function generoFromUI(genero: string | null | undefined): Genero | null {
  if (genero === 'Masculino' || genero === 'HOMBRE') return 'HOMBRE';
  if (genero === 'Femenino' || genero === 'MUJER') return 'MUJER';
  return null;
}
