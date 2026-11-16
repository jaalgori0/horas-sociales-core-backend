/**
 * Traducciones entre los códigos de la BD (CHECK constraints de 001) y las
 * etiquetas que usa el frontend. Compartido por los módulos institutions,
 * projects y dashboard para que la regla viva en un solo lugar.
 */
import { normalizeText } from '../../core/database/sql.js';

// ─── Estado de proyecto ──────────────────────────────────────────────────────
export const PROJECT_ESTADOS = ['BORRADOR', 'ACTIVO', 'PAUSADO', 'FINALIZADO', 'CANCELADO'] as const;
export type ProjectEstado = (typeof PROJECT_ESTADOS)[number];
export type ProjectStatusUI = 'Activo' | 'En progreso' | 'Cerrado';

/** BD → UI. BORRADOR/PAUSADO = "En progreso" (en preparación o detenido). */
export function projectStatusToUI(estado: string): ProjectStatusUI {
  if (estado === 'ACTIVO') return 'Activo';
  if (estado === 'FINALIZADO' || estado === 'CANCELADO') return 'Cerrado';
  return 'En progreso';
}

/** Expresión SQL equivalente a projectStatusToUI() para filtrar en la BD. */
export function projectStatusSql(alias: string): string {
  return `CASE ${alias}.estado WHEN 'ACTIVO' THEN 'Activo'
            WHEN 'FINALIZADO' THEN 'Cerrado' WHEN 'CANCELADO' THEN 'Cerrado'
            ELSE 'En progreso' END`;
}

/**
 * UI → BD. Acepta las etiquetas del frontend (incluidas las heredadas
 * "En planificación"/"En convocatoria") o el código de la BD.
 */
export function projectStatusFromUI(value: string | null | undefined): ProjectEstado | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  if ((PROJECT_ESTADOS as readonly string[]).includes(upper)) return upper as ProjectEstado;
  switch (normalizeText(value)) {
    case 'activo':
      return 'ACTIVO';
    case 'cerrado':
    case 'finalizado':
      return 'FINALIZADO';
    case 'en progreso':
    case 'en planificacion':
    case 'en convocatoria':
      return 'BORRADOR';
    default:
      return null;
  }
}

// ─── Estado de participación ─────────────────────────────────────────────────
/** Participaciones que ocupan un cupo hoy. */
export const ENROLLMENT_ACTIVE_SQL = `('ASIGNADA', 'EN_CURSO')`;
/** Participaciones que cuentan como "estudiante asignado" (incluye históricas finalizadas). */
export const ENROLLMENT_COUNTED_SQL = `('ASIGNADA', 'EN_CURSO', 'FINALIZADA')`;

// ─── Tipo de institución ─────────────────────────────────────────────────────
export const INSTITUTION_TIPOS = [
  'GUBERNAMENTAL',
  'MUNICIPAL',
  'ONG',
  'PRIVADA',
  'ACADEMICA',
  'COMUNITARIA',
  'RELIGIOSA',
  'INTERNACIONAL',
  'OTRA',
] as const;
export type InstitutionTipo = (typeof INSTITUTION_TIPOS)[number];

const TIPO_LABELS: Record<InstitutionTipo, string> = {
  GUBERNAMENTAL: 'Gubernamental',
  MUNICIPAL: 'Municipal',
  ONG: 'ONG',
  PRIVADA: 'Privada',
  ACADEMICA: 'Académica',
  COMUNITARIA: 'Comunitaria',
  RELIGIOSA: 'Religiosa',
  INTERNACIONAL: 'Internacional',
  OTRA: 'Otra',
};

export function institutionTipoToUI(tipo: string | null | undefined): string | null {
  return tipo ? (TIPO_LABELS[tipo as InstitutionTipo] ?? tipo) : null;
}

/** Palabras clave → tipo. El orden importa: la primera coincidencia gana. */
const TIPO_KEYWORDS: Array<[InstitutionTipo, string[]]> = [
  ['INTERNACIONAL', ['internacional', 'naciones unidas', 'onu', 'unicef', 'usaid', 'embajada', 'cooperacion']],
  ['MUNICIPAL', ['municip', 'alcaldia', 'distrito']],
  ['ACADEMICA', ['academ', 'universidad', 'instituto', 'colegio', 'escuela', 'educativ', 'centro escolar', 'complejo educativo']],
  ['GUBERNAMENTAL', ['gubern', 'gobierno', 'ministerio', 'estatal', 'publica', 'publico', 'nacional', 'autonoma']],
  ['RELIGIOSA', ['religios', 'iglesia', 'parroquia', 'diocesis', 'pastoral', 'congregacion']],
  ['COMUNITARIA', ['comunit', 'comunidad', 'adesco', 'cooperativa', 'vecinal']],
  ['ONG', ['ong', 'fundacion', 'asociacion', 'sin fines de lucro']],
  ['PRIVADA', ['privad', 'empresa', 'sociedad anonima', 's.a.']],
  ['OTRA', ['otra', 'otro']],
];

/**
 * UI → BD. El frontend envía texto libre ("Universidad pública", "ONG", …);
 * la BD solo admite los códigos de INSTITUTION_TIPOS. Texto vacío → null;
 * texto sin coincidencia → 'OTRA'.
 */
export function institutionTipoFromUI(value: string | null | undefined): InstitutionTipo | null {
  if (value == null || value.trim() === '') return null;
  const upper = normalizeText(value).toUpperCase();
  if ((INSTITUTION_TIPOS as readonly string[]).includes(upper)) return upper as InstitutionTipo;
  const text = normalizeText(value);
  const words = new Set(text.split(/[^a-z0-9.]+/));
  for (const [tipo, keywords] of TIPO_KEYWORDS) {
    if (keywords.some((k) => (k.length <= 3 ? words.has(k) : text.includes(k)))) return tipo;
  }
  return 'OTRA';
}

// ─── Utilidades de presentación ──────────────────────────────────────────────
/** Etiqueta corta de facultad que el frontend usa en sus filtros ("Ingeniería y Arquitectura"). */
export function facultyShortLabel(nombre: string | null | undefined): string {
  return (nombre ?? '').replace(/^Facultad de\s+/i, '').trim();
}

/** Fecha `date` de PostgreSQL → 'YYYY-MM-DD' (o null). */
export function toIsoDate(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

// ─── Ubicación de proyectos ──────────────────────────────────────────────────
/**
 * JOINs geográficos de un proyecto (alias `p`): distrito → municipio → departamento.
 * Exponen `gm.nombre` y `gdep.nombre`; la traducción del texto libre de
 * `projects.ubicacion` a municipio/departamento vive en shared/geo-el-salvador.ts.
 */
export const PROJECT_GEO_JOINS = `
  LEFT JOIN geo_districts gd       ON gd.id = p.district_id
  LEFT JOIN geo_municipalities gm  ON gm.id = gd.municipality_id
  LEFT JOIN geo_departments gdep   ON gdep.id = gm.department_id`;

/** Tipo para la tabla del dashboard: el frontend solo distingue Pública/Privada. */
export function institutionSectorToUI(tipo: string | null | undefined): 'Pública' | 'Privada' | 'Sin tipo' {
  if (!tipo) return 'Sin tipo';
  return tipo === 'GUBERNAMENTAL' || tipo === 'MUNICIPAL' ? 'Pública' : 'Privada';
}
