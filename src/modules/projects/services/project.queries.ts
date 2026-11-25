/**
 * Consultas de lectura de proyectos y su mapeo a los DTO que espera el
 * frontend (ProjectListResponse / ProjectDetailResponse / ProjectMapResponse).
 *
 * Reglas de derivación (los proyectos del histórico CSS no traen facultad):
 *   - facultad = projects.faculty_id; si es NULL, la facultad más frecuente entre
 *                las carreras del proyecto (project_careers) y las carreras de
 *                sus estudiantes, siempre por llaves foráneas.
 *   - carreras = project_careers; si no hay, las carreras de sus estudiantes.
 *   - estudiantesAsignados = participaciones ASIGNADA/EN_CURSO/FINALIZADA.
 *   - cuposOcupados        = participaciones ASIGNADA/EN_CURSO (ocupan cupo hoy).
 */
import type { Transaction } from 'sequelize';
import { escapeLike, selectAll } from '../../../core/database/sql.js';
import {
  ENROLLMENT_ACTIVE_SQL,
  ENROLLMENT_PARTICIPATION_SQL,
  facultyShortLabel,
  PROJECT_GEO_JOINS,
  institutionTipoToUI,
  projectStatusFromUI,
  projectStatusSql,
  projectStatusToUI,
  type ProjectClasificacion,
  type ProjectStatusUI,
} from '../../shared/labels.js';
import { resolverUbicacion } from '../../shared/geo-el-salvador.js';
import { generoToUI, studentNameSql, type GeneroUI } from '../../students/index.js';
import type { ListProjectsQuery } from '../schemas/project.schemas.js';

// ─── Filas SQL ───────────────────────────────────────────────────────────────
export interface ProjectRow {
  id: string;
  titulo: string;
  descripcion: string;
  resumen: string | null;
  ubicacion: string;
  estado: string;
  status: ProjectStatusUI;
  fecha_inicio: string | null;
  fecha_cierre: string | null;
  cupos: number | null;
  personas_beneficiadas: number;
  image_url: string | null;
  area_css: string | null;
  correlativo_css: string | null;
  naturaleza: string;
  clasificaciones: ProjectClasificacion[];
  en_reporte_css: boolean;
  es_sistema: boolean;
  institution_id: string;
  institution: string;
  institution_tipo: string | null;
  institution_descripcion: string | null;
  institution_image: string | null;
  faculty_id: string | null;
  faculty_nombre: string | null;
  faculty_derivada: boolean;
  carreras: string[];
  equipo: string[];
  asignados: number;
  ocupados: number;
  hombres: number;
  mujeres: number;
  total_horas: number;
  /** Geografía por llave foránea (district_id), si existe. */
  municipio_fk: string | null;
  departamento_fk: string | null;
}

interface EnrollmentRow {
  id: string;
  student_id: string;
  nombre: string;
  carnet: string;
  career_id: string;
  carrera: string;
  cargo: string;
  estado: string;
  asignada_en: string;
  cerrada_en: string | null;
  genero: string | null;
  avatar_url: string | null;
  email: string;
  correo_institucional: string;
  horas: number;
}

interface MovementRow {
  id: string;
  enrollment_id: string;
  horas: number;
  naturaleza: string;
  fecha: string;
  descripcion: string | null;
}

// ─── DTO ─────────────────────────────────────────────────────────────────────
export interface HourMovementDTO {
  id: string;
  horas: number;
  naturaleza: string;
  fecha: string;
  descripcion: string | null;
}

export interface ProjectStudentDTO {
  /** id de la inscripción (EditProjectModal/EditStudentModal lo usan como enrollmentId). */
  id: string;
  enrollmentId: string;
  studentId: string;
  /** Nombre visible: nunca null (ver students/student-display.ts). */
  nombre: string;
  carnet: string;
  carrera: string;
  careerId: string;
  cargo: string;
  /** true si la participación ocupa cupo (ASIGNADA/EN_CURSO). */
  activo: boolean;
  estadoInscripcion: string;
  asignadaEn: string;
  cerradaEn: string | null;
  genero: GeneroUI | null;
  avatar: string | null;
  email: string;
  horasAcumuladas: number;
  movimientos: HourMovementDTO[];
}

export interface ProjectListDTO {
  id: string;
  titulo: string;
  nombre: string;
  descripcion: string;
  resumen: string | null;
  ubicacion: string;
  facultad: string;
  facultadNombre: string | null;
  facultyId: string | null;
  carreras: string[];
  status: ProjectStatusUI;
  estado: ProjectStatusUI;
  estadoCodigo: string;
  institution: string;
  institutionId: string;
  equipo: string[];
  personas: number;
  estudiantesAsignados: number;
  cuposOcupados: number;
  cuposTotales: number | null;
  cuposTexto: string;
  personasBeneficiadas: number;
  fechaInicio: string | null;
  fechaCierre: string | null;
  imagen: string | null;
  hombres: number;
  mujeres: number;
  totalHoras: number;
  area: string | null;
  correlativoCss: string | null;
  /** Códigos (SS_INTERNO, SS_EXTERNO, PROFESIONALIZANTE, CONTACTO_REALIDAD), orden fijo. */
  clasificaciones: ProjectClasificacion[];
  /** Naturaleza con la que se registran las horas (derivada de las clasificaciones). */
  naturaleza: string;
  /**
   * Origen (migración 015): true = viene en el Excel CSS «Memoria de Labores» (reporte
   * oficial); false = solo aparece en los reportes de horas (PDF) o se creó en la app.
   */
  enReporteCss: boolean;
  /** Proyecto interno del sistema (asignaciones manuales / convalidaciones). */
  esSistema: boolean;
}

export interface ProjectDetailDTO extends ProjectListDTO {
  institutionTipo: string | null;
  institutionDescripcion: string | null;
  institutionImageUrl: string | null;
  estudiantes: ProjectStudentDTO[];
  desplegados: string | null;
}

export interface ProjectMapDTO {
  id: string;
  institution: string;
  status: ProjectStatusUI;
  nombre: string;
  ubicacion: string;
  descripcion: string;
  hombres: number;
  mujeres: number;
  /**
   * Lugar resuelto con la misma regla que el dashboard (shared/geo-el-salvador.ts):
   * es la clave de los marcadores por departamento del mapa. Si no se reconoce,
   * es el texto tal cual, el país o "Sin ubicación".
   */
  departamento: string;
  /** Municipio de El Salvador, si se conoce. */
  municipio: string | null;
  /** `departamento` es uno de los 14 departamentos (tiene marcador en el mapa). */
  enMapa: boolean;
  /** Ver ProjectListDTO.enReporteCss. */
  enReporteCss: boolean;
  /** Ver ProjectListDTO.esSistema. */
  esSistema: boolean;
}

// ─── SQL base ────────────────────────────────────────────────────────────────
const PROJECT_BASE_SQL = `
  SELECT p.id, p.titulo, p.descripcion, p.resumen, COALESCE(p.ubicacion, '') AS ubicacion,
         p.estado, ${projectStatusSql('p')} AS status,
         to_char(p.fecha_inicio, 'YYYY-MM-DD') AS fecha_inicio,
         to_char(p.fecha_cierre, 'YYYY-MM-DD') AS fecha_cierre,
         p.cupos, p.personas_beneficiadas, p.image_url,
         p.atributos ->> 'area_css' AS area_css, p.correlativo_css, p.naturaleza, p.fecha_inicio AS orden_fecha,
         p.en_reporte_css, (p.atributos ? 'sistema') AS es_sistema,
         i.id AS institution_id, i.nombre AS institution, i.tipo AS institution_tipo,
         i.descripcion AS institution_descripcion, i.image_url AS institution_image,
         fac.id AS faculty_id, fac.nombre AS faculty_nombre, (p.faculty_id IS NULL) AS faculty_derivada,
         COALESCE(
           NULLIF(ARRAY(SELECT c.nombre FROM project_careers pc JOIN careers c ON c.id = pc.career_id
                         WHERE pc.project_id = p.id ORDER BY c.nombre), '{}'),
           ARRAY(SELECT DISTINCT c.nombre FROM project_enrollments pe
                   JOIN students s ON s.id = pe.student_id JOIN careers c ON c.id = s.career_id
                  WHERE pe.project_id = p.id ORDER BY c.nombre)
         ) AS carreras,
         ARRAY(SELECT pcl.clasificacion FROM project_classifications pcl WHERE pcl.project_id = p.id
                ORDER BY array_position(ARRAY['SS_INTERNO', 'SS_EXTERNO', 'PROFESIONALIZANTE', 'CONTACTO_REALIDAD'],
                                        pcl.clasificacion)) AS clasificaciones,
         ARRAY(SELECT tm.nombre FROM project_team_members tm WHERE tm.project_id = p.id ORDER BY tm.orden, tm.nombre)
           AS equipo,
         COALESCE(st.asignados, 0)::int AS asignados,
         COALESCE(st.ocupados, 0)::int AS ocupados,
         COALESCE(st.hombres, 0)::int AS hombres,
         COALESCE(st.mujeres, 0)::int AS mujeres,
         COALESCE(hr.total_horas, 0)::int AS total_horas,
         gm.nombre AS municipio_fk, gdep.nombre AS departamento_fk
  FROM projects p
  JOIN institutions i ON i.id = p.institution_id
  ${PROJECT_GEO_JOINS}
  LEFT JOIN LATERAL (
      SELECT f.id, f.nombre FROM faculties f WHERE f.id = p.faculty_id
      UNION ALL
      (SELECT f.id, f.nombre
         FROM (SELECT c.faculty_id FROM project_careers pc JOIN careers c ON c.id = pc.career_id
                WHERE pc.project_id = p.id
               UNION ALL
               SELECT c.faculty_id FROM project_enrollments pe
                 JOIN students s ON s.id = pe.student_id JOIN careers c ON c.id = s.career_id
                WHERE pe.project_id = p.id) x
         JOIN faculties f ON f.id = x.faculty_id
        WHERE p.faculty_id IS NULL
        GROUP BY f.id, f.nombre
        ORDER BY count(*) DESC, f.nombre
        LIMIT 1)
  ) fac ON true
  LEFT JOIN LATERAL (
      -- Participaciones del proyecto: incluyen las abandonadas (RETIRADA), igual que el reporte del CSS.
      -- Los cupos ocupados siguen siendo solo las activas.
      SELECT count(*) FILTER (WHERE pe.estado IN ${ENROLLMENT_PARTICIPATION_SQL}) AS asignados,
             count(*) FILTER (WHERE pe.estado IN ${ENROLLMENT_ACTIVE_SQL})  AS ocupados,
             count(*) FILTER (WHERE pe.estado IN ${ENROLLMENT_PARTICIPATION_SQL} AND s.genero = 'HOMBRE') AS hombres,
             count(*) FILTER (WHERE pe.estado IN ${ENROLLMENT_PARTICIPATION_SQL} AND s.genero = 'MUJER')  AS mujeres
        FROM project_enrollments pe JOIN students s ON s.id = pe.student_id
       WHERE pe.project_id = p.id
  ) st ON true
  LEFT JOIN LATERAL (
      SELECT sum(hm.horas) AS total_horas
        FROM hour_movements hm JOIN project_enrollments pe ON pe.id = hm.enrollment_id
       WHERE pe.project_id = p.id
  ) hr ON true`;

export interface ProjectFilters extends Partial<ListProjectsQuery> {
  id?: string;
}

export async function fetchProjectRows(filters: ProjectFilters, t?: Transaction): Promise<ProjectRow[]> {
  const like = (value?: string) => (value ? `%${escapeLike(value)}%` : null);
  const status = filters.status ? projectStatusToUI(projectStatusFromUI(filters.status) ?? filters.status) : null;
  return selectAll<ProjectRow>(
    `SELECT * FROM (${PROJECT_BASE_SQL}) base
     WHERE (CAST(:id AS uuid) IS NULL OR base.id = CAST(:id AS uuid))
       AND (CAST(:institutionId AS uuid) IS NULL OR base.institution_id = CAST(:institutionId AS uuid))
       AND (CAST(:status AS text) IS NULL OR base.status = :status)
       AND (CAST(:search AS text) IS NULL OR
            fn_normalize_text(concat_ws(' ', base.titulo, base.descripcion, base.institution, base.area_css,
                                        base.correlativo_css)) LIKE fn_normalize_text(:search) ESCAPE '\\')
       AND (CAST(:location AS text) IS NULL OR fn_normalize_text(base.ubicacion) LIKE fn_normalize_text(:location) ESCAPE '\\')
       AND (CAST(:faculty AS text) IS NULL OR fn_normalize_text(base.faculty_nombre) LIKE fn_normalize_text(:faculty) ESCAPE '\\')
       AND (CAST(:clasificacion AS text[]) IS NULL OR base.clasificaciones && CAST(:clasificacion AS text[]))
     ORDER BY base.orden_fecha DESC NULLS LAST, base.titulo`,
    {
      id: filters.id ?? null,
      institutionId: filters.institutionId ?? null,
      status,
      search: like(filters.search),
      location: like(filters.location),
      faculty: like(filters.faculty ? facultyShortLabel(filters.faculty) : undefined),
      // Literal de arreglo de Postgres: los códigos ya vienen validados por el enum de Zod.
      clasificacion: filters.clasificacion ? `{${filters.clasificacion.join(',')}}` : null,
    },
    t,
  );
}

export async function fetchProjectStudents(projectId: string, t?: Transaction): Promise<ProjectStudentDTO[]> {
  const [rows, movements] = await Promise.all([
    selectAll<EnrollmentRow>(
      `SELECT pe.id, pe.student_id, ${studentNameSql('s')} AS nombre, s.carnet,
              c.id AS career_id, c.nombre AS carrera, pe.cargo, pe.estado,
              pe.asignada_en, pe.cerrada_en, s.genero, s.avatar_url,
              COALESCE(s.email_personal, s.correo_institucional)::text AS email,
              s.correo_institucional::text AS correo_institucional,
              COALESCE((SELECT sum(hm.horas) FROM hour_movements hm WHERE hm.enrollment_id = pe.id), 0)::int AS horas
       FROM project_enrollments pe
       JOIN students s ON s.id = pe.student_id
       JOIN careers c ON c.id = s.career_id
       WHERE pe.project_id = :projectId
       ORDER BY (pe.estado IN ${ENROLLMENT_ACTIVE_SQL}) DESC, nombre`,
      { projectId },
      t,
    ),
    selectAll<MovementRow>(
      `SELECT hm.id, hm.enrollment_id, hm.horas, hm.naturaleza,
              to_char(hm.fecha_horas, 'YYYY-MM-DD') AS fecha, hm.descripcion
       FROM hour_movements hm JOIN project_enrollments pe ON pe.id = hm.enrollment_id
       WHERE pe.project_id = :projectId
       ORDER BY hm.fecha_horas, hm.registrado_en`,
      { projectId },
      t,
    ),
  ]);

  const byEnrollment = new Map<string, HourMovementDTO[]>();
  for (const m of movements) {
    const list = byEnrollment.get(m.enrollment_id) ?? [];
    list.push({ id: m.id, horas: m.horas, naturaleza: m.naturaleza, fecha: m.fecha, descripcion: m.descripcion });
    byEnrollment.set(m.enrollment_id, list);
  }

  return rows.map((row) => ({
    id: row.id,
    enrollmentId: row.id,
    studentId: row.student_id,
    nombre: row.nombre,
    carnet: row.carnet,
    carrera: row.carrera,
    careerId: row.career_id,
    cargo: row.cargo,
    activo: row.estado === 'ASIGNADA' || row.estado === 'EN_CURSO',
    estadoInscripcion: row.estado,
    asignadaEn: new Date(row.asignada_en).toISOString(),
    cerradaEn: row.cerrada_en ? new Date(row.cerrada_en).toISOString() : null,
    genero: generoToUI(row.genero),
    avatar: row.avatar_url,
    email: row.email,
    horasAcumuladas: row.horas,
    movimientos: byEnrollment.get(row.id) ?? [],
  }));
}

export function toListDTO(row: ProjectRow): ProjectListDTO {
  return {
    id: row.id,
    titulo: row.titulo,
    nombre: row.titulo,
    descripcion: row.descripcion,
    resumen: row.resumen,
    ubicacion: row.ubicacion,
    facultad: facultyShortLabel(row.faculty_nombre),
    facultadNombre: row.faculty_nombre,
    facultyId: row.faculty_id,
    carreras: row.carreras,
    status: row.status,
    estado: row.status,
    estadoCodigo: row.estado,
    institution: row.institution,
    institutionId: row.institution_id,
    equipo: row.equipo,
    personas: row.asignados,
    estudiantesAsignados: row.asignados,
    cuposOcupados: row.ocupados,
    cuposTotales: row.cupos,
    cuposTexto: row.cupos != null ? `${row.ocupados} de ${row.cupos}` : `${row.ocupados} ocupados`,
    personasBeneficiadas: row.personas_beneficiadas,
    fechaInicio: row.fecha_inicio,
    fechaCierre: row.fecha_cierre,
    imagen: row.image_url,
    hombres: row.hombres,
    mujeres: row.mujeres,
    totalHoras: row.total_horas,
    area: row.area_css,
    correlativoCss: row.correlativo_css,
    clasificaciones: row.clasificaciones,
    naturaleza: row.naturaleza,
    enReporteCss: row.en_reporte_css,
    esSistema: row.es_sistema,
  };
}

export function toDetailDTO(row: ProjectRow, estudiantes: ProjectStudentDTO[]): ProjectDetailDTO {
  return {
    ...toListDTO(row),
    institutionTipo: institutionTipoToUI(row.institution_tipo),
    institutionDescripcion: row.institution_descripcion,
    institutionImageUrl: row.institution_image,
    estudiantes,
    desplegados: null,
  };
}

export function toMapDTO(row: ProjectRow): ProjectMapDTO {
  const lugar = resolverUbicacion(row.ubicacion, { municipio: row.municipio_fk, departamento: row.departamento_fk });
  return {
    id: row.id,
    institution: row.institution,
    status: row.status,
    nombre: row.titulo,
    ubicacion: row.ubicacion,
    descripcion: row.descripcion,
    hombres: row.hombres,
    mujeres: row.mujeres,
    departamento: lugar.departamento,
    municipio: lugar.municipioConocido ? lugar.municipio : null,
    enMapa: lugar.departamentoReconocido,
    enReporteCss: row.en_reporte_css,
    esSistema: row.es_sistema,
  };
}
