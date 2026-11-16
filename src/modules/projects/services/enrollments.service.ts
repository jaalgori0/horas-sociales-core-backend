/**
 * Inscripciones de estudiantes en proyectos (project_enrollments).
 *
 * Reglas:
 *  - El estudiante se identifica por carnet. Si no existe se crea como los del
 *    histórico: el frontend envía un único `nombre`, que se guarda en
 *    nombre_completo con nombres/apellidos en NULL (se completan luego en
 *    PATCH /students/:id, siempre los dos juntos — migración 002).
 *  - No se inscribe en proyectos cerrados ni por encima de los cupos.
 *  - Una inscripción con horas registradas es historial académico: no se borra
 *    (409); se cambia su estado a RETIRADA/CANCELADA.
 */
import type { Transaction } from 'sequelize';
import { AppError } from '../../../core/errors/app-error.js';
import { execReturning, selectOne, withTransaction } from '../../../core/database/sql.js';
import { ENROLLMENT_ACTIVE_SQL } from '../../shared/labels.js';
import { generoFromUI, studentNameSql } from '../../students/index.js';
import type { EnrollStudentInput, UpdateEnrollmentInput } from '../schemas/project.schemas.js';
import { resolveCareerId } from './catalog-resolver.js';
import { fetchProjectStudents, type ProjectStudentDTO } from './project.queries.js';

const CLOSED_ENROLLMENT = ['FINALIZADA', 'RETIRADA', 'CANCELADA'];

interface StudentRow {
  id: string;
  carnet: string;
  nombres: string | null;
  nombre: string;
  correo_institucional: string;
  career_id: string;
}

/** Separa el correo enviado: el institucional ya se deriva del carnet. */
function personalEmail(email: string | null | undefined, carnet: string): string | null | undefined {
  if (email === undefined) return undefined;
  if (email === null) return null;
  return email === `${carnet}@uca.edu.sv` ? undefined : email;
}

async function findStudentByCarnet(carnet: string, t: Transaction): Promise<StudentRow | null> {
  return selectOne<StudentRow>(
    `SELECT s.id, s.carnet, s.nombres, ${studentNameSql('s')} AS nombre,
            s.correo_institucional::text AS correo_institucional, s.career_id
     FROM students s WHERE s.carnet = :carnet`,
    { carnet },
    t,
  );
}

async function studentItem(projectId: string, enrollmentId: string, t: Transaction): Promise<ProjectStudentDTO> {
  const students = await fetchProjectStudents(projectId, t);
  const item = students.find((s) => s.id === enrollmentId);
  if (!item) throw AppError.notFound('Inscripción no encontrada');
  return item;
}

export const enrollmentsService = {
  async list(projectId: string): Promise<ProjectStudentDTO[]> {
    const exists = await selectOne<{ id: string }>('SELECT id FROM projects WHERE id = :projectId', { projectId });
    if (!exists) throw AppError.notFound('Proyecto no encontrado');
    return fetchProjectStudents(projectId);
  },

  /** Inscribe dentro de una transacción existente (lo reutiliza la creación de proyectos). */
  async enrollInTransaction(projectId: string, input: EnrollStudentInput, t: Transaction): Promise<string> {
    const project = await selectOne<{ estado: string; cupos: number | null; ocupados: number }>(
      `SELECT p.estado, p.cupos,
              (SELECT count(*) FROM project_enrollments pe
                WHERE pe.project_id = p.id AND pe.estado IN ${ENROLLMENT_ACTIVE_SQL})::int AS ocupados
       FROM projects p WHERE p.id = :projectId FOR UPDATE OF p`,
      { projectId },
      t,
    );
    if (!project) throw AppError.notFound('Proyecto no encontrado');
    if (project.estado === 'FINALIZADO' || project.estado === 'CANCELADO') {
      throw AppError.conflict('El proyecto está cerrado: no admite nuevas inscripciones');
    }
    if (project.cupos != null && project.ocupados >= project.cupos) {
      throw AppError.conflict('El proyecto no tiene cupos disponibles', {
        cupos: project.cupos,
        ocupados: project.ocupados,
      });
    }

    const careerId = await resolveCareerId(input, t);
    const genero = input.genero !== undefined ? generoFromUI(input.genero) : undefined;
    const emailPersonal = personalEmail(input.email, input.carnet);

    let student = await findStudentByCarnet(input.carnet, t);
    if (!student) {
      if (!careerId) throw AppError.badRequest('La carrera es obligatoria para registrar un estudiante nuevo');
      const [created] = await execReturning<{ id: string }>(
        `INSERT INTO students (carnet, nombre_completo, correo_institucional, email_personal, genero, career_id)
         VALUES (:carnet, :nombre, :correo, :emailPersonal, :genero, :careerId)
         RETURNING id`,
        {
          carnet: input.carnet,
          nombre: input.nombre,
          correo: `${input.carnet}@uca.edu.sv`,
          emailPersonal: emailPersonal ?? null,
          genero: genero ?? null,
          careerId,
        },
        t,
      );
      student = await findStudentByCarnet(input.carnet, t);
      if (!student || student.id !== created?.id) throw AppError.internal();
    } else {
      // Estudiante existente: solo se completan datos de contacto; el nombre y la carrera no se pisan.
      const patch: Record<string, unknown> = {};
      if (genero) patch.genero = genero;
      if (emailPersonal) patch.email_personal = emailPersonal;
      const names = Object.keys(patch);
      if (names.length > 0) {
        await execReturning(
          `UPDATE students SET ${names.map((n) => `${n} = :${n}`).join(', ')} WHERE id = :id RETURNING id`,
          { ...patch, id: student.id },
          t,
        );
      }
    }

    const duplicate = await selectOne<{ id: string; estado: string }>(
      'SELECT id, estado FROM project_enrollments WHERE project_id = :projectId AND student_id = :studentId',
      { projectId, studentId: student.id },
      t,
    );
    if (duplicate) {
      throw AppError.conflict('El estudiante ya está inscrito en este proyecto', {
        enrollmentId: duplicate.id,
        estado: duplicate.estado,
      });
    }

    const [enrollment] = await execReturning<{ id: string }>(
      `INSERT INTO project_enrollments (project_id, student_id, cargo, estado)
       VALUES (:projectId, :studentId, :cargo, 'EN_CURSO')
       RETURNING id`,
      { projectId, studentId: student.id, cargo: input.cargo ?? 'ESTUDIANTE' },
      t,
    );
    return enrollment!.id;
  },

  async enroll(projectId: string, input: EnrollStudentInput): Promise<{ enrollmentId: string }> {
    return withTransaction(async (t) => ({ enrollmentId: await enrollmentsService.enrollInTransaction(projectId, input, t) }));
  },

  async update(projectId: string, enrollmentId: string, input: UpdateEnrollmentInput): Promise<ProjectStudentDTO> {
    return withTransaction(async (t) => {
      const enrollment = await selectOne<{ id: string; student_id: string; estado: string }>(
        'SELECT id, student_id, estado FROM project_enrollments WHERE id = :enrollmentId AND project_id = :projectId',
        { enrollmentId, projectId },
        t,
      );
      if (!enrollment) throw AppError.notFound('Inscripción no encontrada en este proyecto');

      const student = await selectOne<StudentRow>(
        `SELECT s.id, s.carnet, s.nombres, ${studentNameSql('s')} AS nombre,
                s.correo_institucional::text AS correo_institucional, s.career_id
         FROM students s WHERE s.id = :id`,
        { id: enrollment.student_id },
        t,
      );
      if (!student) throw AppError.notFound('Estudiante no encontrado');

      // ── Datos del estudiante ──
      const patch: Record<string, unknown> = {};
      if (input.nombre !== undefined && input.nombre !== student.nombre) {
        if (student.nombres !== null) {
          throw AppError.unprocessable(
            'Este estudiante ya tiene nombres y apellidos separados: edítelos con PATCH /students/:id',
            { studentId: student.id },
          );
        }
        patch.nombre_completo = input.nombre;
      }
      if (input.carnet !== undefined && input.carnet !== student.carnet) {
        patch.carnet = input.carnet;
        // El correo institucional se deriva del carnet: se actualiza si seguía derivado.
        if (student.correo_institucional === `${student.carnet}@uca.edu.sv`) {
          patch.correo_institucional = `${input.carnet}@uca.edu.sv`;
        }
      }
      const careerId = await resolveCareerId(input, t);
      if (careerId && careerId !== student.career_id) patch.career_id = careerId;
      if (input.genero !== undefined) patch.genero = generoFromUI(input.genero);
      const email = personalEmail(input.email, input.carnet ?? student.carnet);
      if (email !== undefined) patch.email_personal = email;

      const studentCols = Object.keys(patch);
      if (studentCols.length > 0) {
        await execReturning(
          `UPDATE students SET ${studentCols.map((n) => `${n} = :${n}`).join(', ')} WHERE id = :id RETURNING id`,
          { ...patch, id: student.id },
          t,
        );
      }

      // ── Datos de la inscripción ──
      const enrollmentPatch: Record<string, unknown> = {};
      if (input.cargo) enrollmentPatch.cargo = input.cargo;
      if (input.estado && input.estado !== enrollment.estado) enrollmentPatch.estado = input.estado;
      const enrollmentCols = Object.keys(enrollmentPatch);
      if (enrollmentCols.length > 0) {
        const closing = input.estado ? CLOSED_ENROLLMENT.includes(input.estado) : null;
        const cierre =
          closing === null ? '' : closing ? ', cerrada_en = COALESCE(cerrada_en, now())' : ', cerrada_en = NULL';
        await execReturning(
          `UPDATE project_enrollments SET ${enrollmentCols.map((n) => `${n} = :${n}`).join(', ')}${cierre}
           WHERE id = :id RETURNING id`,
          { ...enrollmentPatch, id: enrollmentId },
          t,
        );
      }

      return studentItem(projectId, enrollmentId, t);
    });
  },

  async remove(projectId: string, enrollmentId: string): Promise<void> {
    await withTransaction(async (t) => {
      const row = await selectOne<{ id: string; horas: number }>(
        `SELECT pe.id, (SELECT count(*) FROM hour_movements hm WHERE hm.enrollment_id = pe.id)::int AS horas
         FROM project_enrollments pe WHERE pe.id = :enrollmentId AND pe.project_id = :projectId`,
        { enrollmentId, projectId },
        t,
      );
      if (!row) throw AppError.notFound('Inscripción no encontrada en este proyecto');
      if (row.horas > 0) {
        throw AppError.conflict(
          'La inscripción tiene horas registradas (historial académico) y no se puede eliminar; cambie su estado a RETIRADA',
          { movimientosDeHoras: row.horas },
        );
      }
      await execReturning('DELETE FROM project_enrollments WHERE id = :enrollmentId RETURNING id', { enrollmentId }, t);
    });
  },
};
