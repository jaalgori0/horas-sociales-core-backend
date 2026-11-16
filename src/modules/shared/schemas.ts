/** Piezas de validación Zod compartidas entre módulos. */
import { z } from 'zod';

/** Máximo de una imagen embebida (data URL base64). Debe caber en JSON_BODY_LIMIT. */
export const MAX_IMAGE_CHARS = 5_000_000;

/**
 * Imagen: el frontend envía data URLs (`data:image/png;base64,…`) generadas con
 * FileReader; también se admite una URL http(s). Cadena vacía → null.
 */
export const imageSchema = z
  .string()
  .trim()
  .max(MAX_IMAGE_CHARS, 'La imagen es demasiado grande (máx. ~3.5 MB)')
  .refine((value) => value === '' || /^data:image\/[a-z0-9.+-]+;base64,/i.test(value) || /^https?:\/\//i.test(value), {
    message: 'La imagen debe ser una data URL de imagen o una URL http(s)',
  })
  .transform((value) => (value === '' ? null : value))
  .nullish();

/** Texto opcional: recorta y convierte '' en null. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullish();

export const requiredText = (max: number) => z.string().trim().min(1, 'Requerido').max(max);

export const uuidParam = z.string().uuid('El id debe ser un UUID');

/** Fecha 'YYYY-MM-DD' (acepta también ISO completo y recorta). '' → null. */
export const isoDate = z
  .string()
  .trim()
  .transform((value) => value.slice(0, 10))
  .refine((value) => value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value), 'Fecha inválida (YYYY-MM-DD)')
  .transform((value) => (value === '' ? null : value))
  .nullish();
