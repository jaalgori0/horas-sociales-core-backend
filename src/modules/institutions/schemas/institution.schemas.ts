/**
 * Contratos de entrada de instituciones. Los nombres de campo siguen a
 * `UpdateInstitutionPayload` / `CreateInstitutionPayload` del frontend
 * (incluido `image_url` en snake_case). `tipo` es texto libre y se traduce
 * al catálogo de la BD con institutionTipoFromUI().
 */
import { z } from 'zod';
import { imageSchema, optionalText, requiredText, uuidParam } from '../../shared/schemas.js';

/** Mismo formato que el CHECK de 008 (y que students.telefono). '' → null. */
const telefono = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value))
  .pipe(
    z
      .string()
      .regex(/^[0-9+\-\s]{8,20}$/, 'Teléfono inválido: use de 8 a 20 dígitos, espacios, + o -')
      .nullable(),
  )
  .nullish();

const contactoEmail = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => (value === '' ? null : value))
  .pipe(z.string().max(254).email('Correo de contacto inválido').nullable())
  .nullish();

const institutionFields = {
  nombre: requiredText(200),
  sigla: optionalText(60),
  tipo: optionalText(80),
  ubicacion: optionalText(200),
  direccion: optionalText(300),
  descripcion: optionalText(4000),
  contactoNombre: optionalText(200),
  contactoEmail,
  telefono,
  image_url: imageSchema,
  /** Alias aceptado por comodidad. */
  image: imageSchema,
  /** Confirma aunque exista una institución con nombre equivalente (409 INSTITUCION_SIMILAR). */
  confirmarSimilar: z.boolean().optional(),
};

export const createInstitutionSchema = z.object(institutionFields).strict();

export const updateInstitutionSchema = z
  .object(institutionFields)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Envíe al menos un campo a actualizar' });

export const institutionIdParamsSchema = z.object({ id: uuidParam });

export const listInstitutionsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  type: z.string().trim().max(80).optional(),
  sortBy: z.enum(['nombre-asc', 'nombre-desc']).default('nombre-asc'),
});

export type CreateInstitutionInput = z.infer<typeof createInstitutionSchema>;
export type UpdateInstitutionInput = z.infer<typeof updateInstitutionSchema>;
export type ListInstitutionsQuery = z.infer<typeof listInstitutionsQuerySchema>;
