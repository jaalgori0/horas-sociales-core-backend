/**
 * Conciliación de una carpeta de reportes, SIN escribir nada (ni staging ni maestro).
 *
 *   pnpm etl:conciliar [--data-dir d] [--detalle]
 *
 * Compara las dos fuentes del CSS:
 *   • Excel «Memoria de Labores»: alumnos por proyecto (inscripciones, sin deduplicar
 *     estudiantes). Su total es la cifra oficial del reporte (p. ej. 914).
 *   • PDF «Detalle de Horas por Proyecto» (uno por carrera): una fila por inscripción.
 *
 * Y explica la diferencia: los PDF de cada carrera pueden usar otro correlativo para el
 * mismo proyecto, traer proyectos de años anteriores (filtran por la fecha del alumno)
 * o faltar carreras completas. Por eso se cruza por institución + nombre de proyecto.
 *
 * Si hay base de datos, además indica qué textos de carrera no resolvería la importación
 * (catálogo `careers` + `import_map_carreras`). Sin conexión, ese paso se omite.
 */
import path from 'node:path';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../core/config/database.js';
import { extractAll } from './extract/index.js';
import { EtlError, LayoutError, isHourDetailSource, type PdfHourRow } from './types.js';

const toInt = (v: string | null | undefined): number | null => (v != null && /^\d+$/.test(v) ? Number(v) : null);

/** Misma idea que fn_normalize_text + mojibake: compara nombres de proyecto entre fuentes. */
function claveNombre(cod: string | null, nombre: string | null): string {
  const n = (nombre ?? '')
    .replace(/Ã\?/g, '?')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9?]/g, '')
    .toUpperCase();
  return `${cod ?? ''}|${n}`;
}

const normalizeText = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();

async function carrerasNoResueltas(rows: PdfHourRow[]): Promise<Map<string, number> | null> {
  try {
    const catalogo = await sequelize.query<{ nombre: string }>('SELECT nombre_normalizado AS nombre FROM careers', {
      type: QueryTypes.SELECT,
    });
    const mapa = await sequelize.query<{ carrera_reporte: string }>('SELECT carrera_reporte FROM import_map_carreras', {
      type: QueryTypes.SELECT,
    });
    const nombres = new Set(catalogo.map((c) => c.nombre));
    const mapeadas = new Set(mapa.map((m) => m.carrera_reporte));
    const faltan = new Map<string, number>();
    for (const r of rows) {
      const texto = (r.carrera ?? '').replace(/\s*\(\s*(semi\s*-?\s*presencial|presencial|virtual)\s*\)/gi, '').trim();
      if (mapeadas.has(texto) || nombres.has(normalizeText(texto))) continue;
      faltan.set(texto || '(vacía)', (faltan.get(texto || '(vacía)') ?? 0) + 1);
    }
    return faltan;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dirFlag = args.indexOf('--data-dir');
  const dataDir = path.resolve(process.cwd(), dirFlag >= 0 ? (args[dirFlag + 1] ?? '') : 'data');
  const detalle = args.includes('--detalle');

  const result = await extractAll({ dataDir, onSkip: (f) => console.warn(`  • omitido: ${f}`) });
  if (result.files.length === 0) throw new EtlError(`No se encontraron PDFs ni Excel en ${dataDir}`);

  const total = (archivo: string, metrica: string) =>
    toInt(result.controlTotals.find((t) => t.archivo === archivo && t.alcance === 'ARCHIVO' && t.metrica === metrica)?.valor);

  // 1. Cada archivo contra sus propios totales impresos.
  console.log(`\n1) Cada archivo contra sus totales impresos (${dataDir})`);
  let problemas = 0;
  const porArchivo = result.files.map((f) => {
    if (isHourDetailSource(f.tipo)) {
      const rows = result.pdfRows.filter((r) => r.archivo === f.archivo);
      const horas = rows.reduce((s, r) => s + (toInt(r.horasAsignadas) ?? 0), 0);
      const invalidas = rows.filter((r) => toInt(r.horasAsignadas) === null).length;
      const ok = rows.length === total(f.archivo, 'ALUMNOS') && horas === total(f.archivo, 'HORAS') && invalidas === 0;
      if (!ok) problemas++;
      return { archivo: f.archivo, filas: rows.length, 'alumnos reporte': total(f.archivo, 'ALUMNOS'), horas,
        'horas reporte': total(f.archivo, 'HORAS'), 'horas no numéricas': invalidas, ok: ok ? '✔' : '✖' };
    }
    const rows = result.xlsRows.filter((r) => r.archivo === f.archivo);
    const alumnos = rows.reduce((s, r) => s + (toInt(r.alumnos) ?? 0), 0);
    const ok = rows.length === total(f.archivo, 'PROYECTOS') && alumnos === total(f.archivo, 'ALUMNOS');
    if (!ok) problemas++;
    return { archivo: f.archivo, filas: rows.length, 'alumnos reporte': total(f.archivo, 'ALUMNOS'), horas: null,
      'horas reporte': null, 'horas no numéricas': null, ok: ok ? '✔' : '✖' };
  });
  console.table(porArchivo);

  // 2. Totales: Excel (inscripciones) vs PDF (inscripciones), sin deduplicar.
  const pdf = result.pdfRows;
  const xls = result.xlsRows;
  const xlsAlumnos = xls.reduce((s, r) => s + (toInt(r.alumnos) ?? 0), 0);
  const contadas = pdf.filter((r) => r.estado !== 'Abandonado');
  console.log('\n2) Inscripciones (sin deduplicar estudiantes)');
  console.table({
    'Excel CSS (alumnos por proyecto)': { valor: xlsAlumnos },
    'PDF: filas (todas)': { valor: pdf.length },
    'PDF: sin Abandonado (lo que cuenta el dashboard)': { valor: contadas.length },
    'PDF: estudiantes únicos': { valor: new Set(pdf.map((r) => r.carnet)).size },
    'Diferencia Excel − PDF': { valor: xlsAlumnos - pdf.length },
  });

  // 3. Explicación de la diferencia, por institución + nombre de proyecto.
  if (xls.length > 0 && pdf.length > 0) {
    const enXls = new Map<string, { alumnos: number; nombre: string; correlativos: Set<string> }>();
    for (const r of xls) {
      const k = claveNombre(r.codInstitucion, r.proyectoNombre);
      const e = enXls.get(k) ?? { alumnos: 0, nombre: `${r.codInstitucion} · ${r.proyectoNombre}`, correlativos: new Set() };
      e.alumnos += toInt(r.alumnos) ?? 0;
      e.correlativos.add(r.correlativo ?? '?');
      enXls.set(k, e);
    }
    const enPdf = new Map<string, { filas: number; nombre: string; correlativos: Set<string> }>();
    for (const r of pdf) {
      const k = claveNombre(r.codInstitucion, r.proyectoNombre);
      const e = enPdf.get(k) ?? { filas: 0, nombre: `${r.codInstitucion} · ${r.proyectoNombre}`, correlativos: new Set() };
      e.filas += 1;
      e.correlativos.add(r.correlativo ?? '?');
      enPdf.set(k, e);
    }
    let faltanEnPdf = 0;
    let sobranEnPdf = 0;
    let soloPdf = 0;
    let correlativoDistinto = 0;
    const detalleRows: Array<Record<string, string | number>> = [];
    for (const [k, x] of enXls) {
      const p = enPdf.get(k);
      const filas = p?.filas ?? 0;
      if (p && [...p.correlativos].some((c) => !x.correlativos.has(c))) correlativoDistinto++;
      if (filas < x.alumnos) faltanEnPdf += x.alumnos - filas;
      if (filas > x.alumnos) sobranEnPdf += filas - x.alumnos;
      if (filas !== x.alumnos) detalleRows.push({ proyecto: x.nombre.slice(0, 70), excel: x.alumnos, pdf: filas });
    }
    for (const [k, p] of enPdf) {
      if (enXls.has(k)) continue;
      soloPdf += p.filas;
      detalleRows.push({ proyecto: p.nombre.slice(0, 70), excel: '—', pdf: p.filas });
    }
    console.log('\n3) De dónde sale la diferencia (cruce por institución + nombre de proyecto)');
    console.table({
      'Inscripciones del Excel sin fila en los PDF (carreras sin PDF, etc.)': { valor: faltanEnPdf },
      'Filas PDF de más en proyectos que sí están en el Excel': { valor: sobranEnPdf },
      'Filas PDF en proyectos que el Excel no trae (otros años/periodos)': { valor: soloPdf },
      'Neto (= Excel − PDF)': { valor: faltanEnPdf - sobranEnPdf - soloPdf },
      'Proyectos con correlativo distinto entre Excel y PDF': { valor: correlativoDistinto },
    });
    if (detalle) console.table(detalleRows);
    else console.log(`   (${detalleRows.length} proyectos con diferencia; use --detalle para listarlos)`);
  }

  // 4. Carreras que la importación no resolvería.
  const faltan = await carrerasNoResueltas(pdf);
  console.log('\n4) Carreras de los PDF sin coincidencia en el catálogo');
  if (faltan === null) console.log('   (sin conexión a la base de datos: se omite)');
  else if (faltan.size === 0) console.log('   ✔ Todas las carreras se resuelven.');
  else {
    problemas += faltan.size;
    console.table(Object.fromEntries([...faltan].map(([c, n]) => [c, { filas: n }])));
  }

  if (problemas > 0) {
    console.warn(`\n⚠ ${problemas} problema(s): revise las tablas marcadas con ✖ antes de importar.`);
    process.exitCode = 2;
  } else {
    console.log('\n✔ Cada archivo cuadra con sus totales y todas las carreras se resuelven.');
  }
}

main()
  .catch((error: unknown) => {
    if (error instanceof LayoutError) console.error(`\n✖ Formato inesperado: ${error.message}\n`);
    else if (error instanceof EtlError) console.error(`\n✖ ${error.message}\n`);
    else console.error('\n✖ Error en la conciliación:', error);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close().catch(() => undefined));
