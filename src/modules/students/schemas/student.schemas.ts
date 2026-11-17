/**
 * Contratos de entrada del módulo students (validación con Zod).
 * Las mismas reglas existen como CHECK en PostgreSQL: la BD es la última barrera,
 * Zod da mensajes claros al cliente antes de llegar a ella.
 */
import { z } from 'zod';
import { GENEROS } from '../models/student.model.js';

const trimmed = (max: number) => z.string().trim().min(1, 'Requerido').max(max);

const studentFields = {
  carnet: z.string().trim().regex(/^\d{8}$/, 'El carnet debe tener exactamente 8 dígitos'),
  nombres: trimmed(120),
  apellidos: trimmed(120),
  correoInstitucional: z
    .string()
    .trim()
    .toLowerCase()
    .email('Correo inválido')
    .regex(/@uca\.edu\.sv$/, 'Debe ser un correo institucional @uca.edu.sv'),
  emailPersonal: z.string().trim().toLowerCase().email('Correo inválido').nullish(),
  telefono: z
    .string()
    .trim()
    .regex(/^[0-9+\-\s]{8,20}$/, 'Teléfono inválido')
    .nullish(),
  genero: z.enum(GENEROS).nullish(),
  avatarUrl: z.string().trim().url('URL inválida').max(2048).nullish(),
  careerId: z.string().uuid('careerId debe ser un UUID'),
  dui: z
    .string()
    .trim()
    .regex(/^\d{8}-?\d$/, 'Formato de DUI inválido (00000000-0)')
    .nullish(),
  activo: z.boolean().optional(),
};

export const createStudentSchema = z.object(studentFields).strict();

export const updateStudentSchema = z
  .object(studentFields)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Envíe al menos un campo a actualizar' });

export const studentIdParamsSchema = z.object({
  id: z.string().uuid('El id debe ser un UUID'),
});

export const listStudentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().min(1).max(100).optional(),
  careerId: z.string().uuid().optional(),
  activo: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

export type CreateStudentInput = z.infer<typeof createStudentSchema>;
export type UpdateStudentInput = z.infer<typeof updateStudentSchema>;
export type ListStudentsQuery = z.infer<typeof listStudentsQuerySchema>;

// ─── Perfil y asignación manual de horas ─────────────────────────────────────

export const hourMovementParamsSchema = z.object({
  id: z.string().uuid('El id debe ser un UUID'),
  movementId: z.string().uuid('El id del movimiento debe ser un UUID'),
});

export const studentCarnetParamsSchema = z.object({
  carnet: z.string().trim().regex(/^\d{8}$/, 'El carnet debe tener exactamente 8 dígitos'),
});

/** Fecha de hoy en El Salvador (YYYY-MM-DD): no se registran horas a futuro. */
function todayInElSalvador(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/El_Salvador' }).format(new Date());
}

export const createManualHoursSchema = z
  .object({
    projectId: z.string().uuid('Seleccione un proyecto válido'),
    horas: z.coerce
      .number({ invalid_type_error: 'Las horas deben ser un número' })
      .int('Las horas deben ser un número entero')
      .min(1, 'Asigne al menos 1 hora')
      .max(600, 'No se pueden asignar más de 600 horas en un solo movimiento'),
    naturaleza: z.enum(['INTERNA', 'EXTERNA']).optional(),
    fechaHoras: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)')
      .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Fecha inválida')
      .refine((value) => value >= '2000-01-01', 'La fecha es demasiado antigua')
      .refine((value) => value <= todayInElSalvador(), 'La fecha no puede ser futura'),
    concepto: z
      .string()
      .trim()
      .min(5, 'Describa el concepto o motivo (mínimo 5 caracteres)')
      .max(500, 'El concepto no puede superar 500 caracteres'),
  })
  .strict();

/** Cabecera Idempotency-Key: opcional; el frontend envía un UUID por intento de envío. */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8, 'Idempotency-Key demasiado corta')
  .max(128, 'Idempotency-Key demasiado larga')
  .regex(/^[A-Za-z0-9._:-]+$/, 'Idempotency-Key inválida')
  .optional();

export type CreateManualHoursInput = z.infer<typeof createManualHoursSchema>;
