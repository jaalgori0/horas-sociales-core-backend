/**
 * Plantilla de revisión: PDF «Detalle de Horas por Proyecto» → Excel editable → importación.
 *
 * Los PDF son reportes paginados: una fila puede quedar cortada entre páginas, una celda
 * larga partida en varias líneas o dos columnas fusionadas. El extractor de PDF ya resuelve
 * la mayoría y marca las dudosas con advertencias; esta plantilla permite que una persona
 * las revise y corrija en Excel ANTES de importar.
 *
 *   buildReviewTemplate()   extracciones de PDF → .xlsx (lo descarga el usuario)
 *   isReviewTemplate()      ¿el Excel subido es una plantilla? (hoja oculta de control)
 *   extractReviewTemplate() .xlsx corregido → PdfHourRow[], igual que el PDF original
 *
 * Como la plantilla produce las mismas filas que el PDF, entra por el flujo normal:
 * clasificación, vista previa, conciliación y confirmación no cambian.
 *
 * Hojas:
 *   Instrucciones          cómo revisar (solo lectura).
 *   Participaciones        UNA fila por estudiante y proyecto: es lo que se importa.
 *   Control                totales IMPRESOS en cada PDF. Al importar, lo corregido debe
 *                          cuadrar con ellos (misma regla que el PDF): si falta o sobra una
 *                          fila, la confirmación se bloquea hasta corregirlo.
 *   Líneas no reconocidas  texto del PDF que el extractor no pudo ubicar: si es una
 *                          participación, se transcribe a «Participaciones».
 *   _plantilla             (oculta) marca, versión y PDF de origen (nombre + SHA-256): la
 *                          importación rechaza subir la plantilla junto con su propio PDF.
 *
 * Excel convierte "00126026" en el número 126026 y las fechas en números de serie: las
 * celdas se escriben como texto (formato "@") y, si aun así llegan como número, se
 * recuperan (ceros a la izquierda en el carnet, fecha DD/MM/AAAA) con una advertencia.
 */
import * as XLSX from 'xlsx';
import type { FileExtraction } from './index.js';
import { LayoutError, type ControlTotal, type PdfHourRow, type SourceFileRecord, type UnparsedLine } from '../types.js';

export const TEMPLATE_MARKER = 'HS_PLANTILLA_REVISION';
export const TEMPLATE_VERSION = 1;

const SHEETS = {
  instrucciones: 'Instrucciones',
  participaciones: 'Participaciones',
  control: 'Control',
  noReconocidas: 'Líneas no reconocidas',
  rechazados: 'Archivos no incluidos',
  marca: '_plantilla',
} as const;

/** Filas de la hoja oculta con cada PDF de origen: [ORIGEN_LABEL, archivo, sha256]. */
const ORIGEN_LABEL = 'origen_pdf';

/** Página ficticia de las filas de la plantilla: `linea` es la fila de Excel (clave "archivo p1 l<fila>"). */
const TEMPLATE_PAGE = 1;
/** Igual que el Excel del CSS: protección ante rangos declarados enormes. */
const MAX_ROWS = 20_000;

type DataKey =
  | 'correlativo'
  | 'proyectoNombre'
  | 'codInstitucion'
  | 'institucion'
  | 'carnet'
  | 'nombreCompleto'
  | 'carrera'
  | 'fechaInicio'
  | 'fechaFin'
  | 'horasAsignadas'
  | 'estado';
type RefKey = 'revisar' | 'archivoOrigen' | 'paginaOrigen' | 'lineaOrigen' | 'advertencias' | 'textoOriginal';

interface Column {
  key: DataKey | RefKey;
  header: string;
  width: number;
  /** Columna de referencia: se muestra para revisar, pero no se importa. */
  ref?: true;
}

const COLUMNS: readonly Column[] = [
  { key: 'revisar', header: 'Revisar', width: 9, ref: true },
  { key: 'archivoOrigen', header: 'Archivo PDF', width: 26, ref: true },
  { key: 'paginaOrigen', header: 'Página', width: 7, ref: true },
  { key: 'lineaOrigen', header: 'Línea', width: 6, ref: true },
  { key: 'correlativo', header: 'Correlativo', width: 11 },
  { key: 'proyectoNombre', header: 'Proyecto', width: 42 },
  { key: 'codInstitucion', header: 'Cód. institución', width: 15 },
  { key: 'institucion', header: 'Institución', width: 38 },
  { key: 'carnet', header: 'Carnet', width: 11 },
  { key: 'nombreCompleto', header: 'Nombre completo', width: 34 },
  { key: 'carrera', header: 'Carrera', width: 32 },
  { key: 'fechaInicio', header: 'Fecha inicio', width: 12 },
  { key: 'fechaFin', header: 'Fecha fin', width: 12 },
  { key: 'horasAsignadas', header: 'Horas asignadas', width: 15 },
  { key: 'estado', header: 'Estado', width: 12 },
  { key: 'advertencias', header: 'Advertencias de extracción', width: 40, ref: true },
  { key: 'textoOriginal', header: 'Texto original del PDF', width: 70, ref: true },
];

/**
 * Advertencias del extractor de PDF que piden mirar la fila (las mismas que la vista previa
 * muestra como ADVERTENCIA). `celda_multilinea` no cuenta: un nombre largo en dos líneas es
 * lo normal en el reporte y se une sin ambigüedad.
 */
export function needsReview(advertencias: readonly string[]): boolean {
  return advertencias.some(
    (w) =>
      w.startsWith('celda_dividida_por_posicion:') ||
      w === 'fila_cortada_entre_paginas' ||
      w === 'carnet_formato_inesperado' ||
      w === 'sin_proyecto',
  );
}

const CONTROL_HEADERS = [
  'Archivo PDF',
  'Periodo desde',
  'Periodo hasta',
  'Alumnos según el reporte',
  'Horas según el reporte',
  'Alumnos extraídos',
  'Horas extraídas',
] as const;
const CONTROL_TOTAL_LABEL = 'TOTAL';

const INSTRUCCIONES: readonly string[] = [
  'Plantilla de revisión — Detalle de Horas por Proyecto',
  '',
  'Esta hoja se generó a partir de los PDF del CSS. Sirve para revisar y corregir los datos antes de importarlos.',
  '',
  'Cómo usarla',
  '1. Revise la hoja «Participaciones». Hay una fila por estudiante y proyecto. Filtre la columna «Revisar» = Sí para ver primero las filas dudosas (filas cortadas entre páginas, celdas separadas por posición); la columna «Advertencias de extracción» dice qué detectó el sistema en cada una.',
  '2. Corrija los valores directamente en la celda. Compare con la columna «Texto original del PDF» y con el PDF (archivo, página y línea). Cuando termine con una fila, borre el «Sí» de «Revisar»: si lo deja, la vista previa la seguirá mostrando como advertencia.',
  '3. Si en «Líneas no reconocidas» hay una participación que falta, agréguela como fila nueva en «Participaciones».',
  '4. Guarde el archivo como .xlsx y súbalo en «Importar reportes» (puede subirlo junto con el Excel «Memoria de Labores»). Verá la vista previa antes de confirmar.',
  '',
  'Reglas',
  '• No suba esta plantilla junto con los PDF de los que salió: los datos se duplicarían en la vista previa.',
  '• Carnet: 8 dígitos (ej. 00126026). Fechas: DD/MM/AAAA. Horas: número entero. Estado: Activo, Finalizado o Abandonado.',
  '• Las columnas Revisar, Archivo PDF, Página, Línea, Advertencias y Texto original son solo de referencia: no se importan.',
  '• No cambie los nombres de las columnas ni de las hojas.',
  '• La hoja «Control» trae los totales impresos en cada PDF. Al importar, las filas de «Participaciones» deben sumar esos alumnos y horas; si no, la importación se bloquea. Si eliminó o agregó una fila a propósito (por ejemplo, un error del propio reporte), actualice ahí el total correspondiente.',
];

// ─── Escritura ────────────────────────────────────────────────────────────────

/** Celda de texto con formato "@": Excel la conserva como texto al editarla. */
function textCell(value: string | number | null | undefined): XLSX.CellObject {
  return { t: 's', v: value === null || value === undefined ? '' : String(value), z: '@' };
}

function numberCell(value: number | null): XLSX.CellObject {
  return value === null ? { t: 's', v: '' } : { t: 'n', v: value };
}

function sheetFromCells(rows: XLSX.CellObject[][], widths: number[]): XLSX.WorkSheet {
  const sheet: XLSX.WorkSheet = {};
  let maxCol = 0;
  rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      sheet[XLSX.utils.encode_cell({ r, c })] = cell;
      maxCol = Math.max(maxCol, c);
    });
  });
  sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length - 1, 0), c: maxCol } });
  sheet['!cols'] = widths.map((wch) => ({ wch }));
  return sheet;
}

function toInt(value: string | null | undefined): number | null {
  return value != null && /^\d+$/.test(value) ? Number(value) : null;
}

export interface ReviewTemplateInput {
  /** Solo extracciones de PDF «Detalle de Horas por Proyecto». */
  extractions: readonly FileExtraction[];
  /** Archivos subidos que no entraron (no son PDF del reporte, dañados...). */
  rechazados: ReadonlyArray<{ archivo: string; motivo: string }>;
  generadoEn: Date;
}

export function buildReviewTemplate({ extractions, rechazados, generadoEn }: ReviewTemplateInput): Buffer {
  const workbook = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    workbook,
    sheetFromCells(INSTRUCCIONES.map((line) => [textCell(line)]), [140]),
    SHEETS.instrucciones,
  );

  // Participaciones: mismo orden que el PDF (archivo, página, línea).
  const header = COLUMNS.map((col) => textCell(col.header));
  const dataRows = extractions.flatMap((ex) =>
    ex.pdfRows.map((row) =>
      COLUMNS.map((col): XLSX.CellObject => {
        switch (col.key) {
          case 'revisar':
            return textCell(needsReview(row.advertencias) ? 'Sí' : '');
          case 'archivoOrigen':
            return textCell(row.archivo);
          case 'paginaOrigen':
            return numberCell(row.pagina);
          case 'lineaOrigen':
            return numberCell(row.linea);
          case 'advertencias':
            return textCell(row.advertencias.join(', '));
          case 'textoOriginal':
            return textCell(row.textoOriginal);
          default:
            return textCell(row[col.key]);
        }
      }),
    ),
  );
  const participaciones = sheetFromCells([header, ...dataRows], COLUMNS.map((c) => c.width));
  participaciones['!autofilter'] = {
    ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: dataRows.length, c: COLUMNS.length - 1 } }),
  };
  XLSX.utils.book_append_sheet(workbook, participaciones, SHEETS.participaciones);

  // Control: totales impresos por PDF (los que se concilian al importar) y lo extraído.
  const archivoTotal = (ex: FileExtraction, metrica: ControlTotal['metrica']) =>
    toInt(ex.controlTotals.find((t) => t.alcance === 'ARCHIVO' && t.metrica === metrica)?.valor);
  const controlRows = extractions.map((ex) => {
    const horasExtraidas = ex.pdfRows.reduce((sum, r) => sum + (toInt(r.horasAsignadas) ?? 0), 0);
    return [
      textCell(ex.file.archivo),
      textCell(ex.file.periodoDesde),
      textCell(ex.file.periodoHasta),
      numberCell(archivoTotal(ex, 'ALUMNOS')),
      numberCell(archivoTotal(ex, 'HORAS')),
      numberCell(ex.pdfRows.length),
      numberCell(horasExtraidas),
    ];
  });
  const sumColumn = (c: number): number | null => {
    const values = controlRows.map((row) => (row[c]!.t === 'n' ? (row[c]!.v as number) : null));
    return values.some((v) => v === null) ? null : values.reduce<number>((a, b) => a + (b ?? 0), 0);
  };
  const totalRow = [textCell(CONTROL_TOTAL_LABEL), textCell(''), textCell(''), ...[3, 4, 5, 6].map((c) => numberCell(sumColumn(c)))];
  XLSX.utils.book_append_sheet(
    workbook,
    sheetFromCells([CONTROL_HEADERS.map((h) => textCell(h)), ...controlRows, totalRow], [30, 13, 13, 22, 22, 18, 16]),
    SHEETS.control,
  );

  const unparsed = extractions.flatMap((ex) => ex.unparsed);
  XLSX.utils.book_append_sheet(
    workbook,
    sheetFromCells(
      [
        ['Archivo PDF', 'Ubicación', 'Motivo', 'Texto'].map((h) => textCell(h)),
        ...unparsed.map((u) => [textCell(u.archivo), textCell(u.ubicacion), textCell(u.motivo), textCell(u.texto)]),
      ],
      [26, 14, 26, 100],
    ),
    SHEETS.noReconocidas,
  );

  if (rechazados.length > 0) {
    XLSX.utils.book_append_sheet(
      workbook,
      sheetFromCells(
        [['Archivo', 'Motivo'].map((h) => textCell(h)), ...rechazados.map((r) => [textCell(r.archivo), textCell(r.motivo)])],
        [36, 100],
      ),
      SHEETS.rechazados,
    );
  }

  XLSX.utils.book_append_sheet(
    workbook,
    sheetFromCells(
      [
        [textCell(TEMPLATE_MARKER), numberCell(TEMPLATE_VERSION)],
        [textCell('generado_en'), textCell(generadoEn.toISOString())],
        ...extractions.map((ex) => [textCell(ORIGEN_LABEL), textCell(ex.file.archivo), textCell(ex.file.sha256)]),
      ],
      [26, 30, 66],
    ),
    SHEETS.marca,
  );
  workbook.Workbook = { Sheets: workbook.SheetNames.map((name) => ({ name, Hidden: name === SHEETS.marca ? 1 : 0 })) };

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
}

// ─── Lectura ──────────────────────────────────────────────────────────────────

/** Barato: solo lee los nombres de las hojas. */
export function isReviewTemplate(data: Uint8Array): boolean {
  try {
    return XLSX.read(data, { type: 'array', bookSheets: true }).SheetNames.includes(SHEETS.marca);
  } catch {
    return false;
  }
}

/** Encabezados comparados sin tildes, mayúsculas ni espacios de más. */
function normalizeText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Texto en bruto de la celda; recupera lo que Excel convirtió a número. */
function readCell(cell: XLSX.CellObject | undefined, key: DataKey, warnings: string[]): string | null {
  if (!cell || cell.v === undefined || cell.v === null) return null;

  if (cell.t === 'n' && typeof cell.v === 'number') {
    if ((key === 'fechaInicio' || key === 'fechaFin') && (cell.z === undefined || XLSX.SSF.is_date(cell.z))) {
      const d = XLSX.SSF.parse_date_code(cell.v);
      if (d && d.y > 1900) {
        warnings.push(`fecha_leida_como_fecha_de_excel:${key}`);
        return `${pad2(d.d)}/${pad2(d.m)}/${d.y}`;
      }
    }
    return normalizeValue(String(cell.v), key, warnings);
  }
  const text = String(cell.w ?? cell.v).replace(/\u0000/g, '').trim();
  return text === '' ? null : normalizeValue(text, key, warnings);
}

function normalizeValue(text: string, key: DataKey, warnings: string[]): string {
  if (key === 'carnet' && /^\d{1,7}$/.test(text)) {
    warnings.push('carnet_completado_con_ceros');
    return text.padStart(8, '0');
  }
  if (key === 'fechaInicio' || key === 'fechaFin') {
    // "8/3/2026" → "08/03/2026"; "2026-03-08" → "08/03/2026". El SQL solo acepta DD/MM/AAAA.
    const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    if (dmy) return `${pad2(Number(dmy[1]))}/${pad2(Number(dmy[2]))}/${dmy[3]}`;
    const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(text);
    if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  }
  return text;
}

function cellString(sheet: XLSX.WorkSheet, r: number, c: number): string {
  const cell = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
  if (!cell || cell.v === undefined || cell.v === null) return '';
  return String(cell.w ?? cell.v).replace(/\u0000/g, '').trim();
}

function cellInt(sheet: XLSX.WorkSheet, r: number, c: number): number | null {
  const cell = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
  if (!cell || cell.v === undefined || cell.v === null || cell.v === '') return null;
  if (typeof cell.v === 'number') return Number.isInteger(cell.v) && cell.v >= 0 ? cell.v : null;
  return toInt(String(cell.v).trim());
}

/** Columna (índice) de cada encabezado, comparando sin tildes ni mayúsculas. */
function headerIndex(sheet: XLSX.WorkSheet, range: XLSX.Range): Map<string, number> {
  const index = new Map<string, number>();
  for (let c = range.s.c; c <= range.e.c; c++) {
    const text = cellString(sheet, range.s.r, c);
    if (text) index.set(normalizeText(text), c);
  }
  return index;
}

/** PDF del que salió la plantilla. `sha256` es null en una plantilla sin esa información. */
export interface TemplateOrigin {
  archivo: string;
  sha256: string | null;
}

export interface ReviewTemplateExtraction {
  file: Omit<SourceFileRecord, 'sha256'>;
  rows: PdfHourRow[];
  controlTotals: ControlTotal[];
  unparsed: UnparsedLine[];
  origenes: TemplateOrigin[];
}

export function extractReviewTemplate(archivo: string, data: Uint8Array): ReviewTemplateExtraction {
  const workbook = XLSX.read(data, { type: 'array', cellDates: false, cellNF: true, cellText: true, sheetRows: MAX_ROWS });

  const marca = workbook.Sheets[SHEETS.marca];
  if (!marca || cellString(marca, 0, 0) !== TEMPLATE_MARKER) {
    throw new LayoutError(`${archivo}: no es una plantilla de revisión válida (falta la hoja de control "${SHEETS.marca}").`);
  }
  const version = cellInt(marca, 0, 1);
  if (version !== TEMPLATE_VERSION) {
    throw new LayoutError(
      `${archivo}: la plantilla es de la versión ${version ?? '?'} y el sistema lee la versión ${TEMPLATE_VERSION}. Genérela de nuevo desde los PDF.`,
    );
  }

  const sheet = workbook.Sheets[SHEETS.participaciones];
  if (!sheet?.['!ref']) {
    throw new LayoutError(`${archivo}: falta la hoja "${SHEETS.participaciones}" o está vacía.`);
  }
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const headers = headerIndex(sheet, range);
  const position = new Map<Column['key'], number>();
  const faltantes: string[] = [];
  for (const col of COLUMNS) {
    const c = headers.get(normalizeText(col.header));
    if (c === undefined) {
      if (!col.ref) faltantes.push(col.header);
    } else {
      position.set(col.key, c);
    }
  }
  if (faltantes.length > 0) {
    throw new LayoutError(
      `${archivo}: a la hoja "${SHEETS.participaciones}" le faltan columnas (${faltantes.join(', ')}). No cambie los encabezados.`,
    );
  }

  const unparsed: UnparsedLine[] = [];
  const declared = XLSX.utils.decode_range(sheet['!fullref'] ?? sheet['!ref']);
  if (declared.e.r > range.e.r) {
    unparsed.push({
      archivo,
      ubicacion: SHEETS.participaciones,
      texto: `La hoja declara ${declared.e.r + 1} filas; solo se leyeron las primeras ${MAX_ROWS}.`,
      motivo: 'hoja_truncada',
    });
  }

  const rows: PdfHourRow[] = [];
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const warnings: string[] = [];
    const value = (key: DataKey) =>
      readCell(sheet[XLSX.utils.encode_cell({ r, c: position.get(key)! })] as XLSX.CellObject | undefined, key, warnings);
    const datos = {
      correlativo: value('correlativo'),
      proyectoNombre: value('proyectoNombre'),
      codInstitucion: value('codInstitucion'),
      institucion: value('institucion'),
      carnet: value('carnet'),
      nombreCompleto: value('nombreCompleto'),
      carrera: value('carrera'),
      fechaInicio: value('fechaInicio'),
      fechaFin: value('fechaFin'),
      horasAsignadas: value('horasAsignadas'),
      estado: value('estado'),
    };
    if (Object.values(datos).every((v) => v === null)) continue; // fila vacía

    const ref = (key: RefKey) => {
      const c = position.get(key);
      return c === undefined ? '' : cellString(sheet, r, c);
    };
    const fila = r + 1;
    // «Revisar» sigue en Sí: la fila no se dio por revisada y conserva los avisos del PDF
    // (la vista previa la muestra como ADVERTENCIA, igual que si se hubiera subido el PDF).
    if (ref('revisar')) {
      const heredadas = ref('advertencias').split(',').map((w) => w.trim()).filter(Boolean);
      warnings.push(...heredadas.filter((w) => needsReview([w])));
    }
    const origen = ref('archivoOrigen');
    const textoPdf = ref('textoOriginal');
    if (!origen) warnings.push('fila_agregada_en_revision');
    const procedencia = origen
      ? `origen ${origen} p.${ref('paginaOrigen') || '?'} l.${ref('lineaOrigen') || '?'}`
      : 'fila agregada en la revisión';

    rows.push({
      archivo,
      pagina: TEMPLATE_PAGE,
      linea: fila,
      bloque: null,
      ...datos,
      textoOriginal: `Fila ${fila} de «${SHEETS.participaciones}» · ${procedencia}${textoPdf ? ` · ${textoPdf}` : ''}`,
      advertencias: warnings,
    });
  }

  // Totales impresos en los PDF de origen (hoja Control): se concilian como los de un PDF.
  const controlTotals: ControlTotal[] = [];
  const control = workbook.Sheets[SHEETS.control];
  let periodoDesde: string | null = null;
  let periodoHasta: string | null = null;
  const controlNames: string[] = [];
  if (control?.['!ref']) {
    const cr = XLSX.utils.decode_range(control['!ref']);
    const ch = headerIndex(control, cr);
    const col = (h: (typeof CONTROL_HEADERS)[number]) => ch.get(normalizeText(h));
    const cAlumnos = col('Alumnos según el reporte');
    const cHoras = col('Horas según el reporte');
    const cDesde = col('Periodo desde');
    const cHasta = col('Periodo hasta');
    const alumnos: Array<number | null> = [];
    const horas: Array<number | null> = [];
    const desdes = new Set<string>();
    const hastas = new Set<string>();
    for (let r = cr.s.r + 1; r <= cr.e.r; r++) {
      const nombre = cellString(control, r, cr.s.c);
      if (!nombre || normalizeText(nombre) === normalizeText(CONTROL_TOTAL_LABEL)) continue;
      controlNames.push(nombre);
      alumnos.push(cAlumnos === undefined ? null : cellInt(control, r, cAlumnos));
      horas.push(cHoras === undefined ? null : cellInt(control, r, cHoras));
      if (cDesde !== undefined) desdes.add(cellString(control, r, cDesde));
      if (cHasta !== undefined) hastas.add(cellString(control, r, cHasta));
    }
    // Un total desconocido en cualquier PDF anula ese control (igual que un PDF sin pie de totales).
    const suma = (values: Array<number | null>) =>
      values.length > 0 && values.every((v) => v !== null) ? String(values.reduce<number>((a, b) => a + b!, 0)) : null;
    for (const [metrica, valor] of [['ALUMNOS', suma(alumnos)], ['HORAS', suma(horas)]] as const) {
      if (valor !== null) {
        controlTotals.push({ archivo, ubicacion: SHEETS.control, alcance: 'ARCHIVO', bloque: null, clave: null, metrica, valor });
      }
    }
    if (desdes.size === 1) periodoDesde = [...desdes][0] || null;
    if (hastas.size === 1) periodoHasta = [...hastas][0] || null;
  }
  if (controlTotals.length === 0) {
    unparsed.push({
      archivo,
      ubicacion: SHEETS.control,
      texto: 'La plantilla no trae los totales de los PDF de origen: no se puede comprobar que estén todas las filas.',
      motivo: 'sin_totales_de_control',
    });
  }

  // PDF de origen: los de la hoja oculta; si no están, los nombres de la hoja Control.
  const origenes: TemplateOrigin[] = [];
  if (marca['!ref']) {
    const mr = XLSX.utils.decode_range(marca['!ref']);
    for (let r = mr.s.r; r <= mr.e.r; r++) {
      if (cellString(marca, r, 0) !== ORIGEN_LABEL) continue;
      const nombre = cellString(marca, r, 1);
      const sha = cellString(marca, r, 2).toLowerCase();
      if (nombre) origenes.push({ archivo: nombre.normalize('NFC'), sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : null });
    }
  }
  if (origenes.length === 0) {
    for (const nombre of controlNames) origenes.push({ archivo: nombre.normalize('NFC'), sha256: null });
  }

  return {
    origenes,
    file: {
      archivo,
      tipo: 'XLSX_PLANTILLA_REVISION',
      paginas: null,
      titulo: 'Plantilla de revisión: Detalle de Horas por Proyecto',
      periodoDesde,
      periodoHasta,
      generadoEn: cellString(marca, 1, 1) || null,
    },
    rows,
    controlTotals,
    unparsed,
  };
}
