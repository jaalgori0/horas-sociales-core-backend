/**
 * Importación masiva por lotes.
 *
 *   createPreview  archivos → filas del lote → clasificación → vista previa (no toca el maestro)
 *                  + impacto estimado de confirmar (simulación real dentro de un SAVEPOINT)
 *   confirm        advisory lock → reclasifica → si la clasificación cambió, 409 con la nueva
 *                  vista previa; si no, inserción estricta, enriquecimiento (género y
 *                  ubicación inferidos, ver enrichment.service.ts) y lote CONFIRMADO
 *   getBatch       lote + archivos + resumen + ítems (filtrables)
 *   discard        descarta una vista previa y libera sus filas
 *
 * Revisión en línea (ediciones, exclusiones y decisiones): import-review.service.ts.
 *
 * Aislamiento: cada lote tiene su `batch_id` y la clasificación usa tablas temporales
 * de la conexión. Dos vistas previas pueden correr a la vez; las confirmaciones se
 * serializan con pg_advisory_xact_lock y cada una reclasifica contra el maestro actual.
 */
import type { Transaction } from 'sequelize';
import { sequelize } from '../../../core/config/database.js';
import { execReturning, selectAll, selectOne, withTransaction } from '../../../core/database/sql.js';
import { AppError } from '../../../core/errors/app-error.js';
import { bulkInsert } from '../../../etl/load/staging-loader.js';
import { isHourDetailSource, type ControlTotal, type PdfHourRow, type UnparsedLine, type XlsProjectRow } from '../../../etl/types.js';
import { parseUploadedFiles, type ParsedFile, type UploadedFile } from './file-parser.service.js';
import { enriquecerMaestro } from './enrichment.service.js';
import { applyBatch, classifyBatch, setBatchContext, type ApplyResult } from './import-sql.js';
import { buildReviewTemplate, needsReview } from '../../../etl/extract/xlsx-plantilla-revision.js';
import { HORAS_REQUISITO } from '../../students/index.js';

/** Distinto del lock de migraciones. Serializa las confirmaciones de importación. */
const CONFIRM_LOCK_KEY = 7_264_031_118;

export const ITEM_ESTADOS = ['NUEVO', 'IGNORADO', 'ADVERTENCIA', 'CONFLICTO'] as const;
export const ITEM_ENTIDADES = ['INSTITUCION', 'PROYECTO', 'ESTUDIANTE', 'PARTICIPACION', 'FILA_PDF', 'FILA_XLS'] as const;
export type ItemEstado = (typeof ITEM_ESTADOS)[number];
export type ItemEntidad = (typeof ITEM_ENTIDADES)[number];

type Conteo = Record<ItemEstado, number>;

export interface BatchSummary {
  total: Conteo;
  porEntidad: Partial<Record<ItemEntidad, Conteo>>;
  /** Horas que entrarán con las participaciones nuevas. */
  horasNuevas: number;
  /** Participaciones existentes que se actualizarán (Activo → Finalizada o ajuste aceptado). */
  actualizar: number;
  /** Horas CSS que suman esas actualizaciones (reporte − base). */
  horasActualizadas: number;
  /** Efecto estimado de confirmar sobre el maestro (null en la confirmación). */
  impacto?: ImpactoEstimado | null;
}

/** Foto de los contadores del maestro que cambia una importación. */
export interface MetricasMaestro {
  participacionesActivas: number;
  participacionesFinalizadas: number;
  participacionesRetiradas: number;
  participantes: number;
  horasTotales: number;
  proyectosFinalizados: number;
  estudiantesCon600: number;
}

export type ImpactoEstimado =
  | { ok: true; antes: MetricasMaestro; despues: MetricasMaestro; delta: MetricasMaestro }
  /** La simulación falló: confirmar también fallaría. */
  | { ok: false; error: string };

interface Conciliacion {
  control: string;
  extraido: number;
  reporte: number | null;
  ok: boolean;
  /** Filas/horas quitadas o cambiadas en la revisión en línea, todas con justificación. */
  ajuste?: number;
  /** Lo que se extrajo del archivo antes de la revisión. */
  extraidoOriginal?: number;
}

// -----------------------------------------------------------------------------
// Conciliación contra los totales impresos (misma lógica que `etl:staging:load`)
// -----------------------------------------------------------------------------
function toInt(value: string | null | undefined): number | null {
  return value != null && /^\d+$/.test(value) ? Number(value) : null;
}

function reconcile(file: Extract<ParsedFile, { estado: 'procesado' }>): Conciliacion[] {
  const { extraction } = file;
  const total = (metrica: ControlTotal['metrica']): number | null =>
    toInt(extraction.controlTotals.find((t) => t.alcance === 'ARCHIVO' && t.metrica === metrica)?.valor);
  const check = (control: string, extraido: number, reporte: number | null): Conciliacion => ({
    control,
    extraido,
    reporte,
    ok: reporte === null || reporte === extraido,
  });

  if (isHourDetailSource(extraction.file.tipo)) {
    return [
      check('alumnos', extraction.pdfRows.length, total('ALUMNOS')),
      check('horas', extraction.pdfRows.reduce((sum, r) => sum + (toInt(r.horasAsignadas) ?? 0), 0), total('HORAS')),
    ];
  }
  return [
    check('proyectos', extraction.xlsRows.length, total('PROYECTOS')),
    check('alumnos', extraction.xlsRows.reduce((sum, r) => sum + (toInt(r.alumnos) ?? 0), 0), total('ALUMNOS')),
  ];
}

// -----------------------------------------------------------------------------
// Persistencia del lote
// -----------------------------------------------------------------------------
interface FileRecord {
  archivo: string;
  estado: 'PROCESADO' | 'RECHAZADO';
  motivo: string | null;
  tipo: string | null;
  sha256: string;
  bytes: number;
  paginas: number | null;
  titulo: string | null;
  periodoDesde: string | null;
  periodoHasta: string | null;
  generadoEn: string | null;
  filas: number;
  advertencias: string[];
  conciliacion: string;
}

function toFileRecord(file: ParsedFile): FileRecord {
  if (file.estado === 'rechazado') {
    return {
      archivo: file.archivo,
      estado: 'RECHAZADO',
      motivo: file.motivo,
      tipo: null,
      sha256: file.sha256,
      bytes: file.bytes,
      paginas: null,
      titulo: null,
      periodoDesde: null,
      periodoHasta: null,
      generadoEn: null,
      filas: 0,
      advertencias: [],
      conciliacion: '[]',
    };
  }
  const { extraction } = file;
  const conciliacion = reconcile(file);
  const advertencias = conciliacion.filter((c) => !c.ok).map((c) => `descuadre_con_totales:${c.control}`);
  if (extraction.unparsed.length > 0) advertencias.push(`lineas_no_reconocidas:${extraction.unparsed.length}`);
  return {
    archivo: file.archivo,
    estado: 'PROCESADO',
    motivo: null,
    tipo: extraction.file.tipo,
    sha256: file.sha256,
    bytes: file.bytes,
    paginas: extraction.file.paginas,
    titulo: extraction.file.titulo,
    periodoDesde: extraction.file.periodoDesde,
    periodoHasta: extraction.file.periodoHasta,
    generadoEn: extraction.file.generadoEn,
    filas: extraction.pdfRows.length + extraction.xlsRows.length,
    advertencias,
    conciliacion: JSON.stringify(conciliacion),
  };
}

async function storeFiles(batchId: string, parsed: readonly ParsedFile[], t: Transaction): Promise<void> {
  const batch = () => batchId;
  await bulkInsert<FileRecord>(
    'import_files',
    [
      { name: 'batch_id', type: 'uuid', value: batch },
      { name: 'archivo', type: 'text', value: (f) => f.archivo },
      { name: 'estado', type: 'text', value: (f) => f.estado },
      { name: 'motivo', type: 'text', value: (f) => f.motivo },
      { name: 'tipo', type: 'text', value: (f) => f.tipo },
      { name: 'sha256', type: 'text', value: (f) => f.sha256 },
      { name: 'bytes', type: 'integer', value: (f) => f.bytes },
      { name: 'paginas', type: 'integer', value: (f) => f.paginas },
      { name: 'titulo', type: 'text', value: (f) => f.titulo },
      { name: 'periodo_desde', type: 'text', value: (f) => f.periodoDesde },
      { name: 'periodo_hasta', type: 'text', value: (f) => f.periodoHasta },
      { name: 'generado_en', type: 'text', value: (f) => f.generadoEn },
      { name: 'filas', type: 'integer', value: (f) => f.filas },
      { name: 'advertencias', type: 'text[]', value: (f) => f.advertencias },
      { name: 'conciliacion', type: 'jsonb', value: (f) => f.conciliacion },
    ],
    parsed.map(toFileRecord),
    t,
  );

  const processed = parsed.filter((f): f is Extract<ParsedFile, { estado: 'procesado' }> => f.estado === 'procesado');
  const pdfRows = processed.flatMap((f) => f.extraction.pdfRows);
  const xlsRows = processed.flatMap((f) => f.extraction.xlsRows);
  const unparsed = processed.flatMap((f) => f.extraction.unparsed);

  await bulkInsert<PdfHourRow>(
    'import_pdf_rows',
    [
      { name: 'batch_id', type: 'uuid', value: batch },
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
    pdfRows,
    t,
  );

  await bulkInsert<XlsProjectRow>(
    'import_xls_rows',
    [
      { name: 'batch_id', type: 'uuid', value: batch },
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
    xlsRows,
    t,
  );

  await bulkInsert<UnparsedLine>(
    'import_unparsed_lines',
    [
      { name: 'batch_id', type: 'uuid', value: batch },
      { name: 'archivo', type: 'text', value: (u) => u.archivo },
      { name: 'ubicacion', type: 'text', value: (u) => u.ubicacion },
      { name: 'texto', type: 'text', value: (u) => u.texto },
      { name: 'motivo', type: 'text', value: (u) => u.motivo },
    ],
    unparsed,
    t,
  );

  // El mismo archivo exacto ya entró en un lote confirmado: se procesa igual
  // (todo saldrá IGNORADO), pero se avisa.
  await sequelize.query(
    `UPDATE import_files f
     SET advertencias = f.advertencias || ('archivo_ya_importado_en_lote:' || prev.batch_id)
     FROM (
       SELECT DISTINCT ON (pf.sha256) pf.sha256, pf.batch_id
       FROM import_files pf
       JOIN import_batches b ON b.id = pf.batch_id
       WHERE b.estado = 'CONFIRMADO'
       ORDER BY pf.sha256, b.confirmado_en DESC
     ) prev
     WHERE f.batch_id = :batchId AND f.estado = 'PROCESADO' AND f.sha256 = prev.sha256`,
    { replacements: { batchId }, transaction: t },
  );
}

// -----------------------------------------------------------------------------
// Resumen y huella de la clasificación
// -----------------------------------------------------------------------------
function emptyConteo(): Conteo {
  return { NUEVO: 0, IGNORADO: 0, ADVERTENCIA: 0, CONFLICTO: 0 };
}

/**
 * Huella del lote: clasificación (entidad, clave, estado, acción, campos a completar,
 * horas) + estado de la revisión en línea (correcciones, exclusiones y decisiones).
 * Cualquier edición la cambia: así se detectan cambios concurrentes entre la vista que
 * tiene el usuario y la confirmación.
 */
async function summarizeItems(batchId: string, t: Transaction): Promise<{ huella: string; resumen: BatchSummary }> {
  const counts = await selectAll<{ entidad: ItemEntidad; estado: ItemEstado; n: string }>(
    'SELECT entidad, estado, count(*) AS n FROM import_items WHERE batch_id = :batchId GROUP BY 1, 2',
    { batchId },
    t,
  );
  const extra = await selectOne<{ huella: string; horas: string; actualizar: string; horas_actualizadas: string }>(
    `SELECT
       md5(
         coalesce((SELECT string_agg(concat_ws('|', entidad, clave, estado, accion, completar::text, datos ->> 'horas'),
                                     E'\\n' ORDER BY entidad, clave)
                   FROM import_items WHERE batch_id = :batchId), '')
         || '#' ||
         coalesce((SELECT string_agg(concat_ws('|', pdf_row_id, estado, horas_asignadas, fecha_inicio, fecha_fin, excluida),
                                     E'\\n' ORDER BY pdf_row_id)
                   FROM import_pdf_row_overrides WHERE batch_id = :batchId), '')
         || '#' ||
         coalesce((SELECT string_agg(concat_ws('|', clave, decision, horas_existentes, horas_reporte),
                                     E'\\n' ORDER BY clave)
                   FROM import_enrollment_decisions WHERE batch_id = :batchId), '')
         || '#' ||
         coalesce((SELECT string_agg(concat_ws('|', clave, decision, project_id), E'\\n' ORDER BY clave)
                   FROM import_project_links WHERE batch_id = :batchId), '')
       ) AS huella,
       coalesce(sum((datos ->> 'horas')::int) FILTER (WHERE entidad = 'PARTICIPACION' AND accion = 'INSERTAR'), 0) AS horas,
       count(*) FILTER (WHERE accion = 'ACTUALIZAR') AS actualizar,
       coalesce(sum((datos ->> 'horas')::int - (existente ->> 'horas')::int) FILTER (WHERE accion = 'ACTUALIZAR'), 0)
         AS horas_actualizadas
     FROM import_items WHERE batch_id = :batchId`,
    { batchId },
    t,
  );

  const resumen: BatchSummary = {
    total: emptyConteo(),
    porEntidad: {},
    horasNuevas: Number(extra?.horas ?? 0),
    actualizar: Number(extra?.actualizar ?? 0),
    horasActualizadas: Number(extra?.horas_actualizadas ?? 0),
  };
  for (const row of counts) {
    const n = Number(row.n);
    resumen.total[row.estado] += n;
    (resumen.porEntidad[row.entidad] ??= emptyConteo())[row.estado] += n;
  }
  return { huella: extra?.huella ?? '', resumen };
}

async function medirMaestro(t: Transaction): Promise<MetricasMaestro> {
  const row = await selectOne<MetricasMaestro>(
    `SELECT
       (SELECT count(*) FROM project_enrollments WHERE estado IN ('ASIGNADA', 'EN_CURSO'))::int AS "participacionesActivas",
       (SELECT count(*) FROM project_enrollments WHERE estado = 'FINALIZADA')::int AS "participacionesFinalizadas",
       (SELECT count(*) FROM project_enrollments WHERE estado IN ('RETIRADA', 'CANCELADA'))::int AS "participacionesRetiradas",
       (SELECT count(DISTINCT student_id) FROM project_enrollments
         WHERE estado IN ('ASIGNADA', 'EN_CURSO', 'FINALIZADA'))::int AS participantes,
       (SELECT coalesce(sum(horas), 0) FROM hour_movements)::int AS "horasTotales",
       (SELECT count(*) FROM projects WHERE estado = 'FINALIZADO')::int AS "proyectosFinalizados",
       (SELECT count(*) FROM (SELECT pe.student_id FROM hour_movements hm
                                JOIN project_enrollments pe ON pe.id = hm.enrollment_id
                               GROUP BY 1 HAVING sum(hm.horas) >= :requisito) x)::int AS "estudiantesCon600"`,
    { requisito: HORAS_REQUISITO },
    t,
  );
  return row!;
}

/**
 * Impacto de confirmar: aplica el lote de verdad dentro de un SAVEPOINT, mide el maestro
 * antes y después, y revierte. Es la misma ruta de escritura que la confirmación, así que
 * el número es exacto (salvo que el maestro cambie antes de confirmar: lo detecta la huella).
 */
async function estimarImpacto(t: Transaction): Promise<ImpactoEstimado> {
  const antes = await medirMaestro(t);
  await sequelize.query('SAVEPOINT impacto_vista_previa', { transaction: t });
  try {
    await applyBatch(t);
    const despues = await medirMaestro(t);
    const delta = Object.fromEntries(
      (Object.keys(antes) as Array<keyof MetricasMaestro>).map((k) => [k, despues[k] - antes[k]]),
    ) as unknown as MetricasMaestro;
    return { ok: true, antes, despues, delta };
  } catch (error) {
    const original = (error as { original?: { message?: string } }).original;
    return { ok: false, error: original?.message ?? (error as Error).message };
  } finally {
    await sequelize.query('ROLLBACK TO SAVEPOINT impacto_vista_previa', { transaction: t });
    await sequelize.query('RELEASE SAVEPOINT impacto_vista_previa', { transaction: t });
  }
}

/** Clasifica el lote. Con `impacto`, además simula la confirmación (vista previa y ediciones). */
export async function classifyAndSummarize(batchId: string, t: Transaction, opts: { impacto?: boolean } = {}) {
  await setBatchContext(batchId, t);
  await classifyBatch(t);
  const result = await summarizeItems(batchId, t);
  if (opts.impacto) result.resumen.impacto = await estimarImpacto(t);
  return result;
}

/**
 * Cuadre de cada archivo de horas tras la revisión en línea. `extraido` = filas/horas
 * vigentes (sin excluidas, con correcciones); `ajuste` = lo quitado o cambiado en la
 * revisión, siempre con justificación (equivale a corregir la hoja Control de la plantilla).
 * `ok` exige que lo extraído ORIGINALMENTE cuadre con el reporte: la revisión puede
 * explicar diferencias, nunca tapar un descuadre de la extracción.
 */
export async function recalcularConciliacion(batchId: string, t: Transaction): Promise<void> {
  const rows = await selectAll<{
    archivo: string; conciliacion: Conciliacion[];
    filas_original: number; filas_vigentes: number; horas_original: number; horas_vigentes: number;
  }>(
    `SELECT f.archivo, f.conciliacion,
            count(r.id)::int AS filas_original,
            count(r.id) FILTER (WHERE NOT coalesce(o.excluida, false))::int AS filas_vigentes,
            coalesce(sum(CASE WHEN r.horas_asignadas ~ '^\\d+$' THEN r.horas_asignadas::bigint END), 0)::int AS horas_original,
            coalesce(sum(CASE WHEN NOT coalesce(o.excluida, false) AND coalesce(o.horas_asignadas, r.horas_asignadas) ~ '^\\d+$'
                              THEN coalesce(o.horas_asignadas, r.horas_asignadas)::bigint END), 0)::int AS horas_vigentes
     FROM import_files f
     JOIN import_pdf_rows r ON r.batch_id = f.batch_id AND r.archivo = f.archivo
     LEFT JOIN import_pdf_row_overrides o ON o.batch_id = r.batch_id AND o.pdf_row_id = r.id
     WHERE f.batch_id = :batchId AND f.estado = 'PROCESADO'
       AND f.tipo IN ('PDF_DETALLE_HORAS', 'XLSX_PLANTILLA_REVISION')
     GROUP BY f.archivo, f.conciliacion`,
    { batchId },
    t,
  );
  for (const row of rows) {
    const valores: Record<string, { original: number; vigente: number }> = {
      alumnos: { original: row.filas_original, vigente: row.filas_vigentes },
      horas: { original: row.horas_original, vigente: row.horas_vigentes },
    };
    const conciliacion = row.conciliacion.map((c) => {
      const v = valores[c.control];
      if (!v) return c;
      const ajuste = v.original - v.vigente;
      return {
        control: c.control,
        extraido: v.vigente,
        reporte: c.reporte,
        ok: c.reporte === null || v.original === c.reporte,
        ...(ajuste !== 0 ? { ajuste, extraidoOriginal: v.original } : {}),
      };
    });
    await sequelize.query(
      'UPDATE import_files SET conciliacion = :conciliacion WHERE batch_id = :batchId AND archivo = :archivo',
      { replacements: { batchId, archivo: row.archivo, conciliacion: JSON.stringify(conciliacion) }, transaction: t },
    );
  }
}

// -----------------------------------------------------------------------------
// Lectura
// -----------------------------------------------------------------------------
interface BatchRow {
  id: string;
  estado: string;
  creado_por: string;
  creado_en: Date;
  expira_en: Date;
  confirmado_por: string | null;
  confirmado_en: Date | null;
  resumen: BatchSummary;
  resultado: ApplyResult | null;
  expirado: boolean;
  huella: string | null;
  ediciones: number;
  exclusiones: number;
  decisiones: number;
}

/** Días que se conserva una vista previa VENCIDA con revisión guardada (para renovarla). */
export const DIAS_GRACIA_REVISION = 7;

export const BATCH_COLUMNS = `id, estado, creado_por, creado_en, expira_en, confirmado_por, confirmado_en,
                       resumen, resultado, (estado = 'PREVISUALIZADO' AND expira_en < now()) AS expirado, huella,
                       (SELECT count(*) FROM import_pdf_row_overrides o WHERE o.batch_id = import_batches.id AND NOT o.excluida)::int AS ediciones,
                       (SELECT count(*) FROM import_pdf_row_overrides o WHERE o.batch_id = import_batches.id AND o.excluida)::int AS exclusiones,
                       ((SELECT count(*) FROM import_enrollment_decisions d WHERE d.batch_id = import_batches.id)
                        + (SELECT count(*) FROM import_project_links l WHERE l.batch_id = import_batches.id))::int AS decisiones`;

function batchDTO(row: BatchRow) {
  return {
    id: row.id,
    estado: row.estado,
    creadoPor: row.creado_por,
    creadoEn: row.creado_en,
    expiraEn: row.expira_en,
    expirado: row.expirado,
    confirmadoPor: row.confirmado_por,
    confirmadoEn: row.confirmado_en,
    resumen: row.resumen,
    resultado: row.resultado,
    /** El frontend la devuelve al editar y al confirmar: detecta cambios concurrentes. */
    huella: row.huella,
    revision: { ediciones: row.ediciones, exclusiones: row.exclusiones, decisiones: row.decisiones },
  };
}

export interface ItemFilters {
  estado?: ItemEstado;
  entidad?: ItemEntidad;
}

async function getBatch(id: string, filters: ItemFilters = {}) {
  const batch = await selectOne<BatchRow>(`SELECT ${BATCH_COLUMNS} FROM import_batches WHERE id = :id`, { id });
  if (!batch) throw AppError.notFound('Lote de importación no encontrado');

  const [archivos, lineas, items] = await Promise.all([
    selectAll<Record<string, unknown>>(
      `SELECT archivo, estado, motivo, tipo, sha256, bytes, paginas, titulo,
              periodo_desde AS "periodoDesde", periodo_hasta AS "periodoHasta", generado_en AS "generadoEn",
              filas, advertencias, conciliacion
       FROM import_files WHERE batch_id = :id ORDER BY archivo`,
      { id },
    ),
    selectAll<{ archivo: string; ubicacion: string; texto: string; motivo: string }>(
      'SELECT archivo, ubicacion, texto, motivo FROM import_unparsed_lines WHERE batch_id = :id ORDER BY id',
      { id },
    ),
    selectAll<Record<string, unknown>>(
      `SELECT id, entidad, clave, estado, accion, motivos, datos, existente, completar
       FROM import_items
       WHERE batch_id = :id
         AND (CAST(:estado AS text) IS NULL OR estado = :estado)
         AND (CAST(:entidad AS text) IS NULL OR entidad = :entidad)
       ORDER BY array_position(ARRAY['CONFLICTO','ADVERTENCIA','NUEVO','IGNORADO'], estado),
                array_position(ARRAY['FILA_PDF','FILA_XLS','INSTITUCION','PROYECTO','ESTUDIANTE','PARTICIPACION'], entidad),
                clave`,
      { id, estado: filters.estado ?? null, entidad: filters.entidad ?? null },
    ),
  ]);

  return {
    ...batchDTO(batch),
    archivos: archivos.map((archivo) => ({
      ...archivo,
      lineasNoReconocidas: lineas.filter((l) => l.archivo === archivo.archivo),
    })),
    items: items.map((item) => ({ ...item, id: Number(item.id) })),
  };
}

export type BatchDetailDTO = Awaited<ReturnType<typeof getBatch>>;

// -----------------------------------------------------------------------------
// API del servicio
// -----------------------------------------------------------------------------
export interface ReviewTemplateResult {
  buffer: Buffer;
  filename: string;
  filas: number;
  /** Filas marcadas «Revisar» en la plantilla (ver needsReview). */
  filasConAdvertencias: number;
  lineasNoReconocidas: number;
}

/** "plantilla-revision-20261118-0930.xlsx" en hora de El Salvador. */
function reviewTemplateFilename(now: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/El_Salvador', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  return `plantilla-revision-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}.xlsx`;
}

export const importsService = {
  /**
   * PDF «Detalle de Horas por Proyecto» → plantilla Excel para revisar y corregir a mano
   * antes de importar (ver etl/extract/xlsx-plantilla-revision.ts). No toca la base.
   */
  async buildReviewTemplate(files: readonly UploadedFile[]): Promise<ReviewTemplateResult> {
    const parsed = await parseUploadedFiles(files);
    const pdfs: Array<Extract<ParsedFile, { estado: 'procesado' }>> = [];
    const rechazados: Array<{ archivo: string; motivo: string }> = [];
    for (const file of parsed) {
      if (file.estado === 'rechazado') {
        rechazados.push({ archivo: file.archivo, motivo: file.motivo });
      } else if (file.extraction.file.tipo !== 'PDF_DETALLE_HORAS') {
        rechazados.push({
          archivo: file.archivo,
          motivo: 'La plantilla solo se genera desde los PDF «Detalle de Horas por Proyecto». Suba este archivo directamente en la importación.',
        });
      } else {
        pdfs.push(file);
      }
    }
    if (pdfs.length === 0) {
      throw AppError.unprocessable('Ninguno de los archivos es un PDF «Detalle de Horas por Proyecto» válido.', { rechazados });
    }

    const extractions = pdfs.map((f) => f.extraction);
    const now = new Date();
    const buffer = buildReviewTemplate({ extractions, rechazados, generadoEn: now });
    const rows = extractions.flatMap((e) => e.pdfRows);
    return {
      buffer,
      filename: reviewTemplateFilename(now),
      filas: rows.length,
      filasConAdvertencias: rows.filter((r) => needsReview(r.advertencias)).length,
      lineasNoReconocidas: extractions.reduce((sum, e) => sum + e.unparsed.length, 0),
    };
  },

  /** `actor`: quién sube (queda en creado_por vía fn_current_actor()). */
  async createPreview(files: readonly UploadedFile[], actor: string): Promise<BatchDetailDTO> {
    const parsed = await parseUploadedFiles(files);

    const batchId = await withTransaction(async (t) => {
      // Vistas previas vencidas: se liberan sus filas (cascada) en cada lote nuevo. Las que
      // tienen revisión en línea guardada (correcciones, exclusiones o decisiones) se
      // conservan DIAS_GRACIA_REVISION días más para poder renovarlas sin perder ese trabajo.
      await sequelize.query(
        `DELETE FROM import_batches b
         WHERE b.estado = 'PREVISUALIZADO' AND b.expira_en < now()
           AND (b.expira_en < now() - make_interval(days => :dias)
                OR NOT (EXISTS (SELECT 1 FROM import_pdf_row_overrides o WHERE o.batch_id = b.id)
                        OR EXISTS (SELECT 1 FROM import_enrollment_decisions d WHERE d.batch_id = b.id)
                        OR EXISTS (SELECT 1 FROM import_project_links l WHERE l.batch_id = b.id)))`,
        { replacements: { dias: DIAS_GRACIA_REVISION }, transaction: t },
      );
      const [created] = await execReturning<{ id: string }>(
        'INSERT INTO import_batches DEFAULT VALUES RETURNING id',
        {},
        t,
      );
      const id = created!.id;
      await storeFiles(id, parsed, t);
      const { huella, resumen } = await classifyAndSummarize(id, t, { impacto: true });
      await sequelize.query('UPDATE import_batches SET huella = :huella, resumen = :resumen WHERE id = :id', {
        replacements: { id, huella, resumen: JSON.stringify(resumen) },
        transaction: t,
      });
      return id;
    }, actor);

    return getBatch(batchId);
  },

  getBatch,

  async list(limit = 50) {
    const rows = await selectAll<BatchRow & { archivos: string }>(
      `SELECT ${BATCH_COLUMNS},
              (SELECT count(*) FROM import_files f WHERE f.batch_id = import_batches.id) AS archivos
       FROM import_batches ORDER BY creado_en DESC LIMIT :limit`,
      { limit },
    );
    return rows.map((row) => ({ ...batchDTO(row), archivos: Number(row.archivos) }));
  },

  /**
   * `actor`: quién confirma (confirmado_por y auditoría de cada fila escrita).
   * `huellaVista`: huella del lote que el usuario tiene en pantalla. Si otra persona editó
   * el lote (o el maestro cambió) desde entonces, 409 PREVIEW_DESACTUALIZADA.
   */
  async confirm(id: string, actor: string, huellaVista?: string): Promise<BatchDetailDTO> {
    const outcome = await withTransaction(async (t) => {
      // Una confirmación a la vez: la siguiente espera y reclasifica con lo ya escrito.
      await sequelize.query('SELECT pg_advisory_xact_lock(:key)', {
        replacements: { key: CONFIRM_LOCK_KEY },
        transaction: t,
      });
      const batch = await selectOne<BatchRow>(
        `SELECT ${BATCH_COLUMNS} FROM import_batches WHERE id = :id FOR UPDATE`,
        { id },
        t,
      );
      if (!batch) throw AppError.notFound('Lote de importación no encontrado');
      if (batch.estado === 'CONFIRMADO') throw AppError.conflict('El lote ya fue confirmado', { confirmadoEn: batch.confirmado_en });
      if (batch.estado === 'DESCARTADO') throw AppError.conflict('El lote fue descartado; suba los archivos de nuevo');
      if (batch.expirado) throw AppError.conflict('La vista previa expiró; suba los archivos de nuevo', { expiraEn: batch.expira_en });
      // Revisión concurrente: lo que se ve en pantalla ya no es lo que se va a confirmar.
      if (huellaVista !== undefined && huellaVista !== batch.huella) return 'desactualizado' as const;

      // Misma regla que el frontend, aplicada aquí para que no se salte llamando a la API directo:
      // si lo extraído no cuadra con los totales impresos del reporte, la extracción no es confiable.
      const descuadres = await selectAll<{ archivo: string; controles: string[] }>(
        `SELECT f.archivo, array_agg(c ->> 'control' ORDER BY c ->> 'control') AS controles
         FROM import_files f
         CROSS JOIN LATERAL jsonb_array_elements(f.conciliacion) c
         WHERE f.batch_id = :id AND f.estado = 'PROCESADO' AND (c ->> 'ok')::boolean IS FALSE
         GROUP BY f.archivo
         ORDER BY f.archivo`,
        { id },
        t,
      );
      if (descuadres.length > 0) {
        throw new AppError(
          400,
          'DESCUADRE_TOTALES',
          `No se puede confirmar: ${descuadres.length === 1 ? 'un archivo no cuadra' : `${descuadres.length} archivos no cuadran`} con los totales de su reporte (${descuadres.map((d) => d.archivo).join(', ')}).`,
          { archivos: descuadres },
        );
      }

      // El maestro pudo cambiar desde la vista previa (otra importación, edición en la app).
      const { huella, resumen } = await classifyAndSummarize(id, t);
      if (huella !== batch.huella) {
        // Se guarda la clasificación nueva (COMMIT) para que el usuario la revise, con su impacto.
        resumen.impacto = await estimarImpacto(t);
        await sequelize.query('UPDATE import_batches SET huella = :huella, resumen = :resumen WHERE id = :id', {
          replacements: { id, huella, resumen: JSON.stringify(resumen) },
          transaction: t,
        });
        return 'desactualizado' as const;
      }

      const resultado = await applyBatch(t);
      // Los reportes no traen género ni ubicación: se infieren y se completan los vacíos
      // de todo el maestro (también registros de lotes anteriores), sin pisar valores.
      Object.assign(resultado, await enriquecerMaestro(t));
      await sequelize.query(
        `UPDATE import_batches
         SET estado = 'CONFIRMADO', confirmado_en = now(), confirmado_por = fn_current_actor(), resultado = :resultado
         WHERE id = :id`,
        { replacements: { id, resultado: JSON.stringify(resultado) }, transaction: t },
      );
      return 'confirmado' as const;
    }, actor);

    const detail = await getBatch(id);
    if (outcome === 'desactualizado') {
      throw AppError.conflict(
        'Los datos cambiaron desde la vista previa. Revise la clasificación actualizada y confirme de nuevo.',
        { code: 'PREVIEW_DESACTUALIZADA', lote: detail },
      );
    }
    return detail;
  },

  async discard(id: string, actor: string): Promise<void> {
    await withTransaction(async (t) => {
      const batch = await selectOne<{ estado: string }>(
        'SELECT estado FROM import_batches WHERE id = :id FOR UPDATE',
        { id },
        t,
      );
      if (!batch) throw AppError.notFound('Lote de importación no encontrado');
      if (batch.estado === 'CONFIRMADO') throw AppError.conflict('Un lote confirmado es historial y no se descarta');
      if (batch.estado === 'DESCARTADO') return;
      // Se conserva el lote y sus archivos (quién subió qué); se liberan filas e ítems.
      for (const table of ['import_items', 'import_pdf_rows', 'import_xls_rows', 'import_unparsed_lines']) {
        await sequelize.query(`DELETE FROM ${table} WHERE batch_id = :id`, { replacements: { id }, transaction: t });
      }
      await sequelize.query("UPDATE import_batches SET estado = 'DESCARTADO' WHERE id = :id", {
        replacements: { id },
        transaction: t,
      });
    }, actor);
  },
};
