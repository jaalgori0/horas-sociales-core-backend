/**
 * Sincronización de projects.estado con sus fechas (regla en la migración 007,
 * fn_sincronizar_estado_proyectos). El estado se guarda en la BD porque lo leen
 * filtros y conteos de varios módulos; esta capa lo mantiene al día:
 *  • al editar o crear un proyecto (solo ese proyecto), y
 *  • con una tarea periódica, porque un cierre futuro vence con el paso del tiempo
 *    sin que nadie toque el proyecto.
 * La confirmación de importaciones y el ETL la invocan directamente en SQL.
 */
import type { Transaction } from 'sequelize';
import { selectOne, withTransaction } from '../../../core/database/sql.js';
import { logger } from '../../../core/logger.js';

export interface ProjectStatusSyncResult {
  fechasCompletadas: number;
  finalizados: number;
}

/** Cada cuánto se revisan los cierres vencidos (y una vez al arrancar). */
const SYNC_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Finaliza los proyectos ACTIVO con fecha de cierre vencida. Con `derivarCierre`
 * también completa el cierre de proyectos del CSS sin estudiantes activos (solo
 * tiene sentido tras cargar participaciones; ver migración 007).
 */
export async function syncProjectStatus(
  options: { ids?: string[]; derivarCierre?: boolean } = {},
  t?: Transaction,
): Promise<ProjectStatusSyncResult> {
  const { ids, derivarCierre = false } = options;
  if (ids && ids.length === 0) return { fechasCompletadas: 0, finalizados: 0 };
  const idsSql = ids ? 'ARRAY[:ids]::uuid[]' : 'NULL::uuid[]';
  const row = await selectOne<{ fechas_completadas: number; finalizados: number }>(
    `SELECT fechas_completadas, finalizados FROM fn_sincronizar_estado_proyectos(${idsSql}, :derivarCierre)`,
    ids ? { ids, derivarCierre } : { derivarCierre },
    t,
  );
  return { fechasCompletadas: Number(row?.fechas_completadas ?? 0), finalizados: Number(row?.finalizados ?? 0) };
}

async function runScheduledSync(): Promise<void> {
  try {
    const result = await withTransaction((t) => syncProjectStatus({}, t), 'sistema:estado-proyectos');
    if (result.finalizados > 0) {
      logger.info(`Estado de proyectos: ${result.finalizados} proyecto(s) con cierre vencido pasaron a FINALIZADO`);
    }
  } catch (error) {
    // No debe tumbar el proceso: se reintenta en la siguiente vuelta.
    logger.error('No se pudo sincronizar el estado de los proyectos', error);
  }
}

/** Ejecuta la sincronización ahora y luego cada hora. Devuelve la función para detenerla. */
export function startProjectStatusSync(intervalMs = SYNC_INTERVAL_MS): () => void {
  void runScheduledSync();
  const timer = setInterval(() => void runScheduledSync(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
