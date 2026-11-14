/**
 * Extractor de los PDFs "Detalle de Horas por Proyecto" (uno por carrera).
 *
 * Estructura observada (página apaisada 842×595, generada por un motor de reportes):
 *
 *   Detalle de Horas por Proyecto
 *   PERIODO DEL 01/01/2026 AL 03/11/2026
 *   PROYECTO: <nombre>                 CORRELATIVO: <n>
 *   FECHA  FECHA                                  HORAS            ┐
 *   CARNE NOMBRE COMPLETO  COD. NOMBRE INSTITUCION CARRERA ESTADO  │ cabecera (3 líneas)
 *          INICIO FIN                             ASIGNDAS         ┘
 *   00126026 BOLAÑOS, MEJIA NATHALY PAOLA 18/03/2026 26/05/2026 1772 FUNDAGONDRA ... 302 Finalizado
 *                                                   <continuación de celdas largas>
 *   TOTAL DE HORAS ASIGNADAS POR PROYECTO  302
 *   TOTAL DE ALUMNOS EN PROYECTO  1
 *   ...
 *   TOTAL GENERAL DE HORAS ASIGNADAS POR PROYECTO  <n>      (última página)
 *   TOTAL DE ALUMNOS EN PROYECTOS  <n>
 *   03/11/2026 9.49 AM                      Página 1 de 3   (pie)
 *
 * Particularidades que este extractor resuelve:
 *  • pdf.js a veces fusiona en un solo fragmento texto de dos columnas
 *    ("00126026 BOLAÑOS, ..." o "DE ANTIGUO CUSCATLAN INGENIERIA DE ALIMENTOS").
 *    Por eso las celdas se asignan por coordenada X y no por fragmento.
 *  • Las celdas largas continúan en líneas siguientes (nombre, institución, estado).
 *  • Un proyecto puede seguir en la página siguiente sin repetir "PROYECTO:".
 */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  LayoutError,
  type ControlTotal,
  type PdfHourRow,
  type SourceFileRecord,
  type UnparsedLine,
} from '../types.js';

type CellKey =
  | 'carnet'
  | 'nombreCompleto'
  | 'fechaInicio'
  | 'fechaFin'
  | 'codInstitucion'
  | 'institucion'
  | 'carrera'
  | 'horasAsignadas'
  | 'estado';

interface ColumnSpec {
  key: CellKey;
  /** Un fragmento pertenece a esta columna si empieza en x >= start (y antes de la siguiente). */
  start: number;
  /** X donde suele empezar el texto de la columna; guía para dividir fragmentos fusionados. */
  anchor: number;
  /** Separador al unir líneas de continuación ("Abandonad" + "o" no lleva espacio). */
  joiner: string;
}

/** Posiciones medidas sobre los 9 PDFs. Se validan contra la cabecera de cada página. */
const COLUMNS: readonly ColumnSpec[] = [
  { key: 'carnet', start: 0, anchor: 35, joiner: ' ' },
  { key: 'nombreCompleto', start: 64, anchor: 72, joiner: ' ' },
  { key: 'fechaInicio', start: 240, anchor: 248, joiner: ' ' },
  { key: 'fechaFin', start: 296, anchor: 302, joiner: ' ' },
  { key: 'codInstitucion', start: 346, anchor: 354, joiner: ' ' },
  { key: 'institucion', start: 382, anchor: 386, joiner: ' ' },
  { key: 'carrera', start: 570, anchor: 575, joiner: ' ' },
  { key: 'horasAsignadas', start: 690, anchor: 705, joiner: ' ' },
  // El estado es una sola palabra; si no cabe se corta a mitad ("Abandonad" / "o").
  { key: 'estado', start: 762, anchor: 770, joiner: '' },
];

/** Etiquetas de la línea de cabecera "CARNE ..." y su X esperada. */
const HEADER_LABELS: ReadonlyArray<[label: string, x: number]> = [
  ['CARNE', 35],
  ['NOMBRE COMPLETO', 72],
  ['COD.', 354],
  ['NOMBRE INSTITUCION', 386],
  ['CARRERA', 575],
  ['ESTADO', 768],
];
const HEADER_TOLERANCE = 4;

/** Fragmentos con |Δy| <= esto forman la misma línea visual (las celdas multilínea suben ~1pt). */
const SAME_LINE_TOLERANCE = 2.5;
/** Distancia vertical máxima entre una fila y su línea de continuación (observado: ~8pt; entre filas: >=13pt). */
const CONTINUATION_MAX_GAP = 11;

const RE = {
  title: /^Detalle de Horas por Proyecto$/i,
  periodo: /^PERIODO DEL (\S+) AL (\S+)$/i,
  footer: /^(\d{2}\/\d{2}\/\d{4} \d{1,2}[.:]\d{2} [AP]M) Página (\d+) de (\d+)$/i,
  headerTop: /^FECHA FECHA HORAS$/i,
  headerMain: /^CARNE NOMBRE COMPLETO\b/i,
  headerBottom: /^INICIO FIN ASIGN?A?DAS$/i,
  proyecto: /^PROYECTO:\s*(.*?)\s*CORRELATIVO:\s*(\S*)$/i,
  totalHorasProyecto: /^TOTAL DE HORAS ASIGNADAS POR PROYECTO\s+(\S+)$/i,
  totalAlumnosProyecto: /^TOTAL DE ALUMNOS EN PROYECTO\s+(\S+)$/i,
  totalHorasGeneral: /^TOTAL GENERAL DE HORAS ASIGNADAS POR PROYECTO\s+(\S+)$/i,
  totalAlumnosGeneral: /^TOTAL DE ALUMNOS EN PROYECTOS\s+(\S+)$/i,
  carnet: /^\d{8}$/,
} as const;

interface Fragment {
  str: string;
  x: number;
  y: number;
  width: number;
}

interface VisualLine {
  y: number;
  fragments: Fragment[];
  text: string;
}

interface CellPiece {
  column: number;
  text: string;
  /** true si salió de dividir un fragmento fusionado (posición estimada). */
  estimated: boolean;
}

export interface PdfExtraction {
  file: Omit<SourceFileRecord, 'sha256'>;
  rows: PdfHourRow[];
  controlTotals: ControlTotal[];
  unparsed: UnparsedLine[];
}

function columnIndexAt(x: number): number {
  for (let i = COLUMNS.length - 1; i >= 0; i--) {
    if (x >= COLUMNS[i]!.start) return i;
  }
  return 0;
}

/**
 * Asigna un fragmento a una o varias columnas. Si el fragmento cruza el inicio de la
 * columna siguiente, se corta en el espacio cuyo inicio de palabra estimado
 * (ancho proporcional por carácter) queda más cerca del `anchor` de esa columna.
 */
function splitFragment(fragment: Fragment): CellPiece[] {
  const charWidth = fragment.str.length > 0 ? fragment.width / fragment.str.length : 0;
  const end = fragment.x + fragment.width;
  const pieces: CellPiece[] = [];

  let column = columnIndexAt(fragment.x);
  let rest = fragment.str;
  let restX = fragment.x;
  let estimated = false;

  for (let next = column + 1; next < COLUMNS.length; next++) {
    const spec = COLUMNS[next]!;
    // Solo hay fusión si el fragmento invade el lugar donde EMPIEZA el texto de la columna
    // vecina (anchor). Rozar su límite `start` no basta: "...SAN ANTONIO" termina en x=572,
    // pasado el start de CARRERA (570) pero antes de su texto (575), y es todo institución.
    if (spec.start <= restX || end <= spec.anchor + 2) continue;

    let bestSpace = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let k = 0; k < rest.length; k++) {
      if (rest[k] !== ' ') continue;
      const distance = Math.abs(restX + (k + 1) * charWidth - spec.anchor);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestSpace = k;
      }
    }
    if (bestSpace < 0) break; // una sola palabra que invade la columna: se deja donde empieza

    pieces.push({ column, text: rest.slice(0, bestSpace).trim(), estimated });
    restX += (bestSpace + 1) * charWidth;
    rest = rest.slice(bestSpace + 1);
    column = next;
    estimated = true;
  }

  pieces.push({ column, text: rest.trim(), estimated });

  // "00126026 BOLAÑOS, ..." : el corte carnet|nombre es exacto por formato (8 dígitos), no estimado.
  const [first, second] = pieces;
  if (first?.column === 0 && second?.column === 1 && RE.carnet.test(first.text)) second.estimated = false;

  return pieces.filter((piece) => piece.text !== '');
}

function groupIntoLines(fragments: Fragment[]): VisualLine[] {
  const sorted = [...fragments].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: VisualLine[] = [];
  for (const fragment of sorted) {
    const current = lines.at(-1);
    if (current && current.y - fragment.y <= SAME_LINE_TOLERANCE) {
      current.fragments.push(fragment);
    } else {
      lines.push({ y: fragment.y, fragments: [fragment], text: '' });
    }
  }
  for (const line of lines) {
    line.fragments.sort((a, b) => a.x - b.x);
    line.text = line.fragments
      .map((fragment) => fragment.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return lines;
}

function assertHeader(line: VisualLine, archivo: string, pagina: number): void {
  for (const [label, expectedX] of HEADER_LABELS) {
    const fragment = line.fragments.find((f) => f.str.trim().toUpperCase() === label);
    if (!fragment || Math.abs(fragment.x - expectedX) > HEADER_TOLERANCE) {
      throw new LayoutError(
        `${archivo} p${pagina}: la columna "${label}" no está donde se esperaba (x≈${expectedX}, ` +
          `encontrada ${fragment ? `x=${fragment.x.toFixed(1)}` : 'ausente'}). ` +
          'El formato del reporte cambió: revise COLUMNS en pdf-hours-report.ts.',
      );
    }
  }
}

function emptyCells(): Record<CellKey, string | null> {
  return {
    carnet: null,
    nombreCompleto: null,
    fechaInicio: null,
    fechaFin: null,
    codInstitucion: null,
    institucion: null,
    carrera: null,
    horasAsignadas: null,
    estado: null,
  };
}

interface RowBuilder {
  row: PdfHourRow;
  /** Columnas que ya recibieron una línea de continuación (para advertir una sola vez). */
  multiline: Set<CellKey>;
  lines: string[];
  lastY: number;
  lastPage: number;
}

function appendPieces(builder: RowBuilder, pieces: CellPiece[], isContinuation: boolean): void {
  for (const piece of pieces) {
    const spec = COLUMNS[piece.column]!;
    const previous = builder.row[spec.key];
    builder.row[spec.key] = previous ? `${previous}${spec.joiner}${piece.text}` : piece.text;
    if (piece.estimated) builder.row.advertencias.push(`celda_dividida_por_posicion:${spec.key}`);
    if (isContinuation && !builder.multiline.has(spec.key)) {
      builder.multiline.add(spec.key);
      builder.row.advertencias.push(`celda_multilinea:${spec.key}`);
    }
  }
}

function finalizeRow(builder: RowBuilder): PdfHourRow {
  const { row } = builder;
  row.textoOriginal = builder.lines.join(' | ');
  if (!row.carnet || !RE.carnet.test(row.carnet)) row.advertencias.push('carnet_formato_inesperado');
  if (!row.correlativo) row.advertencias.push('sin_proyecto');
  row.advertencias = [...new Set(row.advertencias)];
  return row;
}

export async function extractPdfHoursReport(archivo: string, data: Uint8Array): Promise<PdfExtraction> {
  const document = await getDocument({ data, verbosity: 0, isEvalSupported: false }).promise;

  const file: PdfExtraction['file'] = {
    archivo,
    tipo: 'PDF_DETALLE_HORAS',
    paginas: document.numPages,
    titulo: null,
    periodoDesde: null,
    periodoHasta: null,
    generadoEn: null,
  };
  const rows: PdfHourRow[] = [];
  const controlTotals: ControlTotal[] = [];
  const unparsed: UnparsedLine[] = [];

  // Se arrastran entre páginas: un proyecto (y hasta una fila) puede continuar en la
  // página siguiente, que entonces NO repite título, "PROYECTO:" ni cabecera.
  let proyectoNombre: string | null = null;
  let correlativo: string | null = null;
  /** Ordinal del bloque "PROYECTO:" en el archivo; el correlativo solo NO es único (p. ej. dos "1" seguidos). */
  let bloque: number | null = null;
  let headerSeen = false;
  let current: RowBuilder | null = null;

  const closeRow = (): void => {
    if (current) rows.push(finalizeRow(current));
    current = null;
  };

  try {
    for (let pagina = 1; pagina <= document.numPages; pagina++) {
      const page = await document.getPage(pagina);
      const content = await page.getTextContent();
      const fragments: Fragment[] = [];
      for (const item of content.items) {
        if (!('str' in item) || item.str.trim() === '') continue;
        fragments.push({ str: item.str, x: item.transform[4], y: item.transform[5], width: item.width });
      }

      const lines = groupIntoLines(fragments);
      const ubicacion = `p${pagina}`;
      /** Pasa a true con la primera línea con contenido propio de esta página. */
      let pageHasContent = false;

      for (const [index, line] of lines.entries()) {
        const { text } = line;
        let match: RegExpMatchArray | null;

        if (RE.title.test(text)) {
          file.titulo ??= text;
          continue;
        }
        if ((match = text.match(RE.periodo))) {
          file.periodoDesde ??= match[1]!;
          file.periodoHasta ??= match[2]!;
          continue;
        }
        if ((match = text.match(RE.footer))) {
          file.generadoEn ??= match[1]!;
          continue; // la fila abierta puede continuar en la página siguiente
        }
        if (RE.headerTop.test(text) || RE.headerBottom.test(text)) continue;
        if (RE.headerMain.test(text)) {
          assertHeader(line, archivo, pagina);
          headerSeen = true;
          continue;
        }
        if ((match = text.match(RE.proyecto))) {
          closeRow();
          proyectoNombre = match[1]! || null;
          correlativo = match[2]! || null;
          bloque = (bloque ?? 0) + 1;
          continue;
        }
        const total = (alcance: 'PROYECTO' | 'ARCHIVO', metrica: 'HORAS' | 'ALUMNOS', valor: string): void => {
          closeRow();
          controlTotals.push(
            alcance === 'PROYECTO'
              ? { archivo, ubicacion, alcance, bloque, clave: correlativo, metrica, valor }
              : { archivo, ubicacion, alcance, bloque: null, clave: null, metrica, valor },
          );
        };
        if ((match = text.match(RE.totalHorasGeneral))) {
          total('ARCHIVO', 'HORAS', match[1]!);
          continue;
        }
        if ((match = text.match(RE.totalAlumnosGeneral))) {
          total('ARCHIVO', 'ALUMNOS', match[1]!);
          continue;
        }
        if ((match = text.match(RE.totalHorasProyecto))) {
          total('PROYECTO', 'HORAS', match[1]!);
          continue;
        }
        if ((match = text.match(RE.totalAlumnosProyecto))) {
          total('PROYECTO', 'ALUMNOS', match[1]!);
          continue;
        }

        const pieces = line.fragments.flatMap(splitFragment);
        const startsInCarnetColumn = line.fragments[0]!.x < COLUMNS[1]!.start;

        // Continuación de celdas largas de la fila anterior: justo debajo en la misma
        // página, o primeras líneas de la página siguiente si la fila quedó cortada.
        const open = current as RowBuilder | null;
        if (open && !startsInCarnetColumn) {
          const sameBlock = open.lastPage === pagina && open.lastY - line.y <= CONTINUATION_MAX_GAP;
          const pageBreak = open.lastPage === pagina - 1 && !pageHasContent;
          if (sameBlock || pageBreak) {
            appendPieces(open, pieces, true);
            if (pageBreak) open.row.advertencias.push('fila_cortada_entre_paginas');
            open.lines.push(text);
            open.lastY = line.y;
            open.lastPage = pagina;
            continue;
          }
        }

        pageHasContent = true;

        // Fila de datos: empieza en la columna CARNE (después de una cabecera válida).
        if (startsInCarnetColumn && headerSeen) {
          closeRow();
          const builder: RowBuilder = {
            row: {
              archivo,
              pagina,
              linea: index + 1,
              bloque,
              proyectoNombre,
              correlativo,
              ...emptyCells(),
              textoOriginal: '',
              advertencias: [],
            },
            multiline: new Set(),
            lines: [text],
            lastY: line.y,
            lastPage: pagina,
          };
          appendPieces(builder, pieces, false);
          current = builder;
          continue;
        }

        closeRow();
        unparsed.push({
          archivo,
          ubicacion: `${ubicacion} l${index + 1}`,
          texto: text,
          motivo: headerSeen ? 'linea_no_reconocida' : 'linea_antes_de_cabecera',
        });
      }
      page.cleanup();
    }
    closeRow();
  } finally {
    await document.destroy();
  }

  return { file, rows, controlTotals, unparsed };
}
