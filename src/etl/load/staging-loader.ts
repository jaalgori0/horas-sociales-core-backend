/**
 * Carga del resultado de extracción en el esquema `staging`.
 *
 * • `init`  : (re)crea el esquema desde src/etl/sql/staging_schema.sql (destructivo, es desechable).
 * • `load`  : en UNA transacción vacía las tablas e inserta todo; si algo falla, staging queda intacto.
 * • `drop`  : elimina el esquema tras el corte definitivo.
 *
 * Inserción masiva: un `INSERT ... SELECT FROM unnest($1::text[], $2::int[], ...)` por tabla.
 * Un parámetro-arreglo por columna: sin límite de 65 535 parámetros ni SQL concatenado.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { QueryTypes, type Transaction } from 'sequelize';
import { sequelize } from '../../core/config/database.js';
import { EtlError, type ExtractionResult } from '../types.js';

const SCHEMA_FILE = path.resolve(process.cwd(), 'src/etl/sql/staging_schema.sql');

type PgType = 'text' | 'integer' | 'text[]';

interface ColumnDef<T> {
  name: string;
  type: PgType;
  value: (row: T) => string | number | string[] | null;
}

export async function initStagingSchema(): Promise<void> {
  const sql = await readFile(SCHEMA_FILE, 'utf8');
  await sequelize.transaction(async (transaction) => {
    await sequelize.query(sql, { transaction });
  });
}

export async function dropStagingSchema(): Promise<void> {
  await sequelize.query('DROP SCHEMA IF EXISTS staging CASCADE');
}

async function assertSchemaExists(transaction: Transaction): Promise<void> {
  const [row] = await sequelize.query<{ ok: boolean }>(
    "SELECT to_regclass('staging.source_files') IS NOT NULL AS ok",
    { type: QueryTypes.SELECT, transaction },
  );
  if (!row?.ok) {
    throw new EtlError('El esquema "staging" no existe. Ejecute primero: pnpm etl:staging:init');
  }
}

async function bulkInsert<T>(
  table: string,
  columns: ReadonlyArray<ColumnDef<T>>,
  rows: readonly T[],
  transaction: Transaction,
): Promise<void> {
  if (rows.length === 0) return;

  // text[] no se puede pasar dentro de un arreglo 2D a unnest (se aplanaría):
  // viaja como JSON por fila y se reconstruye en el SELECT.
  const unnestArgs = columns.map((col, i) => `$${i + 1}::${col.type === 'text[]' ? 'text' : col.type}[]`);
  const aliases = columns.map((_, i) => `c${i + 1}`);
  const selectList = columns.map((col, i) =>
    col.type === 'text[]'
      ? `ARRAY(SELECT jsonb_array_elements_text(c${i + 1}::jsonb))`
      : `c${i + 1}`,
  );
  const bind = columns.map((col) =>
    rows.map((row) => {
      const value = col.value(row);
      return col.type === 'text[]' ? JSON.stringify(value ?? []) : value;
    }),
  );

  await sequelize.query(
    `INSERT INTO ${table} (${columns.map((col) => col.name).join(', ')})
     SELECT ${selectList.join(', ')}
     FROM unnest(${unnestArgs.join(', ')}) AS t(${aliases.join(', ')})`,
    { bind, transaction },
  );
}

export async function loadStaging(result: ExtractionResult): Promise<void> {
  await sequelize.transaction(async (transaction) => {
    await assertSchemaExists(transaction);
    await sequelize.query(
      `TRUNCATE staging.source_files, staging.pdf_hour_rows, staging.xls_project_rows,
                staging.control_totals, staging.unparsed_lines RESTART IDENTITY`,
      { transaction },
    );

    await bulkInsert(
      'staging.source_files',
      [
        { name: 'archivo', type: 'text', value: (f) => f.archivo },
        { name: 'tipo', type: 'text', value: (f) => f.tipo },
        { name: 'sha256', type: 'text', value: (f) => f.sha256 },
        { name: 'paginas', type: 'integer', value: (f) => f.paginas },
        { name: 'titulo', type: 'text', value: (f) => f.titulo },
        { name: 'periodo_desde', type: 'text', value: (f) => f.periodoDesde },
        { name: 'periodo_hasta', type: 'text', value: (f) => f.periodoHasta },
        { name: 'generado_en', type: 'text', value: (f) => f.generadoEn },
      ],
      result.files,
      transaction,
    );

    await bulkInsert(
      'staging.pdf_hour_rows',
      [
        { name: 'archivo', type: 'text', value: (r) => r.archivo },
        { name: 'pagina', type: 'integer', value: (r) => r.pagina },
        { name: 'linea', type: 'integer', value: (r) => r.linea },
        { name: 'bloque', type: 'integer', value: (r) => r.bloque },
        { name: 'proyecto_nombre', type: 'text', value: (r) => r.proyectoNombre },
        { name: 'correlativo', type: 'text', value: (r) => r.correlativo },
        { name: 'carnet', type: 'text', value: (r) => r.carnet },
        { name: 'nombre_completo', type: 'text', value: (r) => r.nombreCompleto },
        { name: 'fecha_inicio', type: 'text', value: (r) => r.fechaInicio },
        { name: 'fecha_fin', type: 'text', value: (r) => r.fechaFin },
        { name: 'cod_institucion', type: 'text', value: (r) => r.codInstitucion },
        { name: 'institucion', type: 'text', value: (r) => r.institucion },
        { name: 'carrera', type: 'text', value: (r) => r.carrera },
        { name: 'horas_asignadas', type: 'text', value: (r) => r.horasAsignadas },
        { name: 'estado', type: 'text', value: (r) => r.estado },
        { name: 'texto_original', type: 'text', value: (r) => r.textoOriginal },
        { name: 'advertencias', type: 'text[]', value: (r) => r.advertencias },
      ],
      result.pdfRows,
      transaction,
    );

    await bulkInsert(
      'staging.xls_project_rows',
      [
        { name: 'archivo', type: 'text', value: (r) => r.archivo },
        { name: 'hoja', type: 'text', value: (r) => r.hoja },
        { name: 'fila_excel', type: 'integer', value: (r) => r.filaExcel },
        { name: 'area', type: 'text', value: (r) => r.area },
        { name: 'cod_institucion', type: 'text', value: (r) => r.codInstitucion },
        { name: 'institucion', type: 'text', value: (r) => r.institucion },
        { name: 'correlativo', type: 'text', value: (r) => r.correlativo },
        { name: 'proyecto_nombre', type: 'text', value: (r) => r.proyectoNombre },
        { name: 'alumnos', type: 'text', value: (r) => r.alumnos },
        { name: 'fecha_inicio', type: 'text', value: (r) => r.fechaInicio },
        { name: 'fecha_fin', type: 'text', value: (r) => r.fechaFin },
        { name: 'advertencias', type: 'text[]', value: (r) => r.advertencias },
      ],
      result.xlsRows,
      transaction,
    );

    await bulkInsert(
      'staging.control_totals',
      [
        { name: 'archivo', type: 'text', value: (t) => t.archivo },
        { name: 'ubicacion', type: 'text', value: (t) => t.ubicacion },
        { name: 'alcance', type: 'text', value: (t) => t.alcance },
        { name: 'bloque', type: 'integer', value: (t) => t.bloque },
        { name: 'clave', type: 'text', value: (t) => t.clave },
        { name: 'metrica', type: 'text', value: (t) => t.metrica },
        { name: 'valor', type: 'text', value: (t) => t.valor },
      ],
      result.controlTotals,
      transaction,
    );

    await bulkInsert(
      'staging.unparsed_lines',
      [
        { name: 'archivo', type: 'text', value: (u) => u.archivo },
        { name: 'ubicacion', type: 'text', value: (u) => u.ubicacion },
        { name: 'texto', type: 'text', value: (u) => u.texto },
        { name: 'motivo', type: 'text', value: (u) => u.motivo },
      ],
      result.unparsed,
      transaction,
    );
  });
}
