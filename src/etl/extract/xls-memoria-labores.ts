/**
 * Extractor del Excel "Memoria de Labores del CSS" (ReporteEstadisticoCSS*.xls, hoja REP020).
 *
 * Es la exportación a Excel de un reporte paginado: celdas combinadas, una fila de datos
 * cada dos filas y todo almacenado como texto. Estructura observada:
 *
 *   fila  3  H: MEMORIA DE LABORES DEL CSS
 *   fila  7  D: <ÁREA>                         (p. ej. "EDUCACION")
 *   fila 10  C: INSTITUCION  N: PROYECTO  U: ALUMNOS  X: FECHA INICIO  AE: FECHA FIN
 *   fila 12  D: cod_inst  F: institución  N: correlativo  Q: proyecto  W: alumnos  Z: inicio  AF: fin
 *   ...
 *            O: <n proyectos del área>  T: <n alumnos del área>      (subtotal)
 *            B: 03/11/2026 3.30 PM   AA: "Página 1 de "  AH: 10       (pie)
 *            D: TOTAL GENERAL DE PROYECTOS  L: <n>
 *            D: TOTAL GENERAL DE ALUMNOS    L: <n>
 *
 * El texto trae mojibake irrecuperable ("ESPAÃ?A": el segundo byte UTF-8 ya es un '?'
 * literal). Se conserva tal cual y se marca con la advertencia `texto_con_mojibake`;
 * la reparación se hace en SQL cruzando contra los nombres limpios de los PDFs.
 *
 * Límites de lectura (protección del event loop): el rango `!ref` lo declara el propio
 * archivo y puede ser enorme (A1:XFD1048576 = 17 mil millones de celdas) aunque casi
 * todo esté vacío. Se leen como máximo MAX_ROWS filas (opción `sheetRows` de SheetJS,
 * que además evita materializar las celdas sobrantes) y MAX_COLS columnas. Si la hoja
 * declaraba más, queda una línea no reconocida `hoja_truncada` visible en la vista previa.
 */
import * as XLSX from 'xlsx';
import {
  LayoutError,
  type ControlTotal,
  type SourceFileRecord,
  type UnparsedLine,
  type XlsProjectRow,
} from '../types.js';

const HEADER: Readonly<Record<string, string>> = {
  C: 'INSTITUCION',
  N: 'PROYECTO',
  U: 'ALUMNOS',
  X: 'FECHA INICIO',
  AE: 'FECHA FIN',
};

const DATA_COLUMNS = {
  codInstitucion: 'D',
  institucion: 'F',
  correlativo: 'N',
  proyectoNombre: 'Q',
  alumnos: 'W',
  fechaInicio: 'Z',
  fechaFin: 'AF',
} as const;
const DATA_COLUMN_SET = new Set<string>(Object.values(DATA_COLUMNS));

const RE = {
  title: /^MEMORIA DE LABORES/i,
  footerDate: /^\d{2}\/\d{2}\/\d{4} \d{1,2}[.:]\d{2} [AP]M$/i,
  totalGeneral: /^TOTAL GENERAL DE (PROYECTOS|ALUMNOS)$/i,
  mojibake: /Ã.|Â|�/,
} as const;

/** El reporte real tiene unas pocas centenas de filas y usa hasta la columna AH (34). */
export const MAX_ROWS = 10_000;
export const MAX_COLS = 50;

export interface XlsExtraction {
  file: Omit<SourceFileRecord, 'sha256'>;
  rows: XlsProjectRow[];
  controlTotals: ControlTotal[];
  unparsed: UnparsedLine[];
}

/** Texto visible de la celda (respeta ceros a la izquierda si la celda tuviera formato). */
function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.v === undefined || cell.v === null) return '';
  // Sin NUL: PostgreSQL no los acepta en `text` y abortarían todo el lote.
  return (cell.w ?? String(cell.v)).replace(/\u0000/g, '').trim();
}

function sameKeys(cells: Map<string, string>, keys: string[]): boolean {
  return cells.size === keys.length && keys.every((key) => cells.has(key));
}

export function extractXlsMemoriaLabores(archivo: string, data: Uint8Array): XlsExtraction {
  const workbook = XLSX.read(data, { type: 'array', cellDates: false, cellText: true, sheetRows: MAX_ROWS });

  const file: XlsExtraction['file'] = {
    archivo,
    tipo: 'XLS_MEMORIA_LABORES',
    paginas: null,
    titulo: null,
    periodoDesde: null,
    periodoHasta: null,
    generadoEn: null,
  };
  const rows: XlsProjectRow[] = [];
  const controlTotals: ControlTotal[] = [];
  const unparsed: UnparsedLine[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]!;
    const hoja = sheetName.replace(/\u0000/g, '');
    if (!sheet['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!ref']);
    // `!fullref` solo existe si sheetRows recortó la hoja: es el rango que declaraba el archivo.
    const declared = XLSX.utils.decode_range(sheet['!fullref'] ?? sheet['!ref']);
    const lastRow = Math.min(range.e.r, range.s.r + MAX_ROWS - 1);
    const lastCol = Math.min(range.e.c, range.s.c + MAX_COLS - 1);
    if (declared.e.r > lastRow || declared.e.c > lastCol) {
      unparsed.push({
        archivo,
        ubicacion: `${hoja}!${XLSX.utils.encode_range({ s: range.s, e: { r: lastRow, c: lastCol } })}`,
        texto:
          `La hoja declara el rango ${XLSX.utils.encode_range(declared)}; solo se leyeron las primeras ` +
          `${MAX_ROWS} filas y ${MAX_COLS} columnas.`,
        motivo: 'hoja_truncada',
      });
    }
    let area: string | null = null;
    let headerSeen = false;

    for (let r = range.s.r; r <= lastRow; r++) {
      const filaExcel = r + 1;
      const ubicacion = `${hoja}!f${filaExcel}`;

      const cells = new Map<string, string>();
      for (let c = range.s.c; c <= lastCol; c++) {
        const text = cellText(sheet[XLSX.utils.encode_cell({ r, c })]);
        if (text !== '') cells.set(XLSX.utils.encode_col(c), text);
      }
      if (cells.size === 0) continue;

      const d = cells.get('D');
      const describe = (): string => [...cells].map(([col, text]) => `${col}=${text}`).join(' | ');

      // Título del reporte.
      if (cells.size === 1 && RE.title.test(cells.values().next().value!)) {
        file.titulo ??= cells.values().next().value!;
        continue;
      }

      // Cabecera de columnas: se valida su posición en cada sección.
      if (cells.get('C') === 'INSTITUCION') {
        const mismatch = Object.entries(HEADER).filter(([col, label]) => cells.get(col) !== label);
        if (mismatch.length > 0 || cells.size !== Object.keys(HEADER).length) {
          throw new LayoutError(
            `${archivo} ${ubicacion}: la cabecera no coincide con el formato esperado (${describe()}). ` +
              'Revise HEADER/DATA_COLUMNS en xls-memoria-labores.ts.',
          );
        }
        headerSeen = true;
        continue;
      }

      // Pie de página.
      const b = cells.get('B');
      if (b && RE.footerDate.test(b) && cells.get('AA')?.startsWith('Página')) {
        file.generadoEn ??= b;
        continue;
      }

      // Totales generales.
      const general = d ? RE.totalGeneral.exec(d) : null;
      if (general && sameKeys(cells, ['D', 'L'])) {
        controlTotals.push({
          archivo,
          ubicacion,
          alcance: 'ARCHIVO',
          bloque: null,
          clave: null,
          metrica: general[1]!.toUpperCase() as 'PROYECTOS' | 'ALUMNOS',
          valor: cells.get('L')!,
        });
        continue;
      }

      // Subtotal del área: O = proyectos, T = alumnos.
      if (sameKeys(cells, ['O', 'T'])) {
        controlTotals.push(
          { archivo, ubicacion, alcance: 'AREA', bloque: null, clave: area, metrica: 'PROYECTOS', valor: cells.get('O')! },
          { archivo, ubicacion, alcance: 'AREA', bloque: null, clave: area, metrica: 'ALUMNOS', valor: cells.get('T')! },
        );
        continue;
      }

      // Encabezado de área: única celda en D.
      if (sameKeys(cells, ['D'])) {
        area = d!;
        headerSeen = false;
        continue;
      }

      // Fila de datos.
      if (headerSeen && (cells.has(DATA_COLUMNS.proyectoNombre) || cells.has(DATA_COLUMNS.institucion))) {
        const get = (col: string): string | null => cells.get(col) ?? null;
        const row: XlsProjectRow = {
          archivo,
          hoja,
          filaExcel,
          area,
          codInstitucion: get(DATA_COLUMNS.codInstitucion),
          institucion: get(DATA_COLUMNS.institucion),
          correlativo: get(DATA_COLUMNS.correlativo),
          proyectoNombre: get(DATA_COLUMNS.proyectoNombre),
          alumnos: get(DATA_COLUMNS.alumnos),
          fechaInicio: get(DATA_COLUMNS.fechaInicio),
          fechaFin: get(DATA_COLUMNS.fechaFin),
          advertencias: [],
        };
        const extra = [...cells.keys()].filter((col) => !DATA_COLUMN_SET.has(col));
        if (extra.length > 0) row.advertencias.push(`celdas_fuera_de_columna:${extra.join(',')}`);
        const missing = Object.entries(DATA_COLUMNS)
          .filter(([, col]) => !cells.has(col))
          .map(([key]) => key);
        if (missing.length > 0) row.advertencias.push(`celdas_vacias:${missing.join(',')}`);
        if ([...cells.values()].some((text) => RE.mojibake.test(text))) row.advertencias.push('texto_con_mojibake');
        if (!area) row.advertencias.push('sin_area');
        rows.push(row);
        continue;
      }

      unparsed.push({
        archivo,
        ubicacion,
        texto: describe(),
        motivo: headerSeen ? 'fila_no_reconocida' : 'fila_antes_de_cabecera',
      });
    }
  }

  return { file, rows, controlTotals, unparsed };
}
