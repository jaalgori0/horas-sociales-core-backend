/**
 * Métricas del panel. Formas de respuesta según services/api.ts del frontend
 * (DashboardSummaryResponse, CarreraAnioRow, TrendYearRow, …).
 *
 * Criterios (iguales en todos los endpoints):
 *  - "Estudiante participante": participación ASIGNADA/EN_CURSO/FINALIZADA
 *    (las RETIRADA/CANCELADA no cuentan). Se cuentan estudiantes DISTINTOS.
 *  - "Participación" (totales de inscripciones): ASIGNADA/EN_CURSO/FINALIZADA/RETIRADA;
 *    las RETIRADA ("Abandonado" en el reporte) SÍ cuentan, por requerimiento del cliente.
 *  - "Activo": participación ASIGNADA/EN_CURSO (ocupa cupo hoy).
 *  - Año de participación = asignada_en; año de proyecto = fecha_inicio;
 *    año de horas = fecha_horas. Hora local de El Salvador.
 *  - Carrera/facultad por llaves foráneas, nunca por texto.
 */
import { selectAll, selectOne } from '../../../core/database/sql.js';
import {
  ENROLLMENT_ACTIVE_SQL,
  ENROLLMENT_COUNTED_SQL,
  ENROLLMENT_PARTICIPATION_SQL,
  institutionSectorToUI,
  institutionTipoToUI,
  PROJECT_GEO_JOINS,
  projectStatusSql,
  type ProjectStatusUI,
} from '../../shared/labels.js';
import { resolverUbicacion, type UbicacionResuelta } from '../../shared/geo-el-salvador.js';
import { HORAS_REQUISITO, studentNameSql } from '../../students/index.js';

const TZ = `'America/El_Salvador'`;

/**
 * Participaciones que cuentan para "estudiantes en varios proyectos": historial
 * completo (ASIGNADA/EN_CURSO/FINALIZADA), sin el proyecto de sistema de
 * asignaciones manuales. Alias: pe (project_enrollments), p (projects).
 * Lo comparten el KPI de summary() y el detalle estudiantesMultiProyecto().
 */
const MULTI_PROJECT_WHERE = `pe.estado IN ${ENROLLMENT_COUNTED_SQL} AND NOT (p.atributos ? 'sistema')`;

export interface EstudianteMultiProyectoRow {
  studentId: string;
  nombre: string;
  carnet: string;
  carrera: string;
  /** Proyectos distintos en los que participa o participó. */
  proyectos: number;
  /** De ellos, con participación activa hoy (ASIGNADA/EN_CURSO). */
  activos: number;
  /** Títulos de los proyectos, del más reciente al más antiguo. */
  titulos: string[];
}
const YEAR_OF = (column: string) => `EXTRACT(YEAR FROM ${column} AT TIME ZONE ${TZ})::int`;

/** Ubicación de un proyecto: texto libre + nombres por llave foránea (district_id), si existe. */
interface FilaGeo {
  ubicacion: string | null;
  municipio_fk: string | null;
  departamento_fk: string | null;
}

function resolverFila(fila: FilaGeo): UbicacionResuelta {
  return resolverUbicacion(fila.ubicacion, { municipio: fila.municipio_fk, departamento: fila.departamento_fk });
}

/** Participaciones que cuentan (ASIGNADA/EN_CURSO/FINALIZADA) con la ubicación de su proyecto. */
function participacionesConUbicacion(): Promise<Array<FilaGeo & { student_id: string; genero: string | null }>> {
  return selectAll(
    `SELECT p.ubicacion, gm.nombre AS municipio_fk, gdep.nombre AS departamento_fk, pe.student_id, s.genero
     FROM project_enrollments pe
     JOIN students s ON s.id = pe.student_id
     JOIN projects p ON p.id = pe.project_id
     ${PROJECT_GEO_JOINS}
     WHERE pe.estado IN ${ENROLLMENT_COUNTED_SQL}`,
  );
}

export interface GenderSummary {
  hombres: number;
  mujeres: number;
  /** Participantes sin género registrado (el histórico CSS no lo trae). */
  sinDato: number;
}

export interface TrendYearRow {
  anio: string;
  estudiantes: number;
  proyectos: number;
  horas: number;
}

export type CarreraAnioMetrica = 'estudiantes' | 'participaciones';

export type CarreraAnioRow = { carrera: string; facultad: string } & Record<string, number | string>;

export interface TablaInstitucionRow {
  id: string;
  nombreFull: string;
  nombre: string;
  tipo: 'Pública' | 'Privada' | 'Sin tipo';
  tipoDetalle: string | null;
  ubicacion: string;
  total: number;
  activos: number;
  progreso: number;
  cerrados: number;
  estudiantes: number;
  facultades: number;
  horas: number;
}

export interface Completaron600Row {
  studentId: string;
  nombre: string;
  carnet: string;
  carrera: string;
  facultad: string;
  /** Horas registradas dentro del año consultado. */
  horasAnio: number;
  /** Historial acumulado hasta el 31 de diciembre del año consultado. */
  horasAcumuladas: number;
}

export interface Completaron600Response {
  /** Año consultado (null si aún no hay participaciones). */
  anio: number | null;
  /** Años con participantes, ascendente (para el selector del frontend). */
  anios: number[];
  requisito: number;
  /** Personas distintas que realizaron horas sociales en el año. */
  participantes: number;
  /** De ellas, cuántas tenían >= requisito acumulado al cierre del año. */
  completaron: number;
  pendientes: number;
  /** 0–100, con un decimal. */
  porcentaje: number;
  /** Quiénes completaron (más horas acumuladas primero). */
  estudiantes: Completaron600Row[];
}

/**
 * Participantes de un año: estudiantes con una participación que cuenta asignada
 * ese año, o con horas registradas (fecha_horas) ese año. Columnas: student_id, anio.
 */
const PARTICIPANTES_POR_ANIO_SQL = `
  SELECT pe.student_id, ${YEAR_OF('pe.asignada_en')} AS anio
  FROM project_enrollments pe
  WHERE pe.estado IN ${ENROLLMENT_COUNTED_SQL}
  UNION
  SELECT pe.student_id, EXTRACT(YEAR FROM hm.fecha_horas)::int AS anio
  FROM hour_movements hm
  JOIN project_enrollments pe ON pe.id = hm.enrollment_id`;

export interface DashboardSummary {
  totalInstitutions: number;
  totalProjects: number;
  totalActiveEnrollments: number;
  totalMarkers: number;
  /**
   * Estudiantes DISTINTOS con una participación que cuenta (ASIGNADA/EN_CURSO/FINALIZADA)
   * asignada en `anioExternos`, en proyectos SS_EXTERNO. Mismo criterio que el resto de
   * métricas del año (antes solo contaba activos y sin filtro de año).
   */
  totalStudentsExternal: number;
  /** Participaciones del año sin deduplicar (un estudiante en 3 proyectos cuenta 3), incluidas las abandonadas. */
  totalEnrollmentsExternal: number;
  /** Año de la tarjeta: el pedido o, sin él, el más reciente con participaciones. */
  anioExternos: number | null;
  /**
   * Estudiantes con participación en 2 o más proyectos distintos, en todo el
   * historial (ASIGNADA/EN_CURSO/FINALIZADA). No cuenta el proyecto de sistema de
   * asignaciones manuales (convalidaciones), que no es una iniciativa real.
   */
  totalStudentsMultiProject: number;
  /** `total` como string: así lo tipa el frontend (DashboardSummaryResponse). */
  projectsByStatus: Array<{ estado: ProjectStatusUI; total: string }>;
  trendByYear: TrendYearRow[];
  genderSummary: GenderSummary;
  totalStudents: number;
  totalParticipants: number;
  totalHours: number;
  totalFaculties: number;
  totalCareers: number;
  totalMunicipalities: number;
}

export interface ConciliacionProyectoRow {
  projectId: string;
  titulo: string;
  institucion: string;
  codigoCss: string | null;
  correlativo: string | null;
  /** Alumnos que reporta el Excel CSS (null: el proyecto no viene en el Excel). */
  alumnosCss: number | null;
  /** Inscripciones cargadas (desde los PDF) en el año, en cualquier estado. */
  inscripciones: number;
  diferencia: number;
}

export interface ConciliacionResponse {
  anio: number | null;
  anios: number[];
  /** Excel «Memoria de Labores»: proyectos que iniciaron en el año y su total de alumnos. */
  reporteCss: { proyectos: number; alumnos: number };
  sistema: {
    /** Todas las inscripciones del año (incluye RETIRADA/CANCELADA): comparable con el Excel. */
    inscripciones: number;
    /** Las que cuentan como participaciones en el dashboard (incluye RETIRADA; no CANCELADA). */
    inscripcionesContadas: number;
    estudiantesUnicos: number;
    /** Inscripciones en proyectos que el Excel no trae (otro correlativo o proyecto de otro año). */
    inscripcionesSinReporte: number;
  };
  /** reporteCss.alumnos − sistema.inscripciones. */
  diferencia: number;
  /** Proyectos donde el Excel y lo cargado no coinciden (mayor diferencia primero). */
  proyectos: ConciliacionProyectoRow[];
}

/** Año más reciente con participaciones que cuentan (null si no hay ninguna). */
async function ultimoAnioConParticipaciones(): Promise<number | null> {
  const row = await selectOne<{ anio: number | null }>(
    `SELECT max(${YEAR_OF('asignada_en')}) AS anio FROM project_enrollments WHERE estado IN ${ENROLLMENT_PARTICIPATION_SQL}`,
  );
  return row?.anio ?? null;
}

export const dashboardService = {
  /** Participantes por género. Con `facultyId`, solo los de esa facultad (por la carrera del estudiante). */
  async genero(facultyId?: string): Promise<GenderSummary> {
    const row = await selectOne<GenderSummary>(
      `SELECT count(*) FILTER (WHERE s.genero = 'HOMBRE')::int AS hombres,
              count(*) FILTER (WHERE s.genero = 'MUJER')::int  AS mujeres,
              count(*) FILTER (WHERE s.genero IS NULL)::int    AS "sinDato"
       FROM students s
       JOIN careers c ON c.id = s.career_id
       WHERE EXISTS (SELECT 1 FROM project_enrollments pe
                      WHERE pe.student_id = s.id AND pe.estado IN ${ENROLLMENT_COUNTED_SQL})
         AND (CAST(:facultyId AS uuid) IS NULL OR c.faculty_id = CAST(:facultyId AS uuid))`,
      { facultyId: facultyId ?? null },
    );
    return row ?? { hombres: 0, mujeres: 0, sinDato: 0 };
  },

  async tendenciaAnual(): Promise<TrendYearRow[]> {
    const rows = await selectAll<{ anio: number; estudiantes: number; proyectos: number; horas: number }>(
      `WITH est AS (
         SELECT ${YEAR_OF('pe.asignada_en')} AS anio, count(DISTINCT pe.student_id) AS estudiantes
         FROM project_enrollments pe WHERE pe.estado IN ${ENROLLMENT_COUNTED_SQL} GROUP BY 1
       ), proy AS (
         SELECT EXTRACT(YEAR FROM p.fecha_inicio)::int AS anio, count(*) AS proyectos
         FROM projects p WHERE p.fecha_inicio IS NOT NULL GROUP BY 1
       ), hrs AS (
         SELECT EXTRACT(YEAR FROM hm.fecha_horas)::int AS anio, sum(hm.horas) AS horas
         FROM hour_movements hm GROUP BY 1
       ), anios AS (SELECT anio FROM est UNION SELECT anio FROM proy UNION SELECT anio FROM hrs)
       SELECT a.anio, COALESCE(est.estudiantes, 0)::int AS estudiantes,
              COALESCE(proy.proyectos, 0)::int AS proyectos, COALESCE(hrs.horas, 0)::int AS horas
       FROM anios a
       LEFT JOIN est USING (anio) LEFT JOIN proy USING (anio) LEFT JOIN hrs USING (anio)
       ORDER BY a.anio`,
    );
    return rows.map((r) => ({ ...r, anio: String(r.anio) }));
  },

  /** { carrera, facultad, '2025': n, '2026': n } — todas las filas con todos los años (0 si no hay). */
  /**
   * Por carrera y año de participación.
   *  - 'estudiantes':     personas distintas (default, comportamiento original).
   *  - 'participaciones': inscripciones; un estudiante en 3 proyectos cuenta 3, y las
   *                       abandonadas (RETIRADA) también cuentan.
   * Cada estudiante tiene una sola carrera: la suma de una columna (año) es el
   * total general exacto de ese año en ambos modos.
   */
  async carreraAnio(metrica: CarreraAnioMetrica = 'estudiantes'): Promise<CarreraAnioRow[]> {
    const conteo = metrica === 'participaciones' ? 'count(*)' : 'count(DISTINCT pe.student_id)';
    const estados = metrica === 'participaciones' ? ENROLLMENT_PARTICIPATION_SQL : ENROLLMENT_COUNTED_SQL;
    const rows = await selectAll<{ carrera: string; facultad: string; anio: number; total: number }>(
      `SELECT c.nombre AS carrera, f.nombre AS facultad, ${YEAR_OF('pe.asignada_en')} AS anio,
              ${conteo}::int AS total
       FROM project_enrollments pe
       JOIN students s  ON s.id = pe.student_id
       JOIN careers c   ON c.id = s.career_id
       JOIN faculties f ON f.id = c.faculty_id
       WHERE pe.estado IN ${estados}
       GROUP BY 1, 2, 3
       ORDER BY 1, 3`,
    );
    const years = [...new Set(rows.map((r) => String(r.anio)))].sort();
    const byCareer = new Map<string, CarreraAnioRow>();
    for (const r of rows) {
      let row = byCareer.get(r.carrera);
      if (!row) {
        row = { carrera: r.carrera, facultad: r.facultad } as CarreraAnioRow;
        for (const y of years) row[y] = 0;
        byCareer.set(r.carrera, row);
      }
      row[String(r.anio)] = r.total;
    }
    return [...byCareer.values()];
  },

  // ── Geografía ──────────────────────────────────────────────────────────────
  // La ubicación de un proyecto es texto libre: se traduce con resolverUbicacion()
  // (shared/geo-el-salvador.ts) y se agrega en memoria contando estudiantes
  // DISTINTOS por grupo. Así un municipio ("Soyapango") siempre cae bajo su
  // departamento ("San Salvador"), con o sin tildes y con o sin el departamento escrito.

  async estudiantesPorMunicipio(): Promise<Array<{ municipio: string; estudiantes: number }>> {
    const grupos = new Map<string, Set<string>>();
    for (const fila of await participacionesConUbicacion()) {
      const { municipio } = resolverFila(fila);
      grupos.set(municipio, (grupos.get(municipio) ?? new Set()).add(fila.student_id));
    }
    return [...grupos]
      .map(([municipio, estudiantes]) => ({ municipio, estudiantes: estudiantes.size }))
      .sort((a, b) => b.estudiantes - a.estudiantes || a.municipio.localeCompare(b.municipio, 'es'));
  },

  async proyectosPorMunicipio(): Promise<
    Array<{ municipio: string; departamento: string; proyectos: number; activos: number; municipioConocido: boolean }>
  > {
    const proyectos = await selectAll<FilaGeo & { estado: string }>(
      `SELECT p.ubicacion, gm.nombre AS municipio_fk, gdep.nombre AS departamento_fk, p.estado
       FROM projects p
       ${PROJECT_GEO_JOINS}`,
    );
    const grupos = new Map<string, { municipio: string; departamento: string; proyectos: number; activos: number; municipioConocido: boolean }>();
    for (const p of proyectos) {
      const u = resolverFila(p);
      const g = grupos.get(u.municipio) ?? {
        municipio: u.municipio, departamento: u.departamento, proyectos: 0, activos: 0, municipioConocido: u.municipioConocido,
      };
      g.proyectos += 1;
      if (p.estado === 'ACTIVO') g.activos += 1;
      grupos.set(u.municipio, g);
    }
    return [...grupos.values()].sort((a, b) => b.proyectos - a.proyectos || a.municipio.localeCompare(b.municipio, 'es'));
  },

  /**
   * Para el mapa: la clave `municipio` es el DEPARTAMENTO (así la busca el frontend
   * en coordenadasDepartamentos). Los municipios se agrupan bajo su departamento.
   * `enMapa` = la clave es uno de los 14 departamentos (el frontend tiene sus coordenadas).
   */
  async generoPorDepartamento(): Promise<
    Array<{ municipio: string; hombres: number; mujeres: number; sinDato: number; enMapa: boolean }>
  > {
    const grupos = new Map<string, { enMapa: boolean; hombres: Set<string>; mujeres: Set<string>; sinDato: Set<string> }>();
    for (const fila of await participacionesConUbicacion()) {
      const u = resolverFila(fila);
      const g = grupos.get(u.departamento) ?? {
        enMapa: u.departamentoReconocido, hombres: new Set<string>(), mujeres: new Set<string>(), sinDato: new Set<string>(),
      };
      (fila.genero === 'HOMBRE' ? g.hombres : fila.genero === 'MUJER' ? g.mujeres : g.sinDato).add(fila.student_id);
      grupos.set(u.departamento, g);
    }
    return [...grupos]
      .map(([municipio, g]) => ({
        municipio, hombres: g.hombres.size, mujeres: g.mujeres.size, sinDato: g.sinDato.size, enMapa: g.enMapa,
      }))
      .sort((a, b) => a.municipio.localeCompare(b.municipio, 'es'));
  },

  async mapMarkers(): Promise<
    Array<{ id: string; label: string; hombres: number; mujeres: number; lat: number; lng: number; projectId: string | null }>
  > {
    return selectAll(
      `SELECT m.id, m.label, m.hombres, m.mujeres, m.lat::float8 AS lat, m.lng::float8 AS lng, m.project_id AS "projectId"
       FROM map_markers m ORDER BY m.label`,
    );
  },

  async tablaInstitucion(limit?: number): Promise<TablaInstitucionRow[]> {
    const rows = await selectAll<Omit<TablaInstitucionRow, 'tipo' | 'tipoDetalle'> & { tipo_codigo: string | null; sigla: string | null }>(
      `WITH proj AS (
         SELECT p.institution_id,
                count(*)::int AS total,
                count(*) FILTER (WHERE ${projectStatusSql('p')} = 'Activo')::int      AS activos,
                count(*) FILTER (WHERE ${projectStatusSql('p')} = 'En progreso')::int AS progreso,
                count(*) FILTER (WHERE ${projectStatusSql('p')} = 'Cerrado')::int     AS cerrados
         FROM projects p GROUP BY 1
       ), est AS (
         SELECT p.institution_id, count(DISTINCT pe.student_id)::int AS estudiantes
         FROM project_enrollments pe JOIN projects p ON p.id = pe.project_id
         WHERE pe.estado IN ${ENROLLMENT_COUNTED_SQL} GROUP BY 1
       ), fac AS (
         SELECT x.institution_id, count(DISTINCT x.faculty_id)::int AS facultades
         FROM (SELECT p.institution_id, p.faculty_id FROM projects p WHERE p.faculty_id IS NOT NULL
               UNION ALL
               SELECT p.institution_id, c.faculty_id FROM project_careers pc
                 JOIN projects p ON p.id = pc.project_id JOIN careers c ON c.id = pc.career_id
               UNION ALL
               SELECT p.institution_id, c.faculty_id FROM project_enrollments pe
                 JOIN projects p ON p.id = pe.project_id JOIN students s ON s.id = pe.student_id
                 JOIN careers c ON c.id = s.career_id
               WHERE pe.estado IN ${ENROLLMENT_COUNTED_SQL}) x
         GROUP BY 1
       ), hrs AS (
         SELECT p.institution_id, sum(hm.horas)::int AS horas
         FROM hour_movements hm JOIN project_enrollments pe ON pe.id = hm.enrollment_id
         JOIN projects p ON p.id = pe.project_id GROUP BY 1
       )
       SELECT i.id, i.nombre, i.sigla, i.tipo AS tipo_codigo, COALESCE(i.ubicacion, '') AS ubicacion,
              COALESCE(proj.total, 0) AS total, COALESCE(proj.activos, 0) AS activos,
              COALESCE(proj.progreso, 0) AS progreso, COALESCE(proj.cerrados, 0) AS cerrados,
              COALESCE(est.estudiantes, 0) AS estudiantes, COALESCE(fac.facultades, 0) AS facultades,
              COALESCE(hrs.horas, 0) AS horas
       FROM institutions i
       LEFT JOIN proj ON proj.institution_id = i.id
       LEFT JOIN est  ON est.institution_id = i.id
       LEFT JOIN fac  ON fac.institution_id = i.id
       LEFT JOIN hrs  ON hrs.institution_id = i.id
       ORDER BY total DESC, estudiantes DESC, i.nombre_normalizado
       ${limit ? 'LIMIT :limit' : ''}`,
      { limit: limit ?? null },
    );
    return rows.map(({ tipo_codigo, sigla, ...r }) => ({
      ...r,
      nombreFull: sigla && sigla !== r.nombre ? `${r.nombre} (${sigla})` : r.nombre,
      tipo: institutionSectorToUI(tipo_codigo),
      tipoDetalle: institutionTipoToUI(tipo_codigo),
    }));
  },

  /** Estudiantes con 2+ proyectos y cuántos tiene cada uno (más proyectos primero). */
  async estudiantesMultiProyecto(): Promise<EstudianteMultiProyectoRow[]> {
    return selectAll<EstudianteMultiProyectoRow>(
      `SELECT s.id AS "studentId", ${studentNameSql('s')} AS nombre, s.carnet, c.nombre AS carrera,
              count(DISTINCT pe.project_id)::int AS proyectos,
              count(DISTINCT pe.project_id) FILTER (WHERE pe.estado IN ${ENROLLMENT_ACTIVE_SQL})::int AS activos,
              ARRAY(SELECT p2.titulo FROM project_enrollments pe2 JOIN projects p2 ON p2.id = pe2.project_id
                     WHERE pe2.student_id = s.id AND pe2.estado IN ${ENROLLMENT_COUNTED_SQL}
                       AND NOT (p2.atributos ? 'sistema')
                     GROUP BY p2.id, p2.titulo
                     ORDER BY max(pe2.asignada_en) DESC, p2.titulo) AS titulos
       FROM project_enrollments pe
       JOIN projects p ON p.id = pe.project_id
       JOIN students s ON s.id = pe.student_id
       JOIN careers c ON c.id = s.career_id
       WHERE ${MULTI_PROJECT_WHERE}
       GROUP BY s.id, c.nombre
       HAVING count(DISTINCT pe.project_id) > 1
       ORDER BY proyectos DESC, nombre`,
    );
  },

  /**
   * De quienes realizaron horas sociales en `anio` (ver PARTICIPANTES_POR_ANIO_SQL),
   * cuántos y quiénes completaron el requisito de 600 h. Se evalúa el historial
   * completo del estudiante hasta el cierre de ese año (todas sus participaciones,
   * incluidas convalidaciones manuales), igual que el progreso del perfil, pero sin
   * contar horas posteriores: un año pasado no cambia al registrar horas nuevas.
   * Sin `anio`, se usa el más reciente con participantes. `facultyId` filtra por
   * la facultad de la carrera del estudiante.
   */
  async completaron600(anio?: number, facultyId?: string): Promise<Completaron600Response> {
    const params = { facultyId: facultyId ?? null };
    const FACULTAD_WHERE = `(CAST(:facultyId AS uuid) IS NULL OR c.faculty_id = CAST(:facultyId AS uuid))`;
    const anios = (
      await selectAll<{ anio: number }>(
        `SELECT DISTINCT x.anio
         FROM (${PARTICIPANTES_POR_ANIO_SQL}) x
         JOIN students s ON s.id = x.student_id
         JOIN careers c  ON c.id = s.career_id
         WHERE x.anio IS NOT NULL AND ${FACULTAD_WHERE}
         ORDER BY 1`,
        params,
      )
    ).map((r) => r.anio);
    const anioConsulta = anio ?? anios[anios.length - 1] ?? null;
    const vacio: Completaron600Response = {
      anio: anioConsulta, anios, requisito: HORAS_REQUISITO,
      participantes: 0, completaron: 0, pendientes: 0, porcentaje: 0, estudiantes: [],
    };
    if (anioConsulta === null) return vacio;

    const rows = await selectAll<Completaron600Row & { completado: boolean }>(
      `WITH participantes AS (
         SELECT DISTINCT x.student_id FROM (${PARTICIPANTES_POR_ANIO_SQL}) x WHERE x.anio = :anio
       ), horas AS (
         SELECT pe.student_id,
                COALESCE(sum(hm.horas) FILTER (WHERE EXTRACT(YEAR FROM hm.fecha_horas) = :anio), 0)::int AS horas_anio,
                COALESCE(sum(hm.horas), 0)::int AS horas_acumuladas
         FROM hour_movements hm
         JOIN project_enrollments pe ON pe.id = hm.enrollment_id
         JOIN participantes pt ON pt.student_id = pe.student_id
         WHERE hm.fecha_horas <= make_date(:anio, 12, 31)
         GROUP BY pe.student_id
       )
       SELECT s.id AS "studentId", ${studentNameSql('s')} AS nombre, s.carnet,
              c.nombre AS carrera, f.nombre AS facultad,
              COALESCE(h.horas_anio, 0) AS "horasAnio",
              COALESCE(h.horas_acumuladas, 0) AS "horasAcumuladas",
              COALESCE(h.horas_acumuladas, 0) >= :requisito AS completado
       FROM participantes pt
       JOIN students s  ON s.id = pt.student_id
       JOIN careers c   ON c.id = s.career_id
       JOIN faculties f ON f.id = c.faculty_id
       LEFT JOIN horas h ON h.student_id = s.id
       WHERE ${FACULTAD_WHERE}
       ORDER BY "horasAcumuladas" DESC, nombre`,
      { ...params, anio: anioConsulta, requisito: HORAS_REQUISITO },
    );
    const estudiantes = rows.filter((r) => r.completado).map(({ completado: _c, ...r }) => r);
    const participantes = rows.length;
    const completaron = estudiantes.length;
    return {
      ...vacio,
      participantes,
      completaron,
      pendientes: participantes - completaron,
      porcentaje: participantes ? Math.round((completaron * 1000) / participantes) / 10 : 0,
      estudiantes,
    };
  },

  /**
   * Conciliación del año contra el Excel CSS (`projects.atributos.alumnos_css`, migración 010).
   * El Excel cuenta INSCRIPCIONES por proyecto (sin deduplicar estudiantes): 914 en 2026.
   * Los PDF por carrera no siempre usan el mismo correlativo ni el mismo periodo que el
   * Excel, así que la diferencia por proyecto es informativa, no un error de carga.
   */
  async conciliacion(anio?: number): Promise<ConciliacionResponse> {
    const anios = (
      await selectAll<{ anio: number }>(
        `SELECT DISTINCT ${YEAR_OF('asignada_en')} AS anio FROM project_enrollments
         UNION SELECT DISTINCT EXTRACT(YEAR FROM fecha_inicio)::int FROM projects
          WHERE atributos ? 'alumnos_css' AND fecha_inicio IS NOT NULL
         ORDER BY 1`,
      )
    ).map((r) => r.anio).filter((a) => a !== null);
    const anioConsulta = anio ?? anios[anios.length - 1] ?? null;
    const vacio: ConciliacionResponse = {
      anio: anioConsulta, anios,
      reporteCss: { proyectos: 0, alumnos: 0 },
      sistema: { inscripciones: 0, inscripcionesContadas: 0, estudiantesUnicos: 0, inscripcionesSinReporte: 0 },
      diferencia: 0, proyectos: [],
    };
    if (anioConsulta === null) return vacio;

    const rows = await selectAll<ConciliacionProyectoRow & { contadas: number; estudiantes: string[] }>(
      `WITH rep AS (
         SELECT p.id, (p.atributos ->> 'alumnos_css')::int AS alumnos
         FROM projects p
         WHERE p.atributos ? 'alumnos_css' AND EXTRACT(YEAR FROM p.fecha_inicio) = :anio
       ), ins AS (
         SELECT pe.project_id AS id, count(*)::int AS inscripciones,
                count(*) FILTER (WHERE pe.estado IN ${ENROLLMENT_PARTICIPATION_SQL})::int AS contadas,
                array_agg(DISTINCT pe.student_id::text) AS estudiantes
         FROM project_enrollments pe
         WHERE ${YEAR_OF('pe.asignada_en')} = :anio
         GROUP BY 1
       )
       SELECT p.id AS "projectId", p.titulo, i.nombre AS institucion, i.codigo_css AS "codigoCss",
              p.correlativo_css AS correlativo, rep.alumnos AS "alumnosCss",
              COALESCE(ins.inscripciones, 0) AS inscripciones, COALESCE(ins.contadas, 0) AS contadas,
              COALESCE(ins.estudiantes, '{}') AS estudiantes,
              COALESCE(rep.alumnos, 0) - COALESCE(ins.inscripciones, 0) AS diferencia
       FROM rep FULL JOIN ins USING (id)
       JOIN projects p ON p.id = COALESCE(rep.id, ins.id)
       JOIN institutions i ON i.id = p.institution_id
       WHERE NOT (p.atributos ? 'sistema')`,
      { anio: anioConsulta },
    );

    const conReporte = rows.filter((r) => r.alumnosCss !== null);
    const sum = (list: typeof rows, f: (r: (typeof rows)[number]) => number) => list.reduce((s, r) => s + f(r), 0);
    const reporteCss = { proyectos: conReporte.length, alumnos: sum(conReporte, (r) => r.alumnosCss ?? 0) };
    const sistema = {
      inscripciones: sum(rows, (r) => r.inscripciones),
      inscripcionesContadas: sum(rows, (r) => r.contadas),
      estudiantesUnicos: new Set(rows.flatMap((r) => r.estudiantes)).size,
      inscripcionesSinReporte: sum(rows.filter((r) => r.alumnosCss === null), (r) => r.inscripciones),
    };
    const proyectos = rows
      .filter((r) => r.diferencia !== 0)
      .map(({ contadas: _c, estudiantes: _e, ...r }) => r)
      .sort((a, b) => Math.abs(b.diferencia) - Math.abs(a.diferencia) || a.titulo.localeCompare(b.titulo, 'es'));
    return { ...vacio, reporteCss, sistema, diferencia: reporteCss.alumnos - sistema.inscripciones, proyectos };
  },

  async summary(anio?: number): Promise<DashboardSummary> {
    const anioExternos = anio ?? (await ultimoAnioConParticipaciones());
    const [totals, byStatus, trendByYear, genderSummary, municipios] = await Promise.all([
      selectOne<Omit<DashboardSummary, 'projectsByStatus' | 'trendByYear' | 'genderSummary' | 'totalMunicipalities' | 'anioExternos'>>(
        `SELECT (SELECT count(*) FROM institutions)::int AS "totalInstitutions",
                (SELECT count(*) FROM projects)::int     AS "totalProjects",
                (SELECT count(*) FROM project_enrollments WHERE estado IN ${ENROLLMENT_ACTIVE_SQL})::int
                  AS "totalActiveEnrollments",
                (SELECT count(*) FROM map_markers)::int  AS "totalMarkers",
                ext.estudiantes AS "totalStudentsExternal",
                ext.inscripciones AS "totalEnrollmentsExternal",
                (SELECT count(*) FROM (
                    SELECT pe.student_id FROM project_enrollments pe
                      JOIN projects p ON p.id = pe.project_id
                     WHERE ${MULTI_PROJECT_WHERE}
                     GROUP BY pe.student_id
                    HAVING count(DISTINCT pe.project_id) > 1) multi)::int AS "totalStudentsMultiProject",
                (SELECT count(*) FROM students)::int     AS "totalStudents",
                (SELECT count(DISTINCT student_id) FROM project_enrollments
                  WHERE estado IN ${ENROLLMENT_COUNTED_SQL})::int AS "totalParticipants",
                (SELECT COALESCE(sum(horas), 0) FROM hour_movements)::int AS "totalHours",
                (SELECT count(*) FROM faculties WHERE activo)::int AS "totalFaculties",
                (SELECT count(*) FROM careers WHERE activo)::int   AS "totalCareers"
         -- Estudiantes: sin las RETIRADA (no cuenta quien solo abandonó). Inscripciones:
         -- con las RETIRADA ("Abandonado" en el reporte), como el resto de totales de participaciones.
         FROM (SELECT count(DISTINCT pe.student_id) FILTER (WHERE pe.estado IN ${ENROLLMENT_COUNTED_SQL})::int AS estudiantes,
                      count(*)::int AS inscripciones
                 FROM project_enrollments pe
                WHERE pe.estado IN ${ENROLLMENT_PARTICIPATION_SQL}
                  AND ${YEAR_OF('pe.asignada_en')} = CAST(:anio AS int)
                  AND EXISTS (SELECT 1 FROM project_classifications pc
                               WHERE pc.project_id = pe.project_id AND pc.clasificacion = 'SS_EXTERNO')) ext`,
        { anio: anioExternos },
      ),
      selectAll<{ estado: ProjectStatusUI; total: number }>(
        `SELECT ${projectStatusSql('p')} AS estado, count(*)::int AS total
         FROM projects p GROUP BY 1
         ORDER BY array_position(ARRAY['Activo', 'En progreso', 'Cerrado'], ${projectStatusSql('p')})`,
      ),
      dashboardService.tendenciaAnual(),
      dashboardService.genero(),
      dashboardService.proyectosPorMunicipio(),
    ]);
    return {
      ...totals!,
      anioExternos,
      projectsByStatus: byStatus.map((r) => ({ estado: r.estado, total: String(r.total) })),
      trendByYear,
      genderSummary,
      // Solo municipios de El Salvador identificados: no cuentan "Sin ubicación", países
      // extranjeros ni ubicaciones con solo el departamento ("Chalatenango (sin municipio)").
      totalMunicipalities: municipios.filter((m) => m.municipioConocido).length,
    };
  },
};
