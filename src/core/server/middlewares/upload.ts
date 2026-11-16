/**
 * Recepción de archivos para la importación masiva (multipart/form-data).
 *
 * • memoryStorage: el archivo nunca toca el disco; llega como Buffer en `req.files`.
 * • El filtro por extensión es solo una primera barrera barata: el tipo real se
 *   confirma por firma de bytes en el servicio (ver detectSourceKind en etl/extract).
 * • Los errores de multer (tamaño, cantidad, campo inesperado) se traducen a JSON
 *   en el middleware global de errores.
 */
import path from 'node:path';
import multer from 'multer';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.xls', '.xlsx']);

/** Nombre del campo del formulario que trae los archivos. */
export const IMPORT_FILES_FIELD = 'files';

/**
 * Busboy entrega el nombre de archivo decodificado como latin1. Si los bytes
 * eran UTF-8 ("Diseño.pdf" → "DiseÃ±o.pdf") se recuperan; si no, se deja tal cual.
 */
export function decodeOriginalName(name: string): string {
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  return (utf8.includes('�') ? name : utf8).normalize('NFC');
}

export const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.IMPORT_MAX_FILE_MB * 1024 * 1024,
    files: env.IMPORT_MAX_FILES,
    fields: 10,
    parts: env.IMPORT_MAX_FILES + 10,
  },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(decodeOriginalName(file.originalname)).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      callback(AppError.badRequest(`Tipo de archivo no permitido: "${file.originalname}". Solo PDF, XLS o XLSX.`));
      return;
    }
    callback(null, true);
  },
}).array(IMPORT_FILES_FIELD, env.IMPORT_MAX_FILES);
