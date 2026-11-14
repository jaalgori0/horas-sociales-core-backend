/**
 * Registros que producen los extractores y que el cargador inserta en el esquema `staging`.
 * Todos los campos de datos son `string | null` en bruto: la interpretación se hace en SQL.
 */

export type SourceFileType = 'PDF_DETALLE_HORAS' | 'XLS_MEMORIA_LABORES';

export interface SourceFileRecord {
  archivo: string;
  tipo: SourceFileType;
  sha256: string;
  paginas: number | null;
  titulo: string | null;
  periodoDesde: string | null;
  periodoHasta: string | null;
  generadoEn: string | null;
}

export interface PdfHourRow {
  archivo: string;
  pagina: number;
  linea: number;
  bloque: number | null;
  proyectoNombre: string | null;
  correlativo: string | null;
  carnet: string | null;
  nombreCompleto: string | null;
  fechaInicio: string | null;
  fechaFin: string | null;
  codInstitucion: string | null;
  institucion: string | null;
  carrera: string | null;
  horasAsignadas: string | null;
  estado: string | null;
  textoOriginal: string;
  advertencias: string[];
}

export interface XlsProjectRow {
  archivo: string;
  hoja: string;
  filaExcel: number;
  area: string | null;
  codInstitucion: string | null;
  institucion: string | null;
  correlativo: string | null;
  proyectoNombre: string | null;
  alumnos: string | null;
  fechaInicio: string | null;
  fechaFin: string | null;
  advertencias: string[];
}

export interface ControlTotal {
  archivo: string;
  ubicacion: string;
  alcance: 'PROYECTO' | 'AREA' | 'ARCHIVO';
  /** PDF, alcance PROYECTO: mismo `bloque` que las filas que totaliza. */
  bloque: number | null;
  clave: string | null;
  metrica: 'HORAS' | 'ALUMNOS' | 'PROYECTOS';
  valor: string | null;
}

export interface UnparsedLine {
  archivo: string;
  ubicacion: string;
  texto: string;
  motivo: string;
}

export interface ExtractionResult {
  files: SourceFileRecord[];
  pdfRows: PdfHourRow[];
  xlsRows: XlsProjectRow[];
  controlTotals: ControlTotal[];
  unparsed: UnparsedLine[];
}

/** Error esperado del ETL: se muestra solo el mensaje, sin stack. */
export class EtlError extends Error {
  override name = 'EtlError';
}

/** Error de formato: el archivo no tiene la estructura esperada y no es seguro seguir. */
export class LayoutError extends EtlError {
  override name = 'LayoutError';
}
