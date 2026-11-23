/**
 * Contratos de entrada de proyectos e inscripciones. Siguen a
 * CreateProjectPayload / UpdateProjectPayload / EnrollStudentPayload del
 * frontend. Los objetos NO son `.strict()`: el frontend envía campos que este
 * backend ignora (p. ej. `image` duplicado de `projectImage`).
 */
import { z } from 'zod';
import { PROJECT_CLASIFICACIONES } from '../../shared/labels.js';
import { imageSchema, isoDate, optionalText, requiredText, uuidParam } from '../../shared/schemas.js';

const clasificacion = z.enum(PROJECT_CLASIFICACIONES, {
  errorMap: () => ({ message: `Clasificación no válida (admitidas: ${PROJECT_CLASIFICACIONES.join(', ')})` }),
});

/** Al menos una; sin duplicados. Si se omite al crear, el proyecto queda como SS_EXTERNO. */
const clasificaciones = z
  .array(clasificacion)
  .min(1, 'Seleccione al menos una clasificación')
  .max(PROJECT_CLASIFICACIONES.length)
  .transform((values) => [...new Set(values)]);

const generoInput = z
  .enum(['Masculino', 'Femenino', 'HOMBRE', 'MUJER', ''])
  .transform((value) => (value === '' ? null : value))
  .nullish();

const carnet = z.string().trim().regex(/^\d{8}$/, 'El carnet debe tener exactamente 8 dígitos');

const email = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => (value === '' ? null : value))
  .pipe(z.string().email('Correo inválido').nullable())
  .nullish();

export const enrollStudentSchema = z.object({
  nombre: requiredText(250),
  carnet,
  /** Nombre de la carrera (como la envía el frontend) o, alternativamente, careerId. */
  carrera: optionalText(200),
  careerId: z.string().uuid().optional(),
  cargo: optionalText(80),
  activo: z.boolean().optional(),
  genero: generoInput,
  email,
});

export const updateEnrollmentSchema = z
  .object({
    nombre: requiredText(250),
    carnet,
    carrera: optionalText(200),
    careerId: z.string().uuid(),
    cargo: optionalText(80),
    genero: generoInput,
    email,
    estado: z.enum(['ASIGNADA', 'EN_CURSO', 'FINALIZADA', 'RETIRADA', 'CANCELADA']),
  })
  .partial();

const projectFields = {
  institutionId: z.union([z.string().uuid(), z.literal('')]).transform((v) => v || undefined).optional(),
  institutionName: optionalText(200),
  institutionType: optionalText(80),
  institutionLocation: optionalText(200),
  institutionDescription: optionalText(4000),
  institutionImage: imageSchema,
  /** Facultad por nombre (como la envía el frontend) o facultyId. */
  facultad: optionalText(200),
  facultyId: z.string().uuid().optional(),
  /** Carreras por nombre (como las envía el frontend) o careerIds. */
  carreras: z.array(z.string().trim().min(1)).max(50).optional(),
  careerIds: z.array(z.string().uuid()).max(50).optional(),
  titulo: requiredText(300),
  clasificaciones: clasificaciones.optional(),
  ubicacion: optionalText(300),
  descripcion: z.string().trim().max(10_000).optional(),
  resumen: optionalText(1000),
  fechaInicio: isoDate,
  fechaCierre: isoDate,
  cupos: z.coerce.number().int().positive('Los cupos deben ser mayores que 0').nullish(),
  personas: z.coerce.number().int().min(0).optional(),
  estado: z.string().trim().max(40).optional(),
  status: z.string().trim().max(40).optional(),
  projectImage: imageSchema,
  image: imageSchema,
  students: z.array(enrollStudentSchema).max(200).optional(),
  /**
   * Confirma que se crea/guarda aunque exista un proyecto (o institución) con un nombre
   * equivalente (nombre_clave) en la misma institución. Sin él, 409 PROYECTO_SIMILAR /
   * INSTITUCION_SIMILAR con la lista para elegir el existente.
   */
  confirmarSimilar: z.boolean().optional(),
};

export const createProjectSchema = z.object(projectFields);

export const updateProjectSchema = z
  .object(projectFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Envíe al menos un campo a actualizar' });

export const projectIdParamsSchema = z.object({ id: uuidParam });
export const enrollmentParamsSchema = z.object({ id: uuidParam, enrollmentId: uuidParam });

const ignoreAll = (all: string) =>
  z
    .string()
    .trim()
    .max(200)
    .transform((value) => (value === '' || value === all ? undefined : value))
    .optional();

export const listProjectsQuerySchema = z.object({
  search: ignoreAll(''),
  status: ignoreAll('Todos'),
  location: ignoreAll('Todas'),
  faculty: ignoreAll('Todas las facultades'),
  /** Una o varias (?clasificacion=SS_INTERNO,PROFESIONALIZANTE): proyectos que tengan ALGUNA de ellas. */
  clasificacion: z
    .string()
    .trim()
    .max(200)
    .transform((value) => value.split(',').map((v) => v.trim()).filter(Boolean))
    .pipe(z.array(clasificacion))
    .transform((values) => (values.length > 0 ? values : undefined))
    .optional(),
  institutionId: z.string().uuid('institutionId debe ser un UUID').optional(),
});

export type EnrollStudentInput = z.infer<typeof enrollStudentSchema>;
export type UpdateEnrollmentInput = z.infer<typeof updateEnrollmentSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;
