/**
 * Perfil detallado del estudiante y asignación manual de horas.
 *
 * Reglas:
 *  - Requisito de egreso: HORAS_REQUISITO (600 h). No hay tope: lo que pase de
 *    600 se informa como `horasExtra`. El porcentaje se trunca (599 h = 99 %),
 *    para que "100 %" signifique siempre requisito cumplido.
 *  - Toda asignación manual va a una participación (enrollment_id obligatorio):
 *    la del proyecto elegido, que se crea en EN_CURSO si no existía. Para
 *    convalidaciones existe el proyecto interno del sistema (migración 005).
 *  - origen = 'MANUAL' + concepto: la conciliación de importaciones ignora estas
 *    horas (classify.sql), así que conviven con futuras cargas del CSS.
 *  - Idempotencia: la cabecera Idempotency-Key se guarda como
 *    md5('manual|<student>|<key>') en solicitud_id. Nunca se usa la clave del
 *    cliente tal cual: así no puede chocar con los md5('etl-css|...') de la
 *    importación (que hace ON CONFLICT DO NOTHING y perdería esas horas).
 *  - La auditoría la escriben los triggers trg_*_auditoria con el actor del token.
 */
import { createHash } from 'node:crypto';
import type { Transaction } from 'sequelize';
import { AppError } from '../../../core/errors/app-error.js';
import { execReturning, selectAll, selectOne, withTransaction } from '../../../core/database/sql.js';
import { ENROLLMENT_ACTIVE_SQL, projectStatusToUI, type ProjectStatusUI } from '../../shared/labels.js';
import { generoToUI, studentNameSql, type GeneroUI } from '../student-display.js';
import type { CreateManualHoursInput } from '../schemas/student.schemas.js';

export const HORAS_REQUISITO = 600;
export const SYSTEM_PROJECT_KEY = 'ASIGNACIONES_MANUALES';

const CLOSED_PROJECT = ['FINALIZADO', 'CANCELADO'];
const CLOSED_ENROLLMENT_NO_HOURS = ['RETIRADA', 'CANCELADA'];

export type HourOrigin = 'IMPORTACION' | 'MANUAL';
export type Naturaleza = 'INTERNA' | 'EXTERNA';

export interface StudentHourMovementDTO {
  id: string;
  enrollmentId: string;
  projectId: string;
  proyecto: string;
  institucion: string;
  horas: number;
  naturaleza: Naturaleza;
  origen: HourOrigin;
  fecha: string;
  concepto: string | null;
  descripcion: string | null;
  registradoPor: { id: string; nombre: string } | null;
  registradoEn: string;
}

export interface StudentProgressDTO {
  requisito: number;
  horasTotales: number;
  horasInternas: number;
  horasExternas: number;
  horasImportadas: number;
  horasManuales: number;
  /** 0–100, truncado. 100 solo si horasTotales >= requisito. */
  porcentaje: number;
  completado: boolean;
  horasRestantes: number;
  horasExtra: number;
}

export interface StudentParticipationDTO {
  enrollmentId: string;
  cargo: string;
  estado: string;
  asignadaEn: string;
  cerradaEn: string | null;
  horas: number;
  horasImportadas: number;
  horasManuales: number;
  proyecto: {
    id: string;
    titulo: string;
    naturaleza: Naturaleza;
    estado: ProjectStatusUI;
    fechaInicio: string | null;
    fechaCierre: string | null;
    esSistema: boolean;
  };
  institucion: { id: string; nombre: string; sigla: string | null };
  movimientos: StudentHourMovementDTO[];
}

export interface StudentProfileDTO {
  student: {
    id: string;
    carnet: string;
    nombre: string;
    nombres: string | null;
    apellidos: string | null;
    correoInstitucional: string;
    emailPersonal: string | null;
    telefono: string | null;
    genero: GeneroUI | null;
    avatarUrl: string | null;
    activo: boolean;
    carrera: { id: string; nombre: string };
    facultad: { id: string; nombre: string } | null;
  };
  progreso: StudentProgressDTO;
  participaciones: StudentParticipationDTO[];
}

export interface ManualHoursResult {
  profile: StudentProfileDTO;
  movementId: string;
  /** true si la misma Idempotency-Key ya se había procesado: no se insertó nada. */
  replayed: boolean;
}

// ─── consultas ───────────────────────────────────────────────────────────────

interface StudentRow {
  id: string;
  carnet: string;
  nombre: string;
  nombres: string | null;
  apellidos: string | null;
  correo_institucional: string;
  email_personal: string | null;
  telefono: string | null;
  genero: string | null;
  avatar_url: string | null;
  activo: boolean;
  career_id: string;
  carrera: string;
  faculty_id: string | null;
  facultad: string | null;
}

interface ParticipationRow {
  enrollment_id: string;
  cargo: string;
  estado: string;
  asignada_en: Date;
  cerrada_en: Date | null;
  project_id: string;
  titulo: string;
  naturaleza: Naturaleza;
  project_estado: string;
  fecha_inicio: string | null;
  fecha_cierre: string | null;
  es_sistema: boolean;
  institution_id: string;
  institucion: string;
  sigla: string | null;
}

interface MovementRow {
  id: string;
  enrollment_id: string;
  project_id: string;
  proyecto: string;
  institucion: string;
  horas: number;
  naturaleza: Naturaleza;
  origen: HourOrigin;
  fecha: string;
  concepto: string | null;
  descripcion: string | null;
  user_id: string | null;
  user_nombre: string | null;
  registrado_en: Date;
}

const MOVEMENTS_SQL = `
  SELECT hm.id, hm.enrollment_id, p.id AS project_id, p.titulo AS proyecto, i.nombre AS institucion,
         hm.horas, hm.naturaleza, hm.origen, to_char(hm.fecha_horas, 'YYYY-MM-DD') AS fecha,
         hm.concepto, hm.descripcion, u.id AS user_id,
         NULLIF(btrim(concat_ws(' ', u.nombres, u.apellidos)), '') AS user_nombre, hm.registrado_en
  FROM hour_movements hm
  JOIN project_enrollments pe ON pe.id = hm.enrollment_id
  JOIN projects p             ON p.id = pe.project_id
  JOIN institutions i         ON i.id = p.institution_id
  LEFT JOIN users u           ON u.id = hm.registrado_por
  WHERE pe.student_id = :studentId
  ORDER BY hm.fecha_horas DESC, hm.registrado_en DESC`;

function movementToDTO(m: MovementRow): StudentHourMovementDTO {
  return {
    id: m.id,
    enrollmentId: m.enrollment_id,
    projectId: m.project_id,
    proyecto: m.proyecto,
    institucion: m.institucion,
    horas: m.horas,
    naturaleza: m.naturaleza,
    origen: m.origen,
    fecha: m.fecha,
    concepto: m.concepto,
    descripcion: m.descripcion,
    registradoPor: m.user_id ? { id: m.user_id, nombre: m.user_nombre ?? 'Usuario' } : null,
    registradoEn: new Date(m.registrado_en).toISOString(),
  };
}

export function computeProgress(totales: {
  internas: number;
  externas: number;
  manuales: number;
}): StudentProgressDTO {
  const horasTotales = totales.internas + totales.externas;
  const completado = horasTotales >= HORAS_REQUISITO;
  return {
    requisito: HORAS_REQUISITO,
    horasTotales,
    horasInternas: totales.internas,
    horasExternas: totales.externas,
    horasImportadas: horasTotales - totales.manuales,
    horasManuales: totales.manuales,
    porcentaje: completado ? 100 : Math.floor((horasTotales * 100) / HORAS_REQUISITO),
    completado,
    horasRestantes: Math.max(HORAS_REQUISITO - horasTotales, 0),
    horasExtra: Math.max(horasTotales - HORAS_REQUISITO, 0),
  };
}

async function fetchProfile(studentId: string, t?: Transaction): Promise<StudentProfileDTO> {
  const student = await selectOne<StudentRow>(
    `SELECT s.id, s.carnet, ${studentNameSql('s')} AS nombre, s.nombres, s.apellidos,
            s.correo_institucional::text AS correo_institucional, s.email_personal::text AS email_personal,
            s.telefono, s.genero, s.avatar_url, s.activo,
            c.id AS career_id, c.nombre AS carrera, f.id AS faculty_id, f.nombre AS facultad
     FROM students s
     JOIN careers c        ON c.id = s.career_id
     LEFT JOIN faculties f ON f.id = c.faculty_id
     WHERE s.id = :studentId`,
    { studentId },
    t,
  );
  if (!student) throw AppError.notFound('Estudiante no encontrado');

  const [participations, movements] = await Promise.all([
    selectAll<ParticipationRow>(
      `SELECT pe.id AS enrollment_id, pe.cargo, pe.estado, pe.asignada_en, pe.cerrada_en,
              p.id AS project_id, p.titulo, p.naturaleza, p.estado AS project_estado,
              to_char(p.fecha_inicio, 'YYYY-MM-DD') AS fecha_inicio,
              to_char(p.fecha_cierre, 'YYYY-MM-DD') AS fecha_cierre,
              (p.atributos ? 'sistema') AS es_sistema,
              i.id AS institution_id, i.nombre AS institucion, i.sigla
       FROM project_enrollments pe
       JOIN projects p     ON p.id = pe.project_id
       JOIN institutions i ON i.id = p.institution_id
       WHERE pe.student_id = :studentId
       ORDER BY (pe.estado IN ${ENROLLMENT_ACTIVE_SQL}) DESC, pe.asignada_en DESC`,
      { studentId },
      t,
    ),
    selectAll<MovementRow>(MOVEMENTS_SQL, { studentId }, t),
  ]);

  const byEnrollment = new Map<string, StudentHourMovementDTO[]>();
  let internas = 0;
  let externas = 0;
  let manuales = 0;
  for (const row of movements) {
    const dto = movementToDTO(row);
    const list = byEnrollment.get(dto.enrollmentId) ?? [];
    list.push(dto);
    byEnrollment.set(dto.enrollmentId, list);
    if (dto.naturaleza === 'INTERNA') internas += dto.horas;
    else externas += dto.horas;
    if (dto.origen === 'MANUAL') manuales += dto.horas;
  }

  return {
    student: {
      id: student.id,
      carnet: student.carnet,
      nombre: student.nombre,
      nombres: student.nombres,
      apellidos: student.apellidos,
      correoInstitucional: student.correo_institucional,
      emailPersonal: student.email_personal,
      telefono: student.telefono,
      genero: generoToUI(student.genero),
      avatarUrl: student.avatar_url,
      activo: student.activo,
      carrera: { id: student.career_id, nombre: student.carrera },
      facultad: student.faculty_id ? { id: student.faculty_id, nombre: student.facultad ?? '' } : null,
    },
    progreso: computeProgress({ internas, externas, manuales }),
    participaciones: participations.map((p) => {
      const movimientos = byEnrollment.get(p.enrollment_id) ?? [];
      const horas = movimientos.reduce((sum, m) => sum + m.horas, 0);
      const horasManuales = movimientos.filter((m) => m.origen === 'MANUAL').reduce((sum, m) => sum + m.horas, 0);
      return {
        enrollmentId: p.enrollment_id,
        cargo: p.cargo,
        estado: p.estado,
        asignadaEn: new Date(p.asignada_en).toISOString(),
        cerradaEn: p.cerrada_en ? new Date(p.cerrada_en).toISOString() : null,
        horas,
        horasImportadas: horas - horasManuales,
        horasManuales,
        proyecto: {
          id: p.project_id,
          titulo: p.titulo,
          naturaleza: p.naturaleza,
          estado: projectStatusToUI(p.project_estado),
          fechaInicio: p.fecha_inicio,
          fechaCierre: p.fecha_cierre,
          esSistema: p.es_sistema,
        },
        institucion: { id: p.institution_id, nombre: p.institucion, sigla: p.sigla },
        movimientos,
      };
    }),
  };
}

/** md5('manual|<student>|<key>') con forma de UUID: espacio de claves disjunto del de la importación. */
function manualSolicitudId(studentId: string, key: string): string {
  const hex = createHash('md5').update(`manual|${studentId}|${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function assertStudentExists(studentId: string, t?: Transaction): Promise<void> {
  const row = await selectOne<{ id: string }>('SELECT id FROM students WHERE id = :studentId', { studentId }, t);
  if (!row) throw AppError.notFound('Estudiante no encontrado');
}

/** Participación del estudiante en el proyecto; la crea (EN_CURSO) si no existe. */
async function resolveEnrollment(
  studentId: string,
  projectId: string,
  fechaHoras: string,
  t: Transaction,
): Promise<{ enrollmentId: string; naturaleza: Naturaleza }> {
  // FOR UPDATE: serializa altas concurrentes sobre el mismo proyecto (cupos).
  const project = await selectOne<{
    naturaleza: Naturaleza;
    estado: string;
    cupos: number | null;
    es_sistema: boolean;
  }>(
    `SELECT p.naturaleza, p.estado, p.cupos, (p.atributos ? 'sistema') AS es_sistema
     FROM projects p WHERE p.id = :projectId FOR UPDATE OF p`,
    { projectId },
    t,
  );
  if (!project) throw AppError.unprocessable('El proyecto indicado no existe', { field: 'projectId' });

  const existing = await selectOne<{ id: string; estado: string }>(
    'SELECT id, estado FROM project_enrollments WHERE student_id = :studentId AND project_id = :projectId',
    { studentId, projectId },
    t,
  );
  if (existing) {
    if (CLOSED_ENROLLMENT_NO_HOURS.includes(existing.estado)) {
      throw AppError.conflict(
        `La participación del estudiante en este proyecto está ${existing.estado}: no admite horas nuevas`,
        { field: 'projectId', estado: existing.estado },
      );
    }
    return { enrollmentId: existing.id, naturaleza: project.naturaleza };
  }

  if (CLOSED_PROJECT.includes(project.estado)) {
    throw AppError.conflict(
      'El proyecto está cerrado y el estudiante no participa en él. Use el proyecto interno de asignaciones manuales.',
      { field: 'projectId', estado: project.estado },
    );
  }
  if (!project.es_sistema && project.cupos != null) {
    const ocupados = await selectOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM project_enrollments
       WHERE project_id = :projectId AND estado IN ${ENROLLMENT_ACTIVE_SQL}`,
      { projectId },
      t,
    );
    if ((ocupados?.n ?? 0) >= project.cupos) {
      throw AppError.conflict('El proyecto no tiene cupos disponibles', { field: 'projectId', cupos: project.cupos });
    }
  }

  const [created] = await execReturning<{ id: string }>(
    `INSERT INTO project_enrollments (project_id, student_id, estado, asignada_en)
     VALUES (:projectId, :studentId, 'EN_CURSO', LEAST(now(), fn_import_inicio_dia(:fechaHoras::date)))
     RETURNING id`,
    { projectId, studentId, fechaHoras },
    t,
  );
  return { enrollmentId: created!.id, naturaleza: project.naturaleza };
}

export const studentProfileService = {
  async getProfile(studentId: string): Promise<StudentProfileDTO> {
    return fetchProfile(studentId);
  },

  async findIdByCarnet(carnet: string): Promise<{ id: string; carnet: string }> {
    const row = await selectOne<{ id: string; carnet: string }>(
      'SELECT id, carnet FROM students WHERE carnet = :carnet',
      { carnet },
    );
    if (!row) throw AppError.notFound('Estudiante no encontrado');
    return row;
  },

  async listMovements(studentId: string): Promise<StudentHourMovementDTO[]> {
    await assertStudentExists(studentId);
    const rows = await selectAll<MovementRow>(MOVEMENTS_SQL, { studentId });
    return rows.map(movementToDTO);
  },

  async addManualHours(
    studentId: string,
    input: CreateManualHoursInput,
    ctx: { userId: string; actor: string; idempotencyKey: string | null },
  ): Promise<ManualHoursResult> {
    return withTransaction(async (t) => {
      // Serializa asignaciones del mismo estudiante (y la verificación de idempotencia).
      const student = await selectOne<{ id: string }>(
        'SELECT id FROM students WHERE id = :studentId FOR UPDATE',
        { studentId },
        t,
      );
      if (!student) throw AppError.notFound('Estudiante no encontrado');

      const solicitudId = ctx.idempotencyKey ? manualSolicitudId(studentId, ctx.idempotencyKey) : null;

      if (solicitudId) {
        const previous = await selectOne<{
          id: string;
          student_id: string;
          project_id: string;
          horas: number;
          fecha: string;
          concepto: string | null;
        }>(
          `SELECT hm.id, pe.student_id, pe.project_id, hm.horas,
                  to_char(hm.fecha_horas, 'YYYY-MM-DD') AS fecha, hm.concepto
           FROM hour_movements hm JOIN project_enrollments pe ON pe.id = hm.enrollment_id
           WHERE hm.solicitud_id = :solicitudId`,
          { solicitudId },
          t,
        );
        if (previous) {
          const same =
            previous.project_id === input.projectId &&
            previous.horas === input.horas &&
            previous.fecha === input.fechaHoras &&
            previous.concepto === input.concepto;
          if (!same) {
            throw AppError.conflict(
              'Esta Idempotency-Key ya se usó con datos distintos. Genere una clave nueva para otra asignación.',
            );
          }
          return { profile: await fetchProfile(studentId, t), movementId: previous.id, replayed: true };
        }
      }

      const { enrollmentId, naturaleza } = await resolveEnrollment(studentId, input.projectId, input.fechaHoras, t);

      const [movement] = await execReturning<{ id: string }>(
        `INSERT INTO hour_movements
           (enrollment_id, horas, naturaleza, fecha_horas, origen, concepto, descripcion, registrado_por, solicitud_id)
         VALUES (:enrollmentId, :horas, :naturaleza, :fechaHoras, 'MANUAL', :concepto, :descripcion, :userId, :solicitudId)
         RETURNING id`,
        {
          enrollmentId,
          horas: input.horas,
          naturaleza: input.naturaleza ?? naturaleza,
          fechaHoras: input.fechaHoras,
          concepto: input.concepto,
          descripcion: `Asignación manual registrada por ${ctx.actor}`,
          userId: ctx.userId,
          solicitudId,
        },
        t,
      );

      return { profile: await fetchProfile(studentId, t), movementId: movement!.id, replayed: false };
    }, ctx.actor);
  },

  /**
   * Revoca un movimiento MANUAL del estudiante. Los importados del CSS son
   * inmutables desde aquí (403): se corrigen con una nueva importación.
   * Si la participación del proyecto interno queda sin movimientos, se elimina
   * también (la creó la asignación manual y ya no representa nada). Las
   * participaciones de proyectos reales se conservan aunque queden en 0 h.
   * Los triggers de auditoría registran ambos DELETE con el actor del token.
   */
  async deleteManualMovement(
    studentId: string,
    movementId: string,
    ctx: { actor: string },
  ): Promise<{ profile: StudentProfileDTO; deletedEnrollment: boolean }> {
    return withTransaction(async (t) => {
      // Mismo candado que addManualHours: serializa operaciones sobre el estudiante.
      const student = await selectOne<{ id: string }>(
        'SELECT id FROM students WHERE id = :studentId FOR UPDATE',
        { studentId },
        t,
      );
      if (!student) throw AppError.notFound('Estudiante no encontrado');

      const movement = await selectOne<{ id: string; origen: HourOrigin; enrollment_id: string; es_sistema: boolean }>(
        `SELECT hm.id, hm.origen, hm.enrollment_id, (p.atributos ? 'sistema') AS es_sistema
         FROM hour_movements hm
         JOIN project_enrollments pe ON pe.id = hm.enrollment_id
         JOIN projects p             ON p.id = pe.project_id
         WHERE hm.id = :movementId AND pe.student_id = :studentId
         FOR UPDATE OF hm, pe`,
        { movementId, studentId },
        t,
      );
      // Mismo 404 si no existe o es de otro estudiante: no se revela cuál de los dos.
      if (!movement) throw AppError.notFound('Movimiento de horas no encontrado para este estudiante');
      if (movement.origen !== 'MANUAL') {
        throw AppError.forbidden(
          'Los movimientos importados del CSS no se pueden eliminar manualmente. Corríjalos con una nueva importación.',
        );
      }

      await execReturning('DELETE FROM hour_movements WHERE id = :movementId RETURNING id', { movementId }, t);

      let deletedEnrollment = false;
      if (movement.es_sistema) {
        const removed = await execReturning<{ id: string }>(
          `DELETE FROM project_enrollments pe
           WHERE pe.id = :enrollmentId
             AND NOT EXISTS (SELECT 1 FROM hour_movements hm WHERE hm.enrollment_id = pe.id)
           RETURNING pe.id`,
          { enrollmentId: movement.enrollment_id },
          t,
        );
        deletedEnrollment = removed.length > 0;
      }

      return { profile: await fetchProfile(studentId, t), deletedEnrollment };
    }, ctx.actor);
  },
};
