/**
 * Instituciones. Las respuestas siguen los tipos del frontend
 * (InstitutionListResponse / InstitutionDetailResponse en services/api.ts).
 */
import type { Transaction } from 'sequelize';
import { AppError } from '../../../core/errors/app-error.js';
import {
  escapeLike,
  execReturning,
  selectAll,
  selectOne,
  withTransaction,
} from '../../../core/database/sql.js';
import {
  ENROLLMENT_ACTIVE_SQL,
  ENROLLMENT_COUNTED_SQL,
  ENROLLMENT_PARTICIPATION_SQL,
  institutionTipoFromUI,
  institutionTipoToUI,
  projectStatusSql,
  type ProjectStatusUI,
} from '../../shared/labels.js';
import type {
  CreateInstitutionInput,
  ListInstitutionsQuery,
  UpdateInstitutionInput,
} from '../schemas/institution.schemas.js';

export interface InstitutionListDTO {
  id: string;
  nombre: string;
  sigla: string | null;
  codigoCss: string | null;
  tipo: string | null;
  ubicacion: string;
  direccion: string | null;
  contactoNombre: string | null;
  contactoEmail: string | null;
  telefono: string | null;
  image: string | null;
  totalProyectos: number;
  totalProyectosActivos: number;
  totalEstudiantesAsignados: number;
  totalEstudiantesActivos: number;
}

export interface InstitutionProjectDTO {
  id: string;
  nombreInstitucion: string;
  nombreProyecto: string;
  estadoProyecto: ProjectStatusUI;
  ubicacion: string;
  fechaInicio: string | null;
  fechaCierre: string | null;
  estudiantes: number;
}

export interface InstitutionDetailDTO extends InstitutionListDTO {
  descripcion: string;
  totalCarrerasAplicables: number;
  proyectosGenerales: InstitutionProjectDTO[];
  proyectosActivos: InstitutionProjectDTO[];
  proyectosEnProgreso: InstitutionProjectDTO[];
  proyectosCerrados: InstitutionProjectDTO[];
}

interface InstitutionRow {
  id: string;
  nombre: string;
  sigla: string | null;
  codigo_css: string | null;
  tipo: string | null;
  ubicacion: string | null;
  direccion: string | null;
  descripcion: string | null;
  contacto_nombre: string | null;
  contacto_email: string | null;
  telefono: string | null;
  image_url: string | null;
  total_proyectos: number;
  total_proyectos_activos: number;
  total_estudiantes_asignados: number;
  total_estudiantes_activos: number;
  total_carreras: number;
}

/** Institución + contadores. `extraWhere` usa parámetros con nombre. */
const INSTITUTION_SELECT = `
  SELECT i.id, i.nombre, i.sigla, i.codigo_css, i.tipo, i.ubicacion, i.direccion, i.descripcion,
         i.contacto_nombre, i.contacto_email, i.telefono, i.image_url,
         (SELECT count(*) FROM projects p WHERE p.institution_id = i.id)::int AS total_proyectos,
         (SELECT count(*) FROM projects p WHERE p.institution_id = i.id AND p.estado = 'ACTIVO')::int
           AS total_proyectos_activos,
         (SELECT count(DISTINCT pe.student_id) FROM project_enrollments pe JOIN projects p ON p.id = pe.project_id
           WHERE p.institution_id = i.id AND pe.estado IN ${ENROLLMENT_COUNTED_SQL})::int AS total_estudiantes_asignados,
         (SELECT count(DISTINCT pe.student_id) FROM project_enrollments pe JOIN projects p ON p.id = pe.project_id
           WHERE p.institution_id = i.id AND pe.estado IN ${ENROLLMENT_ACTIVE_SQL})::int AS total_estudiantes_activos,
         (SELECT count(*) FROM (
             SELECT pc.career_id FROM project_careers pc JOIN projects p ON p.id = pc.project_id
              WHERE p.institution_id = i.id
             UNION
             SELECT s.career_id FROM project_enrollments pe
               JOIN projects p ON p.id = pe.project_id JOIN students s ON s.id = pe.student_id
              WHERE p.institution_id = i.id
         ) carreras)::int AS total_carreras
  FROM institutions i`;

function toListDTO(row: InstitutionRow): InstitutionListDTO {
  return {
    id: row.id,
    nombre: row.nombre,
    sigla: row.sigla,
    codigoCss: row.codigo_css,
    tipo: institutionTipoToUI(row.tipo),
    ubicacion: row.ubicacion ?? '',
    direccion: row.direccion,
    contactoNombre: row.contacto_nombre,
    contactoEmail: row.contacto_email,
    telefono: row.telefono,
    image: row.image_url,
    totalProyectos: row.total_proyectos,
    totalProyectosActivos: row.total_proyectos_activos,
    totalEstudiantesAsignados: row.total_estudiantes_asignados,
    totalEstudiantesActivos: row.total_estudiantes_activos,
  };
}

async function findRow(id: string, t?: Transaction): Promise<InstitutionRow> {
  const row = await selectOne<InstitutionRow>(`${INSTITUTION_SELECT} WHERE i.id = :id`, { id }, t);
  if (!row) throw AppError.notFound('Institución no encontrada');
  return row;
}

async function listProjects(institutionId: string, t?: Transaction): Promise<InstitutionProjectDTO[]> {
  return selectAll<InstitutionProjectDTO>(
    `SELECT p.id, i.nombre AS "nombreInstitucion", p.titulo AS "nombreProyecto",
            ${projectStatusSql('p')} AS "estadoProyecto",
            COALESCE(p.ubicacion, '') AS ubicacion,
            to_char(p.fecha_inicio, 'YYYY-MM-DD') AS "fechaInicio",
            to_char(p.fecha_cierre, 'YYYY-MM-DD') AS "fechaCierre",
            -- Participaciones del proyecto (incluye abandonadas, como el reporte del CSS).
            (SELECT count(*) FROM project_enrollments pe
              WHERE pe.project_id = p.id AND pe.estado IN ${ENROLLMENT_PARTICIPATION_SQL})::int AS estudiantes
     FROM projects p JOIN institutions i ON i.id = p.institution_id
     WHERE p.institution_id = :institutionId
     ORDER BY p.fecha_inicio DESC NULLS LAST, p.titulo`,
    { institutionId },
    t,
  );
}

/** Campos de la tabla a partir de la entrada validada (solo los presentes). */
function toColumns(input: Partial<CreateInstitutionInput>): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  if (input.nombre !== undefined) columns.nombre = input.nombre;
  if (input.sigla !== undefined) columns.sigla = input.sigla;
  if (input.tipo !== undefined) columns.tipo = institutionTipoFromUI(input.tipo);
  if (input.ubicacion !== undefined) columns.ubicacion = input.ubicacion;
  if (input.direccion !== undefined) columns.direccion = input.direccion;
  if (input.descripcion !== undefined) columns.descripcion = input.descripcion;
  if (input.contactoNombre !== undefined) columns.contacto_nombre = input.contactoNombre;
  if (input.contactoEmail !== undefined) columns.contacto_email = input.contactoEmail;
  if (input.telefono !== undefined) columns.telefono = input.telefono;
  const image = input.image_url !== undefined ? input.image_url : input.image;
  if (image !== undefined) columns.image_url = image;
  return columns;
}

async function insertInstitution(columns: Record<string, unknown>, t: Transaction): Promise<string> {
  const names = Object.keys(columns);
  const [row] = await execReturning<{ id: string }>(
    `INSERT INTO institutions (${names.join(', ')})
     VALUES (${names.map((n) => `:${n}`).join(', ')})
     RETURNING id`,
    columns,
    t,
  );
  return row!.id;
}

/** 409 legible antes de chocar con uq_institutions_nombre (nombre sin tildes ni mayúsculas). */
async function assertNombreDisponible(nombre: string, exceptId: string | null, t: Transaction): Promise<void> {
  const dup = await selectOne<{ id: string }>(
    `SELECT id FROM institutions
     WHERE nombre_normalizado = fn_normalize_text(:nombre) AND (CAST(:exceptId AS uuid) IS NULL OR id <> CAST(:exceptId AS uuid))`,
    { nombre, exceptId },
    t,
  );
  if (dup) throw AppError.conflict('Ya existe una institución con ese nombre', { institutionId: dup.id });
}

/**
 * Aviso (409 INSTITUCION_SIMILAR) si otra institución tiene un nombre EQUIVALENTE
 * (nombre_clave: difiere solo en tildes, puntuación, espacios o mayúsculas), p. ej.
 * "FISCALIA GENERAL DE LA REPUBLICA." frente a "Fiscalía General de la República".
 * `confirmar` = el usuario ya vio la lista y decidió crear/renombrar igual.
 */
export async function assertSinInstitucionSimilar(
  nombre: string, exceptId: string | null, confirmar: boolean | undefined, t: Transaction,
): Promise<void> {
  if (confirmar) return;
  const similares = await selectAll<{ id: string; nombre: string; codigoCss: string | null }>(
    `SELECT id, nombre, codigo_css AS "codigoCss" FROM institutions
     WHERE nombre_clave = fn_nombre_clave(:nombre)
       AND nombre_normalizado <> fn_normalize_text(:nombre)
       AND (CAST(:exceptId AS uuid) IS NULL OR id <> CAST(:exceptId AS uuid))
     ORDER BY nombre`,
    { nombre, exceptId },
    t,
  );
  if (similares.length > 0) {
    throw AppError.conflict('Ya existe una institución con un nombre equivalente', {
      code: 'INSTITUCION_SIMILAR',
      similares,
      puedeConfirmar: true,
    });
  }
}

export const institutionsService = {
  async list(query: ListInstitutionsQuery): Promise<InstitutionListDTO[]> {
    const tipo = query.type && query.type !== 'Todos' ? institutionTipoFromUI(query.type) : null;
    const search = query.search ? `%${escapeLike(query.search)}%` : null;
    const rows = await selectAll<InstitutionRow>(
      `${INSTITUTION_SELECT}
       WHERE (CAST(:tipo AS text) IS NULL OR i.tipo = :tipo)
         AND (CAST(:search AS text) IS NULL OR
              fn_normalize_text(concat_ws(' ', i.nombre, i.sigla, i.ubicacion, i.descripcion, i.codigo_css,
                                          i.contacto_nombre))
                LIKE fn_normalize_text(:search) ESCAPE '\\')
       ORDER BY i.nombre_normalizado ${query.sortBy === 'nombre-desc' ? 'DESC' : 'ASC'}`,
      { tipo, search },
    );
    return rows.map(toListDTO);
  },

  async getById(id: string, t?: Transaction): Promise<InstitutionDetailDTO> {
    const row = await findRow(id, t);
    const proyectos = await listProjects(id, t);
    return {
      ...toListDTO(row),
      descripcion: row.descripcion ?? '',
      totalCarrerasAplicables: row.total_carreras,
      proyectosGenerales: proyectos,
      proyectosActivos: proyectos.filter((p) => p.estadoProyecto === 'Activo'),
      proyectosEnProgreso: proyectos.filter((p) => p.estadoProyecto === 'En progreso'),
      proyectosCerrados: proyectos.filter((p) => p.estadoProyecto === 'Cerrado'),
    };
  },

  async create(input: CreateInstitutionInput): Promise<InstitutionDetailDTO> {
    return withTransaction(async (t) => {
      await assertNombreDisponible(input.nombre, null, t);
      await assertSinInstitucionSimilar(input.nombre, null, input.confirmarSimilar, t);
      const id = await insertInstitution(toColumns(input), t);
      return institutionsService.getById(id, t);
    });
  },

  async update(id: string, input: UpdateInstitutionInput): Promise<InstitutionDetailDTO> {
    return withTransaction(async (t) => {
      const row = await findRow(id, t);
      if (input.nombre !== undefined) {
        await assertNombreDisponible(input.nombre, id, t);
        // Solo si el nombre cambia: editar otros datos no vuelve a avisar por parecidas ya aceptadas.
        if (input.nombre.trim() !== row.nombre) await assertSinInstitucionSimilar(input.nombre, id, input.confirmarSimilar, t);
      }
      const columns = toColumns(input);
      const names = Object.keys(columns);
      if (names.length > 0) {
        await execReturning(
          `UPDATE institutions SET ${names.map((n) => `${n} = :${n}`).join(', ')} WHERE id = :id RETURNING id`,
          { ...columns, id },
          t,
        );
      }
      return institutionsService.getById(id, t);
    });
  },

  /** Solo se elimina una institución sin proyectos (FK RESTRICT en projects). */
  async remove(id: string): Promise<void> {
    await withTransaction(async (t) => {
      const row = await findRow(id, t);
      if (row.total_proyectos > 0) {
        throw AppError.conflict('La institución tiene proyectos registrados y no se puede eliminar', {
          proyectos: row.total_proyectos,
        });
      }
      await execReturning('DELETE FROM institutions WHERE id = :id RETURNING id', { id }, t);
    });
  },

  /**
   * Usado al crear/editar proyectos: devuelve la institución indicada por id,
   * o la busca por nombre (sin tildes ni mayúsculas) y la crea si no existe.
   */
  async resolveOrCreate(
    input: {
      institutionId?: string | null;
      nombre?: string | null;
      tipo?: string | null;
      ubicacion?: string | null;
      descripcion?: string | null;
      image?: string | null;
      /** Ver assertSinInstitucionSimilar. */
      confirmarSimilar?: boolean;
    },
    t: Transaction,
  ): Promise<string> {
    // Mismo contrato que el backend anterior: los campos de institución que llegan
    // con valor en el proyecto actualizan la institución existente; los vacíos se ignoran.
    const patch = toColumns({
      ...(input.tipo ? { tipo: input.tipo } : {}),
      ...(input.ubicacion ? { ubicacion: input.ubicacion } : {}),
      ...(input.descripcion ? { descripcion: input.descripcion } : {}),
      ...(input.image ? { image_url: input.image } : {}),
    });
    const applyPatch = async (id: string, extra: Record<string, unknown> = {}): Promise<string> => {
      const columns = { ...patch, ...extra };
      const names = Object.keys(columns);
      if (names.length > 0) {
        await execReturning(
          `UPDATE institutions SET ${names.map((n) => `${n} = :${n}`).join(', ')} WHERE id = :id RETURNING id`,
          { ...columns, id },
          t,
        );
      }
      return id;
    };

    if (input.institutionId) {
      const row = await findRow(input.institutionId, t);
      const rename = input.nombre && input.nombre.trim() !== row.nombre ? { nombre: input.nombre.trim() } : {};
      if (rename.nombre) await assertSinInstitucionSimilar(rename.nombre, input.institutionId, input.confirmarSimilar, t);
      return applyPatch(input.institutionId, rename);
    }
    if (!input.nombre) throw AppError.badRequest('Indique institutionId o institutionName');
    const existing = await selectOne<{ id: string }>(
      'SELECT id FROM institutions WHERE nombre_normalizado = fn_normalize_text(:nombre)',
      { nombre: input.nombre },
      t,
    );
    if (existing) return applyPatch(existing.id);
    // Institución nueva: avisar si ya hay una con nombre equivalente (evita duplicarla).
    await assertSinInstitucionSimilar(input.nombre, null, input.confirmarSimilar, t);
    return insertInstitution(
      toColumns({
        nombre: input.nombre,
        tipo: input.tipo ?? null,
        ubicacion: input.ubicacion ?? null,
        descripcion: input.descripcion ?? null,
        image_url: input.image ?? null,
      }),
      t,
    );
  },
};

