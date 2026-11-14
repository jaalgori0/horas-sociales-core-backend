/**
 * ETL histórico — fase Transform + Load: staging → esquema maestro.
 *
 *   pnpm etl:transform            → valida, carga y confirma (COMMIT)
 *   pnpm etl:transform --dry-run  → ejecuta todo y muestra el informe, pero REVIERTE
 *
 * Todo corre en UNA transacción: o se carga completo o no se carga nada.
 * Las filas que no pasan validación quedan en staging.rechazos (no bloquean al resto).
 * Código de salida 2 si hubo rechazos o descuadres: revíselos antes de dar por buena la carga.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { QueryTypes, type Transaction } from 'sequelize';
import { sequelize } from '../core/config/database.js';
import { EtlError } from './types.js';

const SQL_FILE = path.resolve(process.cwd(), 'src/etl/sql/transform_load.sql');

class DryRunRollback extends Error {}

async function select<T extends object>(sql: string, transaction: Transaction): Promise<T[]> {
  return sequelize.query<T>(sql, { type: QueryTypes.SELECT, transaction });
}

async function assertPrerequisites(transaction: Transaction): Promise<void> {
  const [state] = await select<{ migracion_002: boolean; staging: boolean }>(
    `SELECT
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'correlativo_css') AS migracion_002,
       to_regclass('staging.pdf_hour_rows') IS NOT NULL AS staging`,
    transaction,
  );
  if (!state?.migracion_002) {
    throw new EtlError('Falta la migración 002_legacy_css_import_support.sql. Ejecute: pnpm db:migrate');
  }
  if (!state.staging) {
    throw new EtlError('No existe staging. Ejecute: pnpm etl:staging:init && pnpm etl:staging:load');
  }
  const [rows] = await select<{ n: string }>('SELECT count(*) AS n FROM staging.pdf_hour_rows', transaction);
  if (Number(rows?.n ?? 0) === 0) {
    throw new EtlError('staging.pdf_hour_rows está vacío. Ejecute: pnpm etl:staging:load');
  }
}

/** Informe posterior a la carga. Devuelve la cantidad de problemas (rechazos + descuadres). */
async function report(transaction: Transaction): Promise<number> {
  const rechazos = await select<{ origen: string; motivo: string; filas: string; ejemplo: string | null }>(
    `SELECT origen, motivo, count(*) AS filas, min(detalle) AS ejemplo
     FROM staging.rechazos GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
    transaction,
  );
  if (rechazos.length > 0) {
    console.warn('⚠ Filas en cuarentena (staging.rechazos), NO cargadas:');
    console.table(rechazos);
  } else {
    console.log('✔ Sin rechazos: todas las filas de staging pasaron la validación.');
  }

  // Conciliación: lo válido en staging vs lo que efectivamente quedó en el maestro.
  const conciliacion = await select<{ control: string; esperado: string; en_maestro: string }>(
    `WITH ok AS (SELECT * FROM staging.v_pdf_ok),
     enr AS (
       SELECT pe.id, ok.horas, ok.carnet, ok.cod_institucion, ok.correlativo
       FROM ok
       JOIN students s             ON s.carnet = ok.carnet
       JOIN institutions i         ON i.codigo_css = ok.cod_institucion
       JOIN projects p             ON p.institution_id = i.id AND p.correlativo_css = ok.correlativo
       JOIN project_enrollments pe ON pe.student_id = s.id AND pe.project_id = p.id
     )
     SELECT 'participaciones (filas PDF válidas)' AS control,
            (SELECT count(*) FROM ok) AS esperado, (SELECT count(*) FROM enr) AS en_maestro
     UNION ALL
     SELECT 'estudiantes (carnets distintos)',
            (SELECT count(DISTINCT carnet) FROM ok),
            (SELECT count(*) FROM students s WHERE s.carnet IN (SELECT carnet FROM ok))
     UNION ALL
     SELECT 'proyectos (PDF ∪ Excel)',
            (SELECT count(*) FROM (SELECT cod_institucion, correlativo FROM ok
                                   UNION SELECT cod_institucion, correlativo FROM staging.v_xls_ok) u),
            (SELECT count(*) FROM projects WHERE correlativo_css IS NOT NULL)
     UNION ALL
     SELECT 'instituciones (PDF ∪ Excel)',
            (SELECT count(*) FROM (SELECT cod_institucion FROM ok
                                   UNION SELECT cod_institucion FROM staging.v_xls_ok) u),
            (SELECT count(*) FROM institutions WHERE codigo_css IS NOT NULL)
     UNION ALL
     SELECT 'movimientos de horas (filas con horas > 0)',
            (SELECT count(*) FROM ok WHERE horas > 0),
            (SELECT count(*) FROM hour_movements hm
             WHERE hm.solicitud_id IN (SELECT md5(format('etl-css|%s|%s|%s', carnet, cod_institucion, correlativo))::uuid FROM ok))
     UNION ALL
     SELECT 'total de horas',
            (SELECT coalesce(sum(horas), 0) FROM ok),
            (SELECT coalesce(sum(hm.horas), 0) FROM hour_movements hm JOIN enr ON enr.id = hm.enrollment_id)`,
    transaction,
  );
  let descuadres = 0;
  console.table(
    conciliacion.map((row) => {
      const ok = String(row.esperado) === String(row.en_maestro);
      if (!ok) descuadres++;
      return { control: row.control, esperado: Number(row.esperado), 'en maestro': Number(row.en_maestro), ok: ok ? '✔' : '✖' };
    }),
  );

  const estados = await select<{ estado: string; participaciones: string; con_horas: string }>(
    `SELECT pe.estado, count(*) AS participaciones, count(hm.id) AS con_horas
     FROM project_enrollments pe LEFT JOIN hour_movements hm ON hm.enrollment_id = pe.id
     GROUP BY 1 ORDER BY 1`,
    transaction,
  );
  console.log('Participaciones por estado en el maestro:');
  console.table(estados.map((e) => ({ estado: e.estado, participaciones: Number(e.participaciones), 'con horas': Number(e.con_horas) })));

  const ajustes = await select<Record<string, string>>(
    `SELECT a.origen, x.cod_institucion || '/' || x.correlativo AS proyecto,
            x.fecha_inicio AS inicio, a.valor_original AS fin_original, a.valor_ajustado AS fin_ajustado
     FROM staging.ajustes a JOIN staging.xls_project_rows x ON a.origen = 'XLS' AND x.id = a.staging_id
     ORDER BY x.fila_excel`,
    transaction,
  );
  if (ajustes.length > 0) {
    console.log(`Correcciones automáticas aplicadas (staging.ajustes): ${ajustes.length}`);
    console.table(ajustes);
  }

  // Mapeo PDF → carrera → facultad, recorriendo las FK del maestro (no el texto del reporte).
  const mapeo = await select<Record<string, string>>(
    `SELECT m.carrera_reporte AS "carrera en PDF", c.nombre AS carrera, f.nombre AS facultad,
            (SELECT count(*) FROM students s WHERE s.career_id = c.id) AS estudiantes
     FROM staging.map_carreras m
     JOIN careers c   ON c.nombre_normalizado = fn_normalize_text(m.carrera)
     JOIN faculties f ON f.id = c.faculty_id
     ORDER BY f.nombre, c.nombre`,
    transaction,
  );
  console.log('Mapeo de carreras (students.career_id → careers.faculty_id → faculties):');
  console.table(mapeo.map((m) => ({ ...m, estudiantes: Number(m.estudiantes) })));

  const rejectedRows = await select<{ n: string }>('SELECT count(DISTINCT (origen, staging_id)) AS n FROM staging.rechazos', transaction);
  return descuadres + Number(rejectedRows[0]?.n ?? 0);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const sql = await readFile(SQL_FILE, 'utf8');
  let problems = 0;

  try {
    await sequelize.transaction(async (transaction) => {
      await assertPrerequisites(transaction);
      const started = Date.now();
      await sequelize.query(sql, { transaction });
      console.log(`Transformación ejecutada en ${Date.now() - started} ms.`);
      problems = await report(transaction);
      if (dryRun) throw new DryRunRollback();
    });
    console.log('✔ Carga confirmada (COMMIT).');
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
    console.log('✔ Dry-run: transacción revertida, el esquema maestro no cambió.');
  }

  if (problems > 0) {
    console.warn(`⚠ ${problems} problema(s): filas en cuarentena o descuadres. Revíselos en staging.rechazos.`);
    process.exitCode = 2;
  }
}

main()
  .catch((error: unknown) => {
    if (error instanceof EtlError) console.error(`\n✖ ${error.message}\n`);
    else console.error('\n✖ Error en la transformación (transacción revertida):', error);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close().catch(() => undefined));
