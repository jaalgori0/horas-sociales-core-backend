/**
 * Proyectos: lectura (listado, mapa, detalle) y escritura (crear, editar, eliminar).
 * Las respuestas siguen los tipos del frontend; ver project.queries.ts.
 */
import type { Transaction } from 'sequelize';
import { AppError } from '../../../core/errors/app-error.js';
import { execReturning, selectOne, withTransaction } from '../../../core/database/sql.js';
import { institutionsService } from '../../institutions/index.js';
import { projectStatusFromUI } from '../../shared/labels.js';
import type { CreateProjectInput, ListProjectsQuery, UpdateProjectInput } from '../schemas/project.schemas.js';
import { resolveCareerIds, resolveFacultyId } from './catalog-resolver.js';
import { enrollmentsService } from './enrollments.service.js';
import { syncProjectStatus } from './project-status.service.js';
import {
  fetchProjectRows,
  fetchProjectStudents,
  toDetailDTO,
  toListDTO,
  toMapDTO,
  type ProjectDetailDTO,
  type ProjectListDTO,
  type ProjectMapDTO,
} from './project.queries.js';

function hasInstitutionFields(input: UpdateProjectInput): boolean {
  return (
    input.institutionId !== undefined ||
    !!input.institutionName ||
    !!input.institutionType ||
    !!input.institutionLocation ||
    !!input.institutionDescription ||
    !!input.institutionImage
  );
}

function resolveEstado(input: { estado?: string; status?: string }): string | undefined {
  const raw = input.estado ?? input.status;
  if (raw === undefined) return undefined;
  const estado = projectStatusFromUI(raw);
  if (!estado) {
    throw AppError.unprocessable(`Estado de proyecto no reconocido: "${raw}"`, {
      admitidos: ['Activo', 'En progreso', 'Cerrado', 'BORRADOR', 'ACTIVO', 'PAUSADO', 'FINALIZADO', 'CANCELADO'],
    });
  }
  return estado;
}

/** Columnas de `projects` presentes en la entrada (undefined = no se toca). */
function projectColumns(input: UpdateProjectInput): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  if (input.titulo !== undefined) columns.titulo = input.titulo;
  if (input.descripcion !== undefined) columns.descripcion = input.descripcion;
  if (input.resumen !== undefined) columns.resumen = input.resumen;
  if (input.ubicacion !== undefined) columns.ubicacion = input.ubicacion;
  if (input.fechaInicio !== undefined) columns.fecha_inicio = input.fechaInicio;
  if (input.fechaCierre !== undefined) columns.fecha_cierre = input.fechaCierre;
  if (input.cupos !== undefined) columns.cupos = input.cupos;
  if (input.personas !== undefined) columns.personas_beneficiadas = input.personas;
  const image = input.projectImage !== undefined ? input.projectImage : input.image;
  if (image !== undefined) columns.image_url = image;
  const estado = resolveEstado(input);
  if (estado !== undefined) columns.estado = estado;
  return columns;
}

/**
 * Tras crear o editar: un proyecto ACTIVO con cierre vencido pasa a FINALIZADO
 * (caso "edité la fecha de cierre a una pasada"). Si el cliente pidió ACTIVO de
 * forma explícita con un cierre vencido, la combinación es contradictoria: 422.
 */
async function applyStatusRules(projectId: string, input: UpdateProjectInput, t: Transaction): Promise<void> {
  if (resolveEstado(input) === 'ACTIVO') {
    const row = await selectOne<{ vencido: boolean; fecha_cierre: string }>(
      `SELECT fecha_cierre <= (now() AT TIME ZONE 'America/El_Salvador')::date AS vencido,
              to_char(fecha_cierre, 'YYYY-MM-DD') AS fecha_cierre
       FROM projects WHERE id = :projectId`,
      { projectId },
      t,
    );
    if (row?.vencido) {
      throw AppError.unprocessable(
        'Un proyecto con la fecha de cierre vencida no puede quedar Activo: extienda la fecha de cierre o márquelo como Cerrado',
        { fechaCierre: row.fecha_cierre },
      );
    }
  }
  await syncProjectStatus({ ids: [projectId] }, t);
}

/**
 * Reapertura al editar: si la fecha de cierre CAMBIÓ a una futura y el proyecto
 * estaba FINALIZADO, vuelve a ACTIVO. Solo cuando cambia la fecha (el modal reenvía
 * siempre la fecha actual: editar el título no reabre un proyecto cerrado a mano),
 * solo desde FINALIZADO (CANCELADO es una decisión explícita) y solo si el cliente
 * no pidió un estado en la misma edición.
 */
async function reopenIfClosingExtended(
  projectId: string,
  input: UpdateProjectInput,
  previousFechaCierre: string | null,
  t: Transaction,
): Promise<void> {
  if (input.fechaCierre === undefined || resolveEstado(input) !== undefined) return;
  await execReturning(
    `UPDATE projects SET estado = 'ACTIVO'
     WHERE id = :projectId
       AND estado = 'FINALIZADO'
       AND fecha_cierre > (now() AT TIME ZONE 'America/El_Salvador')::date
       AND fecha_cierre IS DISTINCT FROM CAST(:previousFechaCierre AS date)
     RETURNING id`,
    { projectId, previousFechaCierre },
    t,
  );
}

async function replaceCareers(projectId: string, careerIds: string[], t: Transaction): Promise<void> {
  await execReturning('DELETE FROM project_careers WHERE project_id = :projectId RETURNING career_id', { projectId }, t);
  if (careerIds.length > 0) {
    await execReturning(
      `INSERT INTO project_careers (project_id, career_id)
       SELECT :projectId, unnest(ARRAY[:careerIds]::uuid[])
       RETURNING career_id`,
      { projectId, careerIds },
      t,
    );
  }
}

export const projectsService = {
  async list(query: ListProjectsQuery): Promise<ProjectListDTO[]> {
    return (await fetchProjectRows(query)).map(toListDTO);
  },

  async listForMap(): Promise<ProjectMapDTO[]> {
    return (await fetchProjectRows({})).map(toMapDTO);
  },

  async getById(id: string, t?: Transaction): Promise<ProjectDetailDTO> {
    const [row] = await fetchProjectRows({ id }, t);
    if (!row) throw AppError.notFound('Proyecto no encontrado');
    return toDetailDTO(row, await fetchProjectStudents(id, t));
  },

  async create(input: CreateProjectInput): Promise<ProjectDetailDTO> {
    return withTransaction(async (t) => {
      const institutionId = await institutionsService.resolveOrCreate(
        {
          institutionId: input.institutionId,
          nombre: input.institutionName,
          tipo: input.institutionType,
          ubicacion: input.institutionLocation,
          descripcion: input.institutionDescription,
          image: input.institutionImage,
        },
        t,
      );
      const facultyId = await resolveFacultyId(input, t);
      const careerIds = await resolveCareerIds(input, t);

      const columns: Record<string, unknown> = {
        descripcion: '',
        ...projectColumns(input),
        institution_id: institutionId,
        faculty_id: facultyId,
      };
      const names = Object.keys(columns);
      const [row] = await execReturning<{ id: string }>(
        `INSERT INTO projects (${names.join(', ')}) VALUES (${names.map((n) => `:${n}`).join(', ')}) RETURNING id`,
        columns,
        t,
      );
      const projectId = row!.id;

      if (careerIds) await replaceCareers(projectId, careerIds, t);
      for (const student of input.students ?? []) {
        await enrollmentsService.enrollInTransaction(projectId, student, t);
      }
      // Después de inscribir: un proyecto histórico (cierre pasado) acepta a sus estudiantes y luego se cierra.
      await applyStatusRules(projectId, input, t);
      return projectsService.getById(projectId, t);
    });
  },

  async update(id: string, input: UpdateProjectInput): Promise<ProjectDetailDTO> {
    return withTransaction(async (t) => {
      const current = await selectOne<{ institution_id: string; fecha_cierre: string | null }>(
        "SELECT institution_id, to_char(fecha_cierre, 'YYYY-MM-DD') AS fecha_cierre FROM projects WHERE id = :id FOR UPDATE",
        { id },
        t,
      );
      if (!current) throw AppError.notFound('Proyecto no encontrado');

      const columns = projectColumns(input);
      if (hasInstitutionFields(input)) {
        columns.institution_id = await institutionsService.resolveOrCreate(
          {
            // Sin institutionId ni institutionName se editan los datos de la institución actual.
            institutionId: input.institutionId ?? (input.institutionName ? undefined : current.institution_id),
            nombre: input.institutionName,
            tipo: input.institutionType,
            ubicacion: input.institutionLocation,
            descripcion: input.institutionDescription,
            image: input.institutionImage,
          },
          t,
        );
      }
      if (input.facultyId !== undefined || input.facultad !== undefined) {
        columns.faculty_id = await resolveFacultyId(input, t);
      }

      const names = Object.keys(columns);
      if (names.length > 0) {
        await execReturning(
          `UPDATE projects SET ${names.map((n) => `${n} = :${n}`).join(', ')} WHERE id = :id RETURNING id`,
          { ...columns, id },
          t,
        );
        await reopenIfClosingExtended(id, input, current.fecha_cierre, t);
        await applyStatusRules(id, input, t);
      }

      const careerIds = await resolveCareerIds(input, t);
      if (careerIds) await replaceCareers(id, careerIds, t);

      return projectsService.getById(id, t);
    });
  },

  /**
   * Elimina el proyecto y sus inscripciones. Si alguna inscripción tiene horas
   * registradas (historial académico) responde 409: se debe cerrar, no borrar.
   */
  async remove(id: string): Promise<{ deleted: true; projectId: string }> {
    return withTransaction(async (t) => {
      const row = await selectOne<{ id: string; movimientos: number; es_sistema: boolean }>(
        `SELECT p.id, (p.atributos ? 'sistema') AS es_sistema, (SELECT count(*) FROM hour_movements hm JOIN project_enrollments pe ON pe.id = hm.enrollment_id
                        WHERE pe.project_id = p.id)::int AS movimientos
         FROM projects p WHERE p.id = :id FOR UPDATE`,
        { id },
        t,
      );
      if (!row) throw AppError.notFound('Proyecto no encontrado');
      if (row.es_sistema) {
        throw AppError.conflict('Este es un proyecto interno del sistema (asignaciones manuales) y no se puede eliminar');
      }
      if (row.movimientos > 0) {
        throw AppError.conflict(
          'El proyecto tiene horas sociales registradas (historial académico) y no se puede eliminar; márquelo como Cerrado',
          { movimientosDeHoras: row.movimientos },
        );
      }
      await execReturning('DELETE FROM project_enrollments WHERE project_id = :id RETURNING id', { id }, t);
      await execReturning('DELETE FROM projects WHERE id = :id RETURNING id', { id }, t);
      return { deleted: true as const, projectId: id };
    });
  },
};
