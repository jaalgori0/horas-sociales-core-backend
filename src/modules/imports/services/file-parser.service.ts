/**
 * Primera etapa de la importación: archivos subidos (en memoria) → filas en bruto.
 *
 * No toca la base de datos. Valida el lote (vacío, duplicados) y ejecuta los mismos
 * extractores que el ETL histórico. Un archivo con formato desconocido NO aborta
 * el lote: se informa como `rechazado` y los demás siguen.
 */
import { decodeOriginalName } from '../../../core/server/middlewares/upload.js';
import { AppError } from '../../../core/errors/app-error.js';
import { extractFile, sha256Hex, type FileExtraction } from '../../../etl/extract/index.js';
import { EtlError } from '../../../etl/types.js';
import { logger } from '../../../core/logger.js';

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

export type ParsedFile =
  | { estado: 'procesado'; archivo: string; sha256: string; bytes: number; extraction: FileExtraction }
  | { estado: 'rechazado'; archivo: string; sha256: string; bytes: number; motivo: string };

export async function parseUploadedFiles(files: readonly UploadedFile[]): Promise<ParsedFile[]> {
  if (files.length === 0) {
    throw AppError.badRequest('Adjunte al menos un archivo PDF o Excel en el campo "files".');
  }

  const seenNames = new Map<string, number>();
  const seenHashes = new Set<string>();
  const parsed: ParsedFile[] = [];

  for (const upload of files) {
    const sha256 = sha256Hex(upload.buffer);
    const bytes = upload.size;

    // Mismo nombre dos veces: se sufija para que (archivo, página, línea) siga siendo única.
    let archivo = decodeOriginalName(upload.originalname);
    const count = seenNames.get(archivo) ?? 0;
    seenNames.set(archivo, count + 1);
    if (count > 0) archivo = `${archivo} (${count + 1})`;

    if (seenHashes.has(sha256)) {
      parsed.push({ estado: 'rechazado', archivo, sha256, bytes, motivo: 'archivo_duplicado_en_lote' });
      continue;
    }
    seenHashes.add(sha256);

    try {
      parsed.push({ estado: 'procesado', archivo, sha256, bytes, extraction: await extractFile(archivo, upload.buffer) });
    } catch (error) {
      // EtlError: formato no reconocido (mensaje pensado para el usuario).
      // Otro error: archivo dañado que pdf.js/xlsx no pudo abrir; se registra y no aborta el lote.
      if (!(error instanceof EtlError)) logger.warn(`Importación: no se pudo leer "${archivo}"`, error);
      const motivo = error instanceof EtlError ? error.message : `${archivo}: el archivo está dañado o no se puede leer.`;
      parsed.push({ estado: 'rechazado', archivo, sha256, bytes, motivo });
    }
  }

  assertTemplatesWithoutTheirPdfs(parsed);
  return parsed;
}

/**
 * Una plantilla de revisión trae las mismas filas que los PDF de los que salió: subir ambos
 * en el mismo lote duplicaría cada participación. Se rechaza el lote completo (400) si un PDF
 * subido es uno de los de origen de una plantilla, por contenido (SHA-256, aunque se haya
 * renombrado) o por nombre (aunque se haya vuelto a exportar).
 */
function assertTemplatesWithoutTheirPdfs(parsed: readonly ParsedFile[]): void {
  const sameName = (a: string, b: string) => a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();
  const conflictos: Array<{ plantilla: string; pdfs: string[] }> = [];

  for (const file of parsed) {
    if (file.estado !== 'procesado' || !file.extraction.origenes?.length) continue;
    const origenes = file.extraction.origenes;
    const pdfs = parsed
      .filter((other) => other !== file)
      .filter((other) =>
        origenes.some(
          (o) =>
            (o.sha256 !== null && o.sha256 === other.sha256) ||
            (other.archivo.toLowerCase().endsWith('.pdf') && sameName(o.archivo, other.archivo)),
        ),
      )
      .map((other) => other.archivo);
    if (pdfs.length > 0) conflictos.push({ plantilla: file.archivo, pdfs });
  }

  if (conflictos.length > 0) {
    const detalle = conflictos.map((c) => `«${c.plantilla}» salió de ${c.pdfs.map((p) => `«${p}»`).join(', ')}`).join('; ');
    throw new AppError(
      400,
      'PLANTILLA_CON_SU_PDF',
      `No suba la plantilla de revisión junto con los PDF de los que salió: las filas se duplicarían (${detalle}). ` +
        'Quite esos PDF del lote y vuelva a analizar.',
      { conflictos },
    );
  }
}
