/**
 * ETL histórico — fase Extract + Load a `staging`.
 *
 *   pnpm etl:staging:init                 → (re)crea el esquema staging (BORRA lo que haya)
 *   pnpm etl:staging:load [--data-dir d]  → extrae data/ y reemplaza el contenido de staging
 *   pnpm etl:staging:load --dry-run       → solo extrae y muestra el resumen (no toca la BD)
 *   pnpm etl:staging:drop                 → elimina el esquema staging (tras el corte final)
 *
 * El resumen concilia lo extraído contra los totales impresos en cada reporte.
 * Una diferencia significa que el extractor perdió o duplicó filas: no transforme hasta resolverla.
 */
import path from 'node:path';
import { sequelize } from '../core/config/database.js';
import { extractAll } from './extract/index.js';
import { dropStagingSchema, initStagingSchema, loadStaging } from './load/staging-loader.js';
import { EtlError, LayoutError, type ExtractionResult } from './types.js';

function toInt(value: string | null | undefined): number | null {
  return value != null && /^\d+$/.test(value) ? Number(value) : null;
}

function check(actual: number, expected: number | null): string {
  if (expected === null) return `${actual} (sin total)`;
  return actual === expected ? `${actual} ✔` : `${actual} ✖ (reporte: ${expected})`;
}

/** Devuelve la cantidad de discrepancias encontradas. */
function printSummary(result: ExtractionResult): number {
  let mismatches = 0;
  const total = (archivo: string, alcance: string, metrica: string): number | null =>
    toInt(result.controlTotals.find((t) => t.archivo === archivo && t.alcance === alcance && t.metrica === metrica)?.valor);

  const summary = result.files.map((file) => {
    if (file.tipo === 'PDF_DETALLE_HORAS') {
      const rows = result.pdfRows.filter((r) => r.archivo === file.archivo);
      const horas = rows.reduce((sum, r) => sum + (toInt(r.horasAsignadas) ?? 0), 0);
      const expectedRows = total(file.archivo, 'ARCHIVO', 'ALUMNOS');
      const expectedHoras = total(file.archivo, 'ARCHIVO', 'HORAS');
      if (rows.length !== expectedRows || horas !== expectedHoras) mismatches++;

      // Totales impresos al pie de cada bloque "PROYECTO:".
      for (const t of result.controlTotals.filter((c) => c.archivo === file.archivo && c.alcance === 'PROYECTO')) {
        const blockRows = rows.filter((r) => r.bloque === t.bloque);
        const actual =
          t.metrica === 'HORAS'
            ? blockRows.reduce((sum, r) => sum + (toInt(r.horasAsignadas) ?? 0), 0)
            : blockRows.length;
        if (actual !== toInt(t.valor)) {
          mismatches++;
          console.warn(`  ✖ ${file.archivo} bloque ${t.bloque} (correlativo ${t.clave}) ${t.metrica}: ${actual} (reporte: ${t.valor})`);
        }
      }
      return {
        archivo: file.archivo,
        periodo: `${file.periodoDesde ?? '?'} – ${file.periodoHasta ?? '?'}`,
        filas: check(rows.length, expectedRows),
        'horas/alumnos': check(horas, expectedHoras),
        advertencias: rows.filter((r) => r.advertencias.length > 0).length,
      };
    }
    const rows = result.xlsRows.filter((r) => r.archivo === file.archivo);
    const alumnos = rows.reduce((sum, r) => sum + (toInt(r.alumnos) ?? 0), 0);
    const expectedRows = total(file.archivo, 'ARCHIVO', 'PROYECTOS');
    const expectedAlumnos = total(file.archivo, 'ARCHIVO', 'ALUMNOS');
    if (rows.length !== expectedRows || alumnos !== expectedAlumnos) mismatches++;

    // Subtotales por área.
    for (const area of result.controlTotals.filter((t) => t.archivo === file.archivo && t.alcance === 'AREA')) {
      const areaRows = rows.filter((r) => r.area === area.clave);
      const actual =
        area.metrica === 'PROYECTOS'
          ? areaRows.length
          : areaRows.reduce((sum, r) => sum + (toInt(r.alumnos) ?? 0), 0);
      if (actual !== toInt(area.valor)) {
        mismatches++;
        console.warn(`  ✖ ${file.archivo} área "${area.clave}" ${area.metrica}: ${actual} (reporte: ${area.valor})`);
      }
    }
    return {
      archivo: file.archivo,
      periodo: '—',
      filas: check(rows.length, expectedRows),
      'horas/alumnos': check(alumnos, expectedAlumnos),
      advertencias: rows.filter((r) => r.advertencias.length > 0).length,
    };
  });

  console.table(summary);

  const warningCounts = new Map<string, number>();
  for (const row of [...result.pdfRows, ...result.xlsRows]) {
    for (const warning of row.advertencias) {
      warningCounts.set(warning, (warningCounts.get(warning) ?? 0) + 1);
    }
  }
  if (warningCounts.size > 0) {
    console.log('Advertencias por tipo (informativas; se guardan en la columna `advertencias`):');
    console.table(Object.fromEntries([...warningCounts].sort((a, b) => b[1] - a[1])));
  }

  if (result.unparsed.length > 0) {
    console.warn(`⚠ ${result.unparsed.length} línea(s) sin clasificar (staging.unparsed_lines):`);
    for (const line of result.unparsed.slice(0, 20)) {
      console.warn(`  ${line.archivo} ${line.ubicacion} [${line.motivo}] ${line.texto}`);
    }
  }

  return mismatches + result.unparsed.length;
}

async function main(): Promise<void> {
  const [command = 'load', ...args] = process.argv.slice(2);

  switch (command) {
    case 'init':
      await initStagingSchema();
      console.log('✔ Esquema "staging" creado (vacío).');
      return;

    case 'drop':
      await dropStagingSchema();
      console.log('✔ Esquema "staging" eliminado.');
      return;

    case 'load': {
      const dirFlag = args.indexOf('--data-dir');
      const dataDir = path.resolve(process.cwd(), dirFlag >= 0 ? (args[dirFlag + 1] ?? '') : 'data');
      const dryRun = args.includes('--dry-run');

      console.log(`Extrayendo desde ${dataDir} ...`);
      const result = await extractAll({
        dataDir,
        onSkip: (file) => console.warn(`  • omitido (formato no reconocido): ${file}`),
      });
      if (result.files.length === 0) throw new EtlError(`No se encontraron PDFs ni Excel en ${dataDir}`);

      const problems = printSummary(result);

      if (dryRun) {
        console.log('✔ Dry-run: no se escribió nada en la base de datos.');
      } else {
        await loadStaging(result);
        console.log(
          `✔ Staging cargado: ${result.files.length} archivos, ${result.pdfRows.length} filas PDF, ` +
            `${result.xlsRows.length} filas Excel, ${result.controlTotals.length} totales de control.`,
        );
      }
      if (problems > 0) {
        console.warn(`⚠ ${problems} problema(s) de conciliación o líneas sin clasificar: revíselos antes de transformar.`);
        process.exitCode = 2;
      }
      return;
    }

    default:
      throw new EtlError(`Comando desconocido "${command}". Use: init | load [--data-dir d] [--dry-run] | drop`);
  }
}

main()
  .catch((error: unknown) => {
    if (error instanceof LayoutError) console.error(`\n✖ Formato inesperado: ${error.message}\n`);
    else if (error instanceof EtlError) console.error(`\n✖ ${error.message}\n`);
    else console.error('\n✖ Error en el ETL de staging:', error);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close().catch(() => undefined));
