/**
 * Contratos de entrada de instituciones. Los nombres de campo siguen a
 * `UpdateInstitutionPayload` / `CreateInstitutionPayload` del frontend
 * (incluido `image_url` en snake_case). `tipo` es texto libre y se traduce
 * al catálogo de la BD con institutionTipoFromUI().
 */
import { z } from 'zod';
import { imageSchema, optionalText, requiredText, uuidParam } from '../../shared/schemas.js';

const institutionFields = {
  nombre: requiredText(200),
  sigla: optionalText(60),
  tipo: optionalText(80),
  ubicacion: optionalText(200),
  direccion: optionalText(300),
  descripcion: optionalText(4000),
  image_url: imageSchema,
  /** Alias aceptado por comodidad. */
  image: imageSchema,
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
