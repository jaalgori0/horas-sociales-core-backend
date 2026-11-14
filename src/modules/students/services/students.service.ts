/**
 * Lógica de negocio de estudiantes. No conoce Express (ni req ni res):
 * recibe datos ya validados y devuelve DTOs o lanza AppError.
 */
import { ForeignKeyConstraintError, Op, QueryTypes, type WhereOptions } from 'sequelize';
import { sequelize } from '../../../core/config/database.js';
import { AppError } from '../../../core/errors/app-error.js';
import { encryptDui, hashDui } from '../../../core/security/crypto.js';
import { Career } from '../../careers/models/career.model.js';
import { Student, type Genero } from '../models/student.model.js';
import type { CreateStudentInput, ListStudentsQuery, UpdateStudentInput } from '../schemas/student.schemas.js';

export interface StudentDTO {
  id: string;
  carnet: string;
  /** null en históricos del CSS hasta que se completen (ver migración 002). */
  nombres: string | null;
  apellidos: string | null;
  nombreCompleto: string;
  correoInstitucional: string;
  emailPersonal: string | null;
  telefono: string | null;
  genero: Genero | null;
  avatarUrl: string | null;
  duiRegistrado: boolean;
  activo: boolean;
  career: { id: string; nombre: string | null; facultyId: string | null };
  createdAt: Date;
  updatedAt: Date;
}

export interface StudentHoursDTO {
  studentId: string;
  horasInternas: number;
  horasExternas: number;
  horasTotales: number;
  participaciones: number;
}

export interface Paginated<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

const CAREER_INCLUDE = { model: Career, as: 'career', attributes: ['id', 'nombre', 'facultyId'] };

function toDTO(student: Student): StudentDTO {
  return {
    id: student.id,
    carnet: student.carnet,
    nombres: student.nombres,
    apellidos: student.apellidos,
    nombreCompleto: student.nombreCompleto,
    correoInstitucional: student.correoInstitucional,
    emailPersonal: student.emailPersonal ?? null,
    telefono: student.telefono ?? null,
    genero: student.genero ?? null,
    avatarUrl: student.avatarUrl ?? null,
    duiRegistrado: student.duiHash != null,
    activo: student.activo,
    career: {
      id: student.careerId,
      nombre: student.career?.nombre ?? null,
      facultyId: student.career?.facultyId ?? null,
    },
    createdAt: student.createdAt,
    updatedAt: student.updatedAt,
  };
}

/** Elimina claves `undefined` para que Sequelize no las envíe como NULL. */
function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** Espejo en JS de fn_normalize_text() (SQL): minúsculas, sin tildes, espacios colapsados. */
function normalizeText(value: string): string {
  const from = 'ÁÉÍÓÚÜÑáéíóúüñ';
  const to = 'AEIOUUNaeiouun';
  return [...value.trim()]
    .map((char) => {
      const index = from.indexOf(char);
      return index === -1 ? char : to[index];
    })
    .join('')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Convierte el DUI en claro a sus dos representaciones protegidas. */
function protectDui(dui: string | null | undefined): { duiHash?: Buffer | null; duiCifrado?: Buffer | null } {
  if (dui === undefined) return {};
  if (dui === null) return { duiHash: null, duiCifrado: null };
  return { duiHash: hashDui(dui), duiCifrado: encryptDui(dui) };
}

async function assertCareerExists(careerId: string): Promise<void> {
  const career = await Career.findByPk(careerId, { attributes: ['id', 'activo'] });
  if (!career) throw AppError.unprocessable('La carrera indicada no existe', { field: 'careerId' });
  if (!career.activo) throw AppError.unprocessable('La carrera indicada está inactiva', { field: 'careerId' });
}

async function findOrFail(id: string): Promise<Student> {
  const student = await Student.findByPk(id, { include: [CAREER_INCLUDE] });
  if (!student) throw AppError.notFound('Estudiante no encontrado');
  return student;
}

export const studentsService = {
  async list(query: ListStudentsQuery): Promise<Paginated<StudentDTO>> {
    const conditions: WhereOptions<Student>[] = [];

    if (query.careerId) conditions.push({ careerId: query.careerId });
    if (query.activo !== undefined) conditions.push({ activo: query.activo });
    if (query.q) {
      // Búsqueda sin tildes ni mayúsculas: "lopez" encuentra "López".
      const term = `%${escapeLike(normalizeText(query.q))}%`;
      conditions.push({
        [Op.or]: [
          sequelize.where(sequelize.fn('fn_normalize_text', sequelize.col('Student.nombre_completo')), {
            [Op.like]: term,
          }),
          { carnet: { [Op.like]: term } },
          { correoInstitucional: { [Op.iLike]: term } },
        ],
      });
    }

    const { rows, count } = await Student.findAndCountAll({
      where: { [Op.and]: conditions },
      include: [CAREER_INCLUDE],
      order: [
        ['apellidos', 'ASC'],
        ['nombres', 'ASC'],
      ],
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
      distinct: true,
    });

    return {
      data: rows.map(toDTO),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total: count,
        totalPages: Math.ceil(count / query.pageSize),
      },
    };
  },

  async getById(id: string): Promise<StudentDTO> {
    return toDTO(await findOrFail(id));
  },

  async getHours(id: string): Promise<StudentHoursDTO> {
    const [row] = await sequelize.query<{
      horas_internas: number;
      horas_externas: number;
      horas_totales: number;
      participaciones: number;
    }>(
      `SELECT horas_internas, horas_externas, horas_totales, participaciones
         FROM v_student_hours
        WHERE student_id = :id`,
      { replacements: { id }, type: QueryTypes.SELECT },
    );
    if (!row) throw AppError.notFound('Estudiante no encontrado');

    return {
      studentId: id,
      horasInternas: row.horas_internas,
      horasExternas: row.horas_externas,
      horasTotales: row.horas_totales,
      participaciones: row.participaciones,
    };
  },

  async create(input: CreateStudentInput): Promise<StudentDTO> {
    const { dui, ...data } = input;
    await assertCareerExists(data.careerId);

    const created = await Student.create({
      ...compact(data),
      carnet: data.carnet,
      nombres: data.nombres,
      apellidos: data.apellidos,
      correoInstitucional: data.correoInstitucional,
      careerId: data.careerId,
      ...protectDui(dui),
    });

    return toDTO(await findOrFail(created.id));
  },

  async update(id: string, input: UpdateStudentInput): Promise<StudentDTO> {
    const student = await findOrFail(id);
    const { dui, ...data } = input;

    if (data.careerId && data.careerId !== student.careerId) {
      await assertCareerExists(data.careerId);
    }

    // Histórico del CSS (sin nombres/apellidos): se completan los dos a la vez o ninguno.
    if (student.nombres === null && (data.nombres === undefined) !== (data.apellidos === undefined)) {
      throw AppError.unprocessable(
        'Este estudiante proviene del histórico y aún no tiene nombres/apellidos separados: envíe ambos campos juntos.',
        { nombreCompleto: student.nombreCompleto },
      );
    }

    await student.update({ ...compact(data), ...protectDui(dui) });
    return toDTO(await findOrFail(id));
  },

  async remove(id: string): Promise<void> {
    const student = await findOrFail(id);
    try {
      await student.destroy();
    } catch (error) {
      if (error instanceof ForeignKeyConstraintError) {
        throw AppError.conflict(
          'El estudiante tiene citas o participaciones registradas y no puede eliminarse. Desactívelo con PATCH { "activo": false }.',
        );
      }
      throw error;
    }
  },
};
