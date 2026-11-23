/** Contratos de entrada de la importación masiva. */
import { z } from 'zod';
import { uuidParam } from '../../shared/schemas.js';
import { ITEM_ENTIDADES, ITEM_ESTADOS } from '../services/imports.service.js';

export const importIdParamsSchema = z.object({ id: uuidParam });

/** Filtros de ítems de la vista previa: ?estado=CONFLICTO&entidad=PARTICIPACION */
export const importItemsQuerySchema = z
  .object({
    estado: z.enum(ITEM_ESTADOS).optional(),
    entidad: z.enum(ITEM_ENTIDADES).optional(),
  })
  .strict();

export const listImportsQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();

// ─── Revisión en línea (migración 013) ───────────────────────────────────────

/** 'DD/MM/AAAA' que existe en el calendario (31/02 no pasa). '01/01/1900' = sin fecha. */
const fechaReporte = z
  .string()
  .regex(/^\d{2}\/\d{2}\/\d{4}$/, 'Use el formato DD/MM/AAAA')
  .refine((v) => {
    const [d, m, y] = v.split('/').map(Number) as [number, number, number];
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }, 'La fecha no existe');

const justificacion = z
  .string({ required_error: 'La justificación es obligatoria' })
  .trim()
  .min(5, 'La justificación debe tener al menos 5 caracteres')
  .max(500, 'La justificación admite hasta 500 caracteres');

/** Huella del lote que el usuario tiene en pantalla (detecta ediciones concurrentes). */
const huella = z.string({ required_error: 'Falta la huella del lote' }).min(1);

export const importRowParamsSchema = z.object({
  id: uuidParam,
  rowId: z.coerce.number().int().positive('rowId inválido'),
});

export const editRowBodySchema = z
  .object({
    huella,
    justificacion,
    /** Campo ausente: sin cambio. null: vuelve al valor del PDF. */
    cambios: z
      .object({
        estado: z.enum(['Activo', 'Finalizado', 'Abandonado']).nullable().optional(),
        horas: z.number().int().min(0).max(999_999).nullable().optional(),
        fechaInicio: fechaReporte
          .refine((v) => v !== '01/01/1900', 'La fecha de inicio es obligatoria')
          .nullable()
          .optional(),
        fechaFin: fechaReporte.nullable().optional(),
      })
      .strict()
      .refine((c) => Object.keys(c).length > 0, 'Indique al menos un campo a cambiar'),
  })
  .strict();

export const rowActionBodySchema = z.object({ huella, justificacion }).strict();

export const decisionBodySchema = z
  .object({
    huella,
    justificacion,
    clave: z.string().min(3),
    decision: z.enum(['ACEPTAR_REPORTE', 'CONSERVAR_BD']),
  })
  .strict();

export const projectLinkBodySchema = z
  .object({
    huella,
    justificacion,
    /** import_items.clave del proyecto: codigo/correlativo */
    clave: z.string().min(3),
    decision: z.enum(['VINCULAR', 'CREAR_NUEVO']),
    projectId: z.string().uuid('projectId debe ser un UUID').optional(),
  })
  .strict()
  .refine((b) => (b.decision === 'VINCULAR') === (b.projectId !== undefined), {
    message: 'VINCULAR exige projectId; CREAR_NUEVO no lo lleva',
    path: ['projectId'],
  });

/** POST /:id/confirm — la huella es opcional para no romper clientes anteriores. */
export const confirmBodySchema = z.object({ huella: z.string().min(1).optional() }).strict().default({});
