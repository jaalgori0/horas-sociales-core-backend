/**
 * Punto de entrada de la extracción. Dos consumidores comparten la misma lógica:
 *
 *  • `extractFile(nombre, bytes)`: un archivo en memoria → filas en bruto. Lo usa el
 *    módulo de importación (archivos subidos con multer) y el ETL por carpeta.
 *  • `extractAll({ dataDir })`: ETL histórico por CLI; lee la carpeta y fusiona.
 *
 * El tipo de archivo se decide por FIRMA DE BYTES, no por la extensión: un .xls
 * renombrado a .pdf (o un archivo cualquiera) se rechaza antes de llegar al parser.
 * El resultado es determinista para que dos corridas sobre los mismos archivos
 * produzcan exactamente las mismas filas de staging.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EtlError,
  LayoutError,
  type ControlTotal,
  type ExtractionResult,
  type PdfHourRow,
  type SourceFileRecord,
  type UnparsedLine,
  type XlsProjectRow,
} from '../types.js';
import { extractPdfHoursReport } from './pdf-hours-report.js';
import { extractXlsMemoriaLabores } from './xls-memoria-labores.js';

export type SourceKind = 'PDF' | 'XLS';

/** Resultado de extraer UN archivo: lo mismo que ExtractionResult, sin agregar. */
export interface FileExtraction {
  file: SourceFileRecord;
  pdfRows: PdfHourRow[];
  xlsRows: XlsProjectRow[];
  controlTotals: ControlTotal[];
  unparsed: UnparsedLine[];
}

const SIGNATURES: ReadonlyArray<[kind: SourceKind, bytes: readonly number[]]> = [
  ['PDF', [0x25, 0x50, 0x44, 0x46, 0x2d]], // %PDF-
  ['XLS', [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]], // OLE2 (.xls BIFF)
  ['XLS', [0x50, 0x4b, 0x03, 0x04]], // ZIP (.xlsx)
];

/** Tipo real del archivo según sus primeros bytes; null si no es PDF ni Excel. */
export function detectSourceKind(data: Uint8Array): SourceKind | null {
  for (const [kind, bytes] of SIGNATURES) {
    if (data.length >= bytes.length && bytes.every((byte, i) => data[i] === byte)) return kind;
  }
  return null;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Extrae un archivo en memoria. Lanza LayoutError si el contenido no es uno de los
 * reportes conocidos o si su formato cambió (no es seguro adivinar columnas).
 */
export async function extractFile(nombre: string, data: Uint8Array): Promise<FileExtraction> {
  // NFC: "Diseño.pdf" puede llegar descompuesto (n + ◌̃) según el sistema de archivos.
  const archivo = nombre.normalize('NFC');
  const kind = detectSourceKind(data);
  if (!kind) throw new EtlError(`${archivo}: el contenido no es un PDF ni un Excel válido.`);

  // El hash se calcula ANTES de parsear: pdf.js puede transferir (y vaciar) el buffer.
  const sha256 = sha256Hex(data);

  if (kind === 'PDF') {
    // Copia SOLO para pdf.js: puede transferir (desligar) el ArrayBuffer que recibe, y un
    // Buffer pequeño de Node comparte su ArrayBuffer con el pool interno. SheetJS solo lee,
    // así que el Excel se pasa sin copiar (un archivo de 15 MB ya no ocupa el doble).
    const extraction = await extractPdfHoursReport(archivo, new Uint8Array(data));
    if (extraction.file.titulo === null) {
      throw new LayoutError(`${archivo}: no parece un reporte "Detalle de Horas por Proyecto" (sin título).`);
    }
    return {
      file: { ...extraction.file, sha256 },
      pdfRows: extraction.rows,
      xlsRows: [],
      controlTotals: extraction.controlTotals,
      unparsed: extraction.unparsed,
    };
  }

  const extraction = extractXlsMemoriaLabores(archivo, data);
  if (extraction.file.titulo === null) {
    throw new LayoutError(`${archivo}: no parece un reporte "Memoria de Labores del CSS" (sin título).`);
  }
  return {
    file: { ...extraction.file, sha256 },
    pdfRows: [],
    xlsRows: extraction.rows,
    controlTotals: extraction.controlTotals,
    unparsed: extraction.unparsed,
  };
}

/** Fusiona extracciones de varios archivos en el formato que consume el cargador de staging. */
export function mergeExtractions(extractions: readonly FileExtraction[]): ExtractionResult {
  const result: ExtractionResult = { files: [], pdfRows: [], xlsRows: [], controlTotals: [], unparsed: [] };
  for (const extraction of extractions) {
    result.files.push(extraction.file);
    result.pdfRows.push(...extraction.pdfRows);
    result.xlsRows.push(...extraction.xlsRows);
    result.controlTotals.push(...extraction.controlTotals);
    result.unparsed.push(...extraction.unparsed);
  }
  return result;
}

export interface ExtractOptions {
  dataDir: string;
  /** Archivos presentes que no se reconocen; se informan pero no detienen la carga. */
  onSkip?: (file: string) => void;
}

export async function extractAll({ dataDir, onSkip }: ExtractOptions): Promise<ExtractionResult> {
  const entries = (await readdir(dataDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'es'));

  const extractions: FileExtraction[] = [];
  for (const name of entries) {
    const extension = path.extname(name).toLowerCase();
    if (extension !== '.pdf' && extension !== '.xls' && extension !== '.xlsx') {
      onSkip?.(name);
      continue;
    }
    extractions.push(await extractFile(name, await readFile(path.join(dataDir, name))));
  }
  return mergeExtractions(extractions);
}
