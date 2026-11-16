/**
 * Ejecución de los scripts SQL de importación sobre UN lote.
 *
 * • El lote se fija con set_config('app.import_id', id, true): local a la
 *   transacción, y los scripts lo leen con fn_import_actual(). No se concatena
 *   ningún valor en el SQL.
 * • classify.sql corre de una sola vez (no devuelve filas).
 * • apply.sql se divide en bloques "-- @step nombre"; cada uno devuelve cuántas
 *   filas escribió, y eso forma el `resultado` del lote.
 *
 * Igual que el ETL y las migraciones, los .sql se leen desde src/ (process.cwd()).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { QueryTypes, type Transaction } from 'sequelize';
import { sequelize } from '../../../core/config/database.js';

const SQL_DIR = path.resolve(process.cwd(), 'src/modules/imports/sql');
const STEP_MARKER = /^-- @step ([a-z_]+)\s*$/m;

interface Step {
  name: string;
  sql: string;
}

let classifySql: Promise<string> | undefined;
let applySteps: Promise<Step[]> | undefined;

function loadClassify(): Promise<string> {
  classifySql ??= readFile(path.join(SQL_DIR, 'classify.sql'), 'utf8');
  return classifySql;
}

function loadApplySteps(): Promise<Step[]> {
  applySteps ??= readFile(path.join(SQL_DIR, 'apply.sql'), 'utf8').then((text) => {
    // split con grupo de captura: [cabecera, nombre1, sql1, nombre2, sql2, ...]
    const parts = text.split(STEP_MARKER);
    const steps: Step[] = [];
    for (let i = 1; i < parts.length; i += 2) {
      steps.push({ name: parts[i]!, sql: parts[i + 1]!.trim() });
    }
    if (steps.length === 0) throw new Error('apply.sql no tiene bloques "-- @step"');
    return steps;
  });
  return applySteps;
}

export async function setBatchContext(batchId: string, transaction: Transaction): Promise<void> {
  await sequelize.query("SELECT set_config('app.import_id', :batchId, true)", {
    replacements: { batchId },
    transaction,
  });
}

/** Reescribe import_items del lote y deja las tablas t_*_c para applyBatch. */
export async function classifyBatch(transaction: Transaction): Promise<void> {
  await sequelize.query(await loadClassify(), { transaction });
}

export type ApplyResult = Record<string, Record<string, number>>;

/** Escribe en el maestro lo clasificado como INSERTAR/COMPLETAR. Requiere classifyBatch antes. */
export async function applyBatch(transaction: Transaction): Promise<ApplyResult> {
  const result: ApplyResult = {};
  for (const step of await loadApplySteps()) {
    const rows = await sequelize.query<Record<string, number>>(step.sql, { type: QueryTypes.SELECT, transaction });
    const [row] = rows;
    if (row && 'n' in row) result[step.name] = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
  }
  return result;
}
