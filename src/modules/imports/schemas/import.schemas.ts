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
