/**
 * Middleware global de errores. Traduce errores de Zod, de dominio (AppError)
 * y de PostgreSQL/Sequelize a un formato JSON uniforme:
 *
 *   { "error": { "code": "...", "message": "...", "details": ... } }
 *
 * Nunca expone valores de la BD (p. ej. el detalle de una violación UNIQUE).
 */
import type { ErrorRequestHandler } from 'express';
import { DatabaseError, ForeignKeyConstraintError, UniqueConstraintError, ValidationError } from 'sequelize';
import { ZodError } from 'zod';
import { MulterError } from 'multer';
import { AppError } from '../../errors/app-error.js';
import { logger } from '../../logger.js';
import { env } from '../../config/env.js';

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

const MULTER_MESSAGES: Partial<Record<MulterError['code'], string>> = {
  LIMIT_FILE_SIZE: `Un archivo supera el tamaño máximo permitido (${env.IMPORT_MAX_FILE_MB} MB)`,
  LIMIT_FILE_COUNT: `Se enviaron demasiados archivos (máximo ${env.IMPORT_MAX_FILES})`,
  LIMIT_UNEXPECTED_FILE: 'Campo de archivo inesperado: envíe los archivos en el campo "files"',
  LIMIT_PART_COUNT: 'El formulario tiene demasiadas partes',
  LIMIT_FIELD_COUNT: 'El formulario tiene demasiados campos',
};

function pgCode(error: { parent?: unknown }): string | undefined {
  return (error.parent as { code?: string } | undefined)?.code;
}

function pgConstraint(error: { parent?: unknown }): string | undefined {
  return (error.parent as { constraint?: string } | undefined)?.constraint;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let body: ErrorBody = { code: 'INTERNAL_ERROR', message: 'Error interno del servidor' };

  if (err instanceof ZodError) {
    status = 400;
    body = {
      code: 'VALIDATION_ERROR',
      message: 'Los datos enviados no son válidos',
      details: err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    };
  } else if (err instanceof AppError) {
    status = err.statusCode;
    body = { code: err.code, message: err.message, details: err.details };
  } else if (err instanceof UniqueConstraintError) {
    status = 409;
    body = {
      code: 'UNIQUE_VIOLATION',
      message: 'Ya existe un registro con esos datos únicos',
      details: { fields: Object.keys(err.fields ?? {}), constraint: pgConstraint(err) },
    };
  } else if (err instanceof ForeignKeyConstraintError) {
    status = 409;
    body = {
      code: 'FOREIGN_KEY_VIOLATION',
      message: 'La operación viola una relación con otro registro',
      details: { constraint: pgConstraint(err) },
    };
  } else if (err instanceof DatabaseError && pgCode(err) === '23514') {
    status = 422;
    body = {
      code: 'CHECK_VIOLATION',
      message: err.message,
      details: { constraint: pgConstraint(err) },
    };
  } else if (err instanceof DatabaseError && pgCode(err) === '22P02') {
    status = 400;
    body = { code: 'INVALID_INPUT', message: 'Formato de dato inválido' };
  } else if (err instanceof ValidationError) {
    status = 422;
    body = {
      code: 'MODEL_VALIDATION_ERROR',
      message: 'Los datos no cumplen las reglas del modelo',
      details: err.errors.map((e) => ({ path: e.path, message: e.message })),
    };
  } else if (err instanceof MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    body = {
      code: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'INVALID_UPLOAD',
      message: MULTER_MESSAGES[err.code] ?? 'La carga de archivos no es válida',
      details: err.field ? { field: err.field } : undefined,
    };
  } else if ((err as { type?: string })?.type === 'entity.parse.failed') {
    status = 400;
    body = { code: 'INVALID_JSON', message: 'El cuerpo de la petición no es JSON válido' };
  }

  if (status >= 500) {
    logger.error(`${req.method} ${req.originalUrl} → ${status}`, err);
    if (!env.isProduction && err instanceof Error) {
      body.details = { name: err.name, message: err.message };
    }
  }

  res.status(status).json({ error: body });
};
