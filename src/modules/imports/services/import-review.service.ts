/**
 * Revisión en línea de un lote en vista previa (migración 013): reemplaza editar Excel.
 *
 *   editRow     corrige estado / horas / fechas de una fila del PDF (o revierte campos)
 *   excludeRow  excluye una fila del lote (justificación obligatoria)
 *   restoreRow  devuelve una fila excluida al lote
 *   decide      ACEPTAR_REPORTE / CONSERVAR_BD en una participación que lo admite
 *               (aumento de horas en una participación ya FINALIZADA)
 *   linkProject VINCULAR a un proyecto creado en la app con la misma nombre_clave, o
 *               CREAR_NUEVO (migración 014): evita copias silenciosas del mismo proyecto
 *   renew       renueva el vencimiento de la vista previa (24 h)
 *   log         bitácora de la revisión
 *
 * Toda acción, en UNA transacción:
 *   1. bloquea el lote (FOR UPDATE) y exige PREVISUALIZADO y vigente;
 *   2. exige la huella que el usuario tiene en pantalla (si otra persona cambió el lote:
 *      409 REVISION_DESACTUALIZADA con el lote actual);
 *   3. guarda la corrección vigente (import_pdf_row_overrides / import_enrollment_decisions)
 *      y una entrada en la bitácora inmutable import_review_log (original, anterior,
 *      nuevo, justificación, usuario, fecha). import_pdf_rows NUNCA se modifica;
 *   4. recalcula el cuadre de los archivos, reclasifica con las MISMAS reglas que la
 *      importación (classify.sql) y estima el impacto de confirmar;
 *   5. guarda la huella nueva y extiende el vencimiento 24 h desde la edición.
 */
import type { Transaction } from 'sequelize';
import { sequelize } from '../../../core/config/database.js';
import { selectAll, selectOne, withTransaction } from '../../../core/database/sql.js';
import { AppError } from '../../../core/errors/app-error.js';
import {
  BATCH_COLUMNS,
  DIAS_GRACIA_REVISION,
  classifyAndSummarize,
  importsService,
  recalcularConciliacion,
  type BatchDetailDTO,
} from './imports.service.js';

/** Valores en el formato del reporte (los re-valida classify.sql). null = sin cambio. */
interface Override {
  estado: string | null;
  horas_asignadas: string | null;
  fecha_inicio: string | null;
  fecha_fin: string | null;
  excluida: boolean;
  justificacion: string;
}

export interface CambiosFila {
  /** Ausente: se conserva la corrección vigente. null: vuelve al valor del PDF. */
  estado?: 'Activo' | 'Finalizado' | 'Abandonado' | null;
  horas?: number | null;
  fechaInicio?: string | null;
  /** '01/01/1900' = sin fecha (convención del reporte). */
  fechaFin?: string | null;
}

export type DecisionParticipacion = 'ACEPTAR_REPORTE' | 'CONSERVAR_BD';
export type DecisionProyecto = 'VINCULAR' | 'CREAR_NUEVO';

interface FilaPdf {
  id: string;
  estado: string | null;
  horas_asignadas: string | null;
  fecha_inicio: string | null;
  fecha_fin: string | null;
}

const VIGENCIA_HORAS = 24;

function overrideJson(o: Override | null) {
  if (!o) return null;
  return { estado: o.estado, horas: o.horas_asignadas, fechaInicio: o.fecha_inicio, fechaFin: o.fecha_fin, excluida: o.excluida };
}

function originalJson(r: FilaPdf) {
  return { estado: r.estado, horas: r.horas_asignadas, fechaInicio: r.fecha_inicio, fechaFin: r.fecha_fin };
}

async function registrar(
  t: Transaction,
  entrada: {
    batchId: string; accion: 'EDITAR' | 'EXCLUIR' | 'RESTAURAR' | 'DECIDIR' | 'VINCULAR';
    pdfRowId?: string | null; clave?: string | null;
    original: unknown; anterior: unknown; nuevo: unknown; justificacion: string;
  },
): Promise<void> {
  await sequelize.query(
    `INSERT INTO import_review_log (batch_id, accion, pdf_row_id, clave, valor_original, valor_anterior, valor_nuevo, justificacion)
     VALUES (:batchId, :accion, :pdfRowId, :clave, CAST(:original AS jsonb), CAST(:anterior AS jsonb), CAST(:nuevo AS jsonb), :justificacion)`,
    {
      replacements: {
        batchId: entrada.batchId, accion: entrada.accion,
        pdfRowId: entrada.pdfRowId ?? null, clave: entrada.clave ?? null,
        original: JSON.stringify(entrada.original ?? null),
        anterior: JSON.stringify(entrada.anterior ?? null),
        nuevo: JSON.stringify(entrada.nuevo ?? null),
        justificacion: entrada.justificacion,
      },
      transaction: t,
    },
  );
}

/** Pasos 1, 2, 4 y 5 alrededor de `work` (paso 3). */
async function revisar(
  batchId: string,
  huellaVista: string,
  actor: string,
  work: (t: Transaction) => Promise<void>,
): Promise<BatchDetailDTO> {
  const outcome = await withTransaction(async (t) => {
    const batch = await selectOne<{ estado: string; expirado: boolean; huella: string | null }>(
      `SELECT ${BATCH_COLUMNS} FROM import_batches WHERE id = :id FOR UPDATE`,
      { id: batchId },
      t,
    );
    if (!batch) throw AppError.notFound('Lote de importación no encontrado');
    if (batch.estado !== 'PREVISUALIZADO') {
      throw AppError.conflict('Solo se puede revisar un lote en vista previa', { estado: batch.estado });
    }
    if (batch.expirado) {
      throw AppError.conflict('La vista previa venció. Renuévela para seguir revisando (sus correcciones se conservan).', {
        code: 'PREVIEW_VENCIDA',
      });
    }
    if (batch.huella !== huellaVista) return 'desactualizado' as const;

    await work(t);
    await recalcularConciliacion(batchId, t);
    const { huella, resumen } = await classifyAndSummarize(batchId, t, { impacto: true });
    await sequelize.query(
      `UPDATE import_batches
       SET huella = :huella, resumen = :resumen,
           expira_en = greatest(expira_en, now() + make_interval(hours => :horas))
       WHERE id = :id`,
      { replacements: { id: batchId, huella, resumen: JSON.stringify(resumen), horas: VIGENCIA_HORAS }, transaction: t },
    );
    return 'ok' as const;
  }, actor);

  const detail = await importsService.getBatch(batchId);
  if (outcome === 'desactualizado') {
    throw AppError.conflict('Otra persona modificó este lote. Revise la versión actual antes de seguir.', {
      code: 'REVISION_DESACTUALIZADA',
      lote: detail,
    });
  }
  return detail;
}

async function filaDelLote(batchId: string, rowId: number, t: Transaction): Promise<FilaPdf> {
  const fila = await selectOne<FilaPdf>(
    `SELECT r.id, r.estado, r.horas_asignadas, r.fecha_inicio, r.fecha_fin
     FROM import_pdf_rows r
     JOIN import_files f ON f.batch_id = r.batch_id AND f.archivo = r.archivo
     WHERE r.batch_id = :batchId AND r.id = :rowId
       AND f.tipo IN ('PDF_DETALLE_HORAS', 'XLSX_PLANTILLA_REVISION')`,
    { batchId, rowId },
    t,
  );
  if (!fila) throw AppError.notFound('La fila no pertenece a este lote');
  return fila;
}

async function overrideVigente(batchId: string, rowId: number, t: Transaction): Promise<Override | null> {
  return selectOne<Override>(
    `SELECT estado, horas_asignadas, fecha_inicio, fecha_fin, excluida, justificacion
     FROM import_pdf_row_overrides WHERE batch_id = :batchId AND pdf_row_id = :rowId`,
    { batchId, rowId },
    t,
  );
}

async function guardarOverride(batchId: string, rowId: number, o: Override, t: Transaction): Promise<void> {
  const sinCambios = !o.excluida && o.estado === null && o.horas_asignadas === null && o.fecha_inicio === null && o.fecha_fin === null;
  if (sinCambios) {
    await sequelize.query('DELETE FROM import_pdf_row_overrides WHERE batch_id = :batchId AND pdf_row_id = :rowId', {
      replacements: { batchId, rowId },
      transaction: t,
    });
    return;
  }
  await sequelize.query(
    `INSERT INTO import_pdf_row_overrides
       (batch_id, pdf_row_id, estado, horas_asignadas, fecha_inicio, fecha_fin, excluida, justificacion)
     VALUES (:batchId, :rowId, :estado, :horas, :inicio, :fin, :excluida, :justificacion)
     ON CONFLICT (batch_id, pdf_row_id) DO UPDATE
       SET estado = EXCLUDED.estado, horas_asignadas = EXCLUDED.horas_asignadas,
           fecha_inicio = EXCLUDED.fecha_inicio, fecha_fin = EXCLUDED.fecha_fin,
           excluida = EXCLUDED.excluida, justificacion = EXCLUDED.justificacion,
           actualizado_por = fn_current_actor(), actualizado_en = now()`,
    {
      replacements: {
        batchId, rowId, estado: o.estado, horas: o.horas_asignadas, inicio: o.fecha_inicio, fin: o.fecha_fin,
        excluida: o.excluida, justificacion: o.justificacion,
      },
      transaction: t,
    },
  );
}

/** Valor nuevo de un campo: ausente → el vigente; null → original; igual al original → sin cambio (null). */
function resolverCampo(
  cambios: CambiosFila, clave: keyof CambiosFila, vigente: string | null, original: string | null,
): string | null {
  if (!(clave in cambios)) return vigente;
  const valor = cambios[clave];
  if (valor === null || valor === undefined) return null;
  const texto = String(valor);
  return texto === (original ?? '').trim() ? null : texto;
}

export const importReviewService = {
  async editRow(
    batchId: string, rowId: number,
    input: { huella: string; justificacion: string; cambios: CambiosFila }, actor: string,
  ): Promise<BatchDetailDTO> {
    return revisar(batchId, input.huella, actor, async (t) => {
      const fila = await filaDelLote(batchId, rowId, t);
      const anterior = await overrideVigente(batchId, rowId, t);
      if (anterior?.excluida) throw AppError.conflict('La fila está excluida: restáurela antes de editarla');
      const nuevo: Override = {
        estado: resolverCampo(input.cambios, 'estado', anterior?.estado ?? null, fila.estado),
        horas_asignadas: resolverCampo(input.cambios, 'horas', anterior?.horas_asignadas ?? null, fila.horas_asignadas),
        fecha_inicio: resolverCampo(input.cambios, 'fechaInicio', anterior?.fecha_inicio ?? null, fila.fecha_inicio),
        fecha_fin: resolverCampo(input.cambios, 'fechaFin', anterior?.fecha_fin ?? null, fila.fecha_fin),
        excluida: false,
        justificacion: input.justificacion,
      };
      await guardarOverride(batchId, rowId, nuevo, t);
      await registrar(t, {
        batchId, accion: 'EDITAR', pdfRowId: String(rowId), original: originalJson(fila),
        anterior: overrideJson(anterior), nuevo: overrideJson(nuevo), justificacion: input.justificacion,
      });
    });
  },

  async excludeRow(
    batchId: string, rowId: number, input: { huella: string; justificacion: string }, actor: string,
  ): Promise<BatchDetailDTO> {
    return revisar(batchId, input.huella, actor, async (t) => {
      const fila = await filaDelLote(batchId, rowId, t);
      const anterior = await overrideVigente(batchId, rowId, t);
      if (anterior?.excluida) throw AppError.conflict('La fila ya está excluida');
      const nuevo: Override = {
        estado: anterior?.estado ?? null, horas_asignadas: anterior?.horas_asignadas ?? null,
        fecha_inicio: anterior?.fecha_inicio ?? null, fecha_fin: anterior?.fecha_fin ?? null,
        excluida: true, justificacion: input.justificacion,
      };
      await guardarOverride(batchId, rowId, nuevo, t);
      await registrar(t, {
        batchId, accion: 'EXCLUIR', pdfRowId: String(rowId), original: originalJson(fila),
        anterior: overrideJson(anterior), nuevo: overrideJson(nuevo), justificacion: input.justificacion,
      });
    });
  },

  async restoreRow(
    batchId: string, rowId: number, input: { huella: string; justificacion: string }, actor: string,
  ): Promise<BatchDetailDTO> {
    return revisar(batchId, input.huella, actor, async (t) => {
      const fila = await filaDelLote(batchId, rowId, t);
      const anterior = await overrideVigente(batchId, rowId, t);
      if (!anterior?.excluida) throw AppError.conflict('La fila no está excluida');
      const nuevo: Override = { ...anterior, excluida: false, justificacion: input.justificacion };
      await guardarOverride(batchId, rowId, nuevo, t);
      await registrar(t, {
        batchId, accion: 'RESTAURAR', pdfRowId: String(rowId), original: originalJson(fila),
        anterior: overrideJson(anterior), nuevo: overrideJson(nuevo), justificacion: input.justificacion,
      });
    });
  },

  async decide(
    batchId: string,
    input: { huella: string; clave: string; decision: DecisionParticipacion; justificacion: string },
    actor: string,
  ): Promise<BatchDetailDTO> {
    return revisar(batchId, input.huella, actor, async (t) => {
      const item = await selectOne<{ datos: Record<string, unknown>; existente: Record<string, unknown> | null }>(
        `SELECT datos, existente FROM import_items
         WHERE batch_id = :batchId AND entidad = 'PARTICIPACION' AND clave = :clave`,
        { batchId, clave: input.clave },
        t,
      );
      if (!item) throw AppError.notFound('La participación no está en este lote');
      if (item.datos.cambio !== 'AJUSTE_HORAS' || !item.existente) {
        throw AppError.unprocessable(
          'Esta participación no admite decisión: solo los aumentos de horas en participaciones ya finalizadas.',
          { cambio: item.datos.cambio ?? null },
        );
      }
      const anterior = await selectOne<Record<string, unknown>>(
        `SELECT decision, horas_existentes AS "horasExistentes", horas_reporte AS "horasReporte"
         FROM import_enrollment_decisions WHERE batch_id = :batchId AND clave = :clave`,
        { batchId, clave: input.clave },
        t,
      );
      const horasExistentes = Number(item.existente.horas);
      const horasReporte = Number(item.datos.horas);
      await sequelize.query(
        `INSERT INTO import_enrollment_decisions (batch_id, clave, decision, horas_existentes, horas_reporte, justificacion)
         VALUES (:batchId, :clave, :decision, :horasExistentes, :horasReporte, :justificacion)
         ON CONFLICT (batch_id, clave) DO UPDATE
           SET decision = EXCLUDED.decision, horas_existentes = EXCLUDED.horas_existentes,
               horas_reporte = EXCLUDED.horas_reporte, justificacion = EXCLUDED.justificacion,
               decidido_por = fn_current_actor(), decidido_en = now()`,
        {
          replacements: { batchId, clave: input.clave, decision: input.decision, horasExistentes, horasReporte, justificacion: input.justificacion },
          transaction: t,
        },
      );
      await registrar(t, {
        batchId, accion: 'DECIDIR', clave: input.clave, original: item.existente, anterior,
        nuevo: { decision: input.decision, horasExistentes, horasReporte }, justificacion: input.justificacion,
      });
    });
  },

  /**
   * Proyecto del lote que coincide (nombre_clave) con proyectos creados en la app.
   * VINCULAR: se adopta `projectId` (debe ser una de las candidatas); CREAR_NUEVO: se crea
   * aparte, a sabiendas. La clasificación vuelve a validar todo (p. ej. que dos
   * correlativos no adopten el mismo proyecto).
   */
  async linkProject(
    batchId: string,
    input: { huella: string; clave: string; decision: DecisionProyecto; projectId?: string; justificacion: string },
    actor: string,
  ): Promise<BatchDetailDTO> {
    return revisar(batchId, input.huella, actor, async (t) => {
      const item = await selectOne<{ datos: Record<string, unknown> }>(
        `SELECT datos FROM import_items WHERE batch_id = :batchId AND entidad = 'PROYECTO' AND clave = :clave`,
        { batchId, clave: input.clave },
        t,
      );
      if (!item) throw AppError.notFound('El proyecto no está en este lote');
      const candidatos = (item.datos.candidatosApp as Array<{ id: string; titulo: string }> | null) ?? [];
      if (candidatos.length === 0) {
        throw AppError.unprocessable('Este proyecto no coincide con ningún proyecto creado en la app: no hay nada que vincular.');
      }
      if (input.decision === 'VINCULAR' && !candidatos.some((c) => c.id === input.projectId)) {
        throw AppError.unprocessable('El proyecto elegido no es una de las coincidencias de la app', {
          candidatos: candidatos.map((c) => c.id),
        });
      }
      const projectId = input.decision === 'VINCULAR' ? input.projectId! : null;
      const anterior = await selectOne<Record<string, unknown>>(
        `SELECT decision, project_id AS "projectId" FROM import_project_links WHERE batch_id = :batchId AND clave = :clave`,
        { batchId, clave: input.clave },
        t,
      );
      await sequelize.query(
        `INSERT INTO import_project_links (batch_id, clave, decision, project_id, justificacion)
         VALUES (:batchId, :clave, :decision, :projectId, :justificacion)
         ON CONFLICT (batch_id, clave) DO UPDATE
           SET decision = EXCLUDED.decision, project_id = EXCLUDED.project_id, justificacion = EXCLUDED.justificacion,
               decidido_por = fn_current_actor(), decidido_en = now()`,
        { replacements: { batchId, clave: input.clave, decision: input.decision, projectId, justificacion: input.justificacion }, transaction: t },
      );
      await registrar(t, {
        batchId, accion: 'VINCULAR', clave: input.clave, original: { candidatos }, anterior,
        nuevo: { decision: input.decision, projectId }, justificacion: input.justificacion,
      });
    });
  },

  /**
   * Renueva el vencimiento (24 h desde ahora) de una vista previa, también si ya venció
   * (se conserva DIAS_GRACIA_REVISION días si tiene revisión guardada). Reclasifica contra
   * el maestro actual: si algo cambió mientras estaba vencida, se ve antes de confirmar.
   */
  async renew(batchId: string, actor: string): Promise<BatchDetailDTO> {
    await withTransaction(async (t) => {
      const batch = await selectOne<{ estado: string }>(
        'SELECT estado FROM import_batches WHERE id = :id FOR UPDATE',
        { id: batchId },
        t,
      );
      if (!batch) throw AppError.notFound('Lote de importación no encontrado (pudo haberse purgado)');
      if (batch.estado !== 'PREVISUALIZADO') throw AppError.conflict('Solo se renueva una vista previa', { estado: batch.estado });
      const { huella, resumen } = await classifyAndSummarize(batchId, t, { impacto: true });
      await sequelize.query(
        `UPDATE import_batches SET huella = :huella, resumen = :resumen, expira_en = now() + make_interval(hours => :horas)
         WHERE id = :id`,
        { replacements: { id: batchId, huella, resumen: JSON.stringify(resumen), horas: VIGENCIA_HORAS }, transaction: t },
      );
    }, actor);
    return importsService.getBatch(batchId);
  },

  async log(batchId: string) {
    const exists = await selectOne<{ id: string }>('SELECT id FROM import_batches WHERE id = :id', { id: batchId });
    if (!exists) throw AppError.notFound('Lote de importación no encontrado');
    const rows = await selectAll<Record<string, unknown>>(
      `SELECT id, accion, pdf_row_id AS "pdfRowId", clave, valor_original AS "valorOriginal",
              valor_anterior AS "valorAnterior", valor_nuevo AS "valorNuevo", justificacion, actor, creado_en AS "creadoEn"
       FROM import_review_log WHERE batch_id = :id ORDER BY id DESC`,
      { id: batchId },
    );
    return rows.map((r) => ({ ...r, id: Number(r.id), pdfRowId: r.pdfRowId == null ? null : Number(r.pdfRowId) }));
  },

  diasGraciaRevision: DIAS_GRACIA_REVISION,
};
