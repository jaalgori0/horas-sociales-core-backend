import { z } from 'zod';

const booleanFlag = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .default('false');

export const catalogIdParamsSchema = z.object({
  id: z.string().uuid('El id debe ser un UUID'),
});

export const listFacultiesQuerySchema = z.object({
  incluirInactivas: booleanFlag,
});

/** Acepta `facultyId` o `faculty_id` (el frontend usa snake_case en CareerResponse). */
export const listCareersQuerySchema = z
  .object({
    facultyId: z.string().uuid('facultyId debe ser un UUID').optional(),
    faculty_id: z.string().uuid('faculty_id debe ser un UUID').optional(),
    incluirInactivas: booleanFlag,
  })
  .transform(({ facultyId, faculty_id, incluirInactivas }) => ({
    facultyId: facultyId ?? faculty_id,
    incluirInactivas,
  }));

export type ListFacultiesQuery = z.infer<typeof listFacultiesQuerySchema>;
export type ListCareersQuery = z.infer<typeof listCareersQuerySchema>;
