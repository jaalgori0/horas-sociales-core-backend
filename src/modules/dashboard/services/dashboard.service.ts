/**
 * Métricas del panel. Formas de respuesta según services/api.ts del frontend
 * (DashboardSummaryResponse, CarreraAnioRow, TrendYearRow, …).
 *
 * Criterios (iguales en todos los endpoints):
 *  - "Estudiante participante": participación ASIGNADA/EN_CURSO/FINALIZADA
 *    (las RETIRADA/CANCELADA no cuentan). Se cuentan estudiantes DISTINTOS.
 *  - "Activo": participación ASIGNADA/EN_CURSO (ocupa cupo hoy).
 *  - Año de participación = asignada_en; año de proyecto = fecha_inicio;
 *    año de horas = fecha_horas. Hora local de El Salvador.
 *  - Carrera/facultad por llaves foráneas, nunca por texto.
 */
import { selectAll, selectOne } from '../../../core/database/sql.js';
import {
  ENROLLMENT_ACTIVE_SQL,
  ENROLLMENT_COUNTED_SQL,
  institutionSectorToUI,
  institutionTipoToUI,
  PROJECT_GEO_JOINS,
  projectStatusSql,
  type ProjectStatusUI,
} from '../../shared/labels.js';
import { resolverUbicacion, type UbicacionResuelta } from '../../shared/geo-el-salvador.js';
import { studentNameSql } from '../../students/index.js';

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

export interface DashboardSummary {
  totalInstitutions: number;
  totalProjects: number;
  totalActiveEnrollments: number;
  totalMarkers: number;
  totalStudentsExternal: number;
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
   *  - 'participaciones': inscripciones; un estudiante en 3 proyectos cuenta 3.
   * Cada estudiante tiene una sola carrera: la suma de una columna (año) es el
   * total general exacto de ese año en ambos modos.
   */
  async carreraAnio(metrica: CarreraAnioMetrica = 'estudiantes'): Promise<CarreraAnioRow[]> {
    const conteo = metrica === 'participaciones' ? 'count(*)' : 'count(DISTINCT pe.student_id)';
    const rows = await selectAll<{ carrera: string; facultad: string; anio: number; total: number }>(
      `SELECT c.nombre AS carrera, f.nombre AS facultad, ${YEAR_OF('pe.asignada_en')} AS anio,
              ${conteo}::int AS total
       FROM project_enrollments pe
       JOIN students s  ON s.id = pe.student_id
       JOIN careers c   ON c.id = s.career_id
       JOIN faculties f ON f.id = c.faculty_id
       WHERE pe.estado IN ${ENROLLMENT_COUNTED_SQL}
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

  async summary(): Promise<DashboardSummary> {
    const [totals, byStatus, trendByYear, genderSummary, municipios] = await Promise.all([
      selectOne<Omit<DashboardSummary, 'projectsByStatus' | 'trendByYear' | 'genderSummary' | 'totalMunicipalities'>>(
        `SELECT (SELECT count(*) FROM institutions)::int AS "totalInstitutions",
                (SELECT count(*) FROM projects)::int     AS "totalProjects",
                (SELECT count(*) FROM project_enrollments WHERE estado IN ${ENROLLMENT_ACTIVE_SQL})::int
                  AS "totalActiveEnrollments",
                (SELECT count(*) FROM map_markers)::int  AS "totalMarkers",
                (SELECT count(DISTINCT pe.student_id) FROM project_enrollments pe
                   JOIN projects p ON p.id = pe.project_id
                  WHERE pe.estado IN ${ENROLLMENT_ACTIVE_SQL}
                    AND EXISTS (SELECT 1 FROM project_classifications pc
                                 WHERE pc.project_id = p.id AND pc.clasificacion = 'SS_EXTERNO'))::int
                  AS "totalStudentsExternal",
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
                (SELECT count(*) FROM careers WHERE activo)::int   AS "totalCareers"`,
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
      projectsByStatus: byStatus.map((r) => ({ estado: r.estado, total: String(r.total) })),
      trendByYear,
      genderSummary,
      // Solo municipios de El Salvador identificados: no cuentan "Sin ubicación", países
      // extranjeros ni ubicaciones con solo el departamento ("Chalatenango (sin municipio)").
      totalMunicipalities: municipios.filter((m) => m.municipioConocido).length,
    };
  },
};
