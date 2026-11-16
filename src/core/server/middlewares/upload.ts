/**
 * Recepción de archivos para la importación masiva (multipart/form-data).
 *
 * • memoryStorage: el archivo nunca toca el disco; llega como Buffer en `req.files`.
 * • Límites de memoria en dos niveles:
 *     - por archivo (IMPORT_MAX_FILE_MB) y cantidad (IMPORT_MAX_FILES): multer;
 *     - por request (IMPORT_MAX_TOTAL_MB): se exige Content-Length y se rechaza
 *       ANTES de leer el cuerpo. Node nunca lee más bytes que los declarados, así
 *       que el tope es real (los navegadores siempre envían Content-Length con FormData).
 * • El filtro por extensión es solo una primera barrera barata: el tipo real se
 *   confirma por firma de bytes en el servicio (ver detectSourceKind en etl/extract).
 * • Los errores de multer (tamaño, cantidad, campo inesperado) se traducen a JSON
 *   en el middleware global de errores.
 */
import path from 'node:path';
import type { RequestHandler } from 'express';
import multer from 'multer';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.xls', '.xlsx']);
const MB = 1024 * 1024;
/** Margen para cabeceras y separadores multipart sobre la suma de archivos. */
const MULTIPART_OVERHEAD_BYTES = 1 * MB;

/** Nombre del campo del formulario que trae los archivos. */
export const IMPORT_FILES_FIELD = 'files';

/**
 * Busboy entrega el nombre de archivo decodificado como latin1. Si los bytes
 * eran UTF-8 ("Diseño.pdf" → "DiseÃ±o.pdf") se recuperan; si no, se deja tal cual.
 * Se quitan los NUL: PostgreSQL no los acepta en `text`.
 */
export function decodeOriginalName(name: string): string {
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  return (utf8.includes('�') ? name : utf8).replace(/\u0000/g, '').normalize('NFC');
}

function tooLarge(): AppError {
  return new AppError(
    413,
    'PAYLOAD_TOO_LARGE',
    `El lote supera el tamaño máximo permitido (${env.IMPORT_MAX_TOTAL_MB} MB en total)`,
  );
}

/** Rechaza el request por tamaño total antes de que multer lea un solo byte. */
const enforceTotalSize: RequestHandler = (req, _res, next) => {
  const header = req.headers['content-length'];
  if (header === undefined) {
    next(new AppError(411, 'LENGTH_REQUIRED', 'La subida debe indicar su tamaño (Content-Length)'));
    return;
  }
  const declared = Number(header);
  if (!Number.isSafeInteger(declared) || declared < 0) {
    next(AppError.badRequest('Content-Length inválido'));
    return;
  }
  if (declared > env.IMPORT_MAX_TOTAL_MB * MB + MULTIPART_OVERHEAD_BYTES) {
    next(tooLarge());
    return;
  }
  next();
};

const receiveFiles = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.IMPORT_MAX_FILE_MB * MB,
    files: env.IMPORT_MAX_FILES,
    fields: 10,
    parts: env.IMPORT_MAX_FILES + 10,
  },
  fileFilter: (_req, file, callback) => {
    const name = decodeOriginalName(file.originalname);
    if (!ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase())) {
      callback(AppError.badRequest(`Tipo de archivo no permitido: "${name}". Solo PDF, XLS o XLSX.`));
      return;
    }
    callback(null, true);
  },
}).array(IMPORT_FILES_FIELD, env.IMPORT_MAX_FILES);

/** Segunda barrera: la suma real de los archivos recibidos. */
const checkReceivedTotal: RequestHandler = (req, _res, next) => {
  const files = Array.isArray(req.files) ? req.files : [];
  const total = files.reduce((sum, file) => sum + file.size, 0);
  next(total > env.IMPORT_MAX_TOTAL_MB * MB ? tooLarge() : undefined);
};

export const importUpload: RequestHandler[] = [enforceTotalSize, receiveFiles, checkReceivedTotal];
