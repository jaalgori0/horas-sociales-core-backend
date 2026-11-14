/**
 * Recorre la carpeta de fuentes y despacha cada archivo a su extractor.
 * El resultado es determinista (archivos en orden alfabético) para que dos corridas
 * sobre los mismos archivos produzcan exactamente las mismas filas de staging.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { LayoutError, type ExtractionResult } from '../types.js';
import { extractPdfHoursReport } from './pdf-hours-report.js';
import { extractXlsMemoriaLabores } from './xls-memoria-labores.js';

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

  const result: ExtractionResult = { files: [], pdfRows: [], xlsRows: [], controlTotals: [], unparsed: [] };

  for (const name of entries) {
    const extension = path.extname(name).toLowerCase();
    if (extension !== '.pdf' && extension !== '.xls' && extension !== '.xlsx') {
      onSkip?.(name);
      continue;
    }

    const buffer = await readFile(path.join(dataDir, name));
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    // NFC: "Diseño.pdf" puede llegar descompuesto (n + ◌̃) según el sistema de archivos.
    const archivo = name.normalize('NFC');
    const data = new Uint8Array(buffer);

    if (extension === '.pdf') {
      const extraction = await extractPdfHoursReport(archivo, data);
      if (extraction.file.titulo === null) {
        throw new LayoutError(`${archivo}: no parece un reporte "Detalle de Horas por Proyecto" (sin título).`);
      }
      result.files.push({ ...extraction.file, sha256 });
      result.pdfRows.push(...extraction.rows);
      result.controlTotals.push(...extraction.controlTotals);
      result.unparsed.push(...extraction.unparsed);
    } else {
      const extraction = extractXlsMemoriaLabores(archivo, data);
      if (extraction.file.titulo === null) {
        throw new LayoutError(`${archivo}: no parece un reporte "Memoria de Labores del CSS" (sin título).`);
      }
      result.files.push({ ...extraction.file, sha256 });
      result.xlsRows.push(...extraction.rows);
      result.controlTotals.push(...extraction.controlTotals);
      result.unparsed.push(...extraction.unparsed);
    }
  }

  return result;
}
