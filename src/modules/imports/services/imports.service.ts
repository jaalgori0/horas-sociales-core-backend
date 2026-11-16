/**
 * Importación masiva por lotes.
 *
 *   createPreview  archivos → filas del lote → clasificación → vista previa (no toca el maestro)
 *   confirm        advisory lock → reclasifica → si la clasificación cambió, 409 con la nueva
 *                  vista previa; si no, inserción estricta y lote CONFIRMADO
 *   getBatch       lote + archivos + resumen + ítems (filtrables)
 *   discard        descarta una vista previa y libera sus filas
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
import type { ControlTotal, PdfHourRow, UnparsedLine, XlsProjectRow } from '../../../etl/types.js';
import { parseUploadedFiles, type ParsedFile, type UploadedFile } from './file-parser.service.js';
import { applyBatch, classifyBatch, setBatchContext, type ApplyResult } from './import-sql.js';

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
}

interface Conciliacion {
  control: string;
  extraido: number;
  reporte: number | null;
  ok: boolean;
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

  if (extraction.file.tipo === 'PDF_DETALLE_HORAS') {
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

async function summarizeItems(batchId: string, t: Transaction): Promise<{ huella: string; resumen: BatchSummary }> {
  const counts = await selectAll<{ entidad: ItemEntidad; estado: ItemEstado; n: string }>(
    'SELECT entidad, estado, count(*) AS n FROM import_items WHERE batch_id = :batchId GROUP BY 1, 2',
    { batchId },
    t,
  );
  const extra = await selectOne<{ huella: string; horas: string }>(
    `SELECT
       md5(coalesce(string_agg(
         concat_ws('|', entidad, clave, estado, accion, completar::text), E'\\n' ORDER BY entidad, clave), '')) AS huella,
       coalesce(sum((datos ->> 'horas')::int) FILTER (WHERE entidad = 'PARTICIPACION' AND accion = 'INSERTAR'), 0) AS horas
     FROM import_items WHERE batch_id = :batchId`,
    { batchId },
    t,
  );

  const resumen: BatchSummary = { total: emptyConteo(), porEntidad: {}, horasNuevas: Number(extra?.horas ?? 0) };
  for (const row of counts) {
    const n = Number(row.n);
    resumen.total[row.estado] += n;
    (resumen.porEntidad[row.entidad] ??= emptyConteo())[row.estado] += n;
  }
  return { huella: extra?.huella ?? '', resumen };
}

async function classifyAndSummarize(batchId: string, t: Transaction) {
  await setBatchContext(batchId, t);
  await classifyBatch(t);
  return summarizeItems(batchId, t);
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
}

const BATCH_COLUMNS = `id, estado, creado_por, creado_en, expira_en, confirmado_por, confirmado_en,
                       resumen, resultado, (estado = 'PREVISUALIZADO' AND expira_en < now()) AS expirado`;

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
export const importsService = {
  async createPreview(files: readonly UploadedFile[]): Promise<BatchDetailDTO> {
    const parsed = await parseUploadedFiles(files);

    const batchId = await withTransaction(async (t) => {
      // Vistas previas vencidas: se liberan sus filas (cascada) en cada lote nuevo.
      await sequelize.query(
        "DELETE FROM import_batches WHERE estado = 'PREVISUALIZADO' AND expira_en < now()",
        { transaction: t },
      );
      const [created] = await execReturning<{ id: string }>(
        'INSERT INTO import_batches DEFAULT VALUES RETURNING id',
        {},
        t,
      );
      const id = created!.id;
      await storeFiles(id, parsed, t);
      const { huella, resumen } = await classifyAndSummarize(id, t);
      await sequelize.query('UPDATE import_batches SET huella = :huella, resumen = :resumen WHERE id = :id', {
        replacements: { id, huella, resumen: JSON.stringify(resumen) },
        transaction: t,
      });
      return id;
    });

    return getBatch(batchId);
  },

  getBatch,

  async list(limit = 50) {
    const rows = await selectAll<BatchRow & { archivos: string }>(
      `SELECT ${BATCH_COLUMNS},
              (SELECT count(*) FROM import_files f WHERE f.batch_id = b.id) AS archivos
       FROM import_batches b ORDER BY creado_en DESC LIMIT :limit`,
      { limit },
    );
    return rows.map((row) => ({ ...batchDTO(row), archivos: Number(row.archivos) }));
  },

  async confirm(id: string): Promise<BatchDetailDTO> {
    const outcome = await withTransaction(async (t) => {
      // Una confirmación a la vez: la siguiente espera y reclasifica con lo ya escrito.
      await sequelize.query('SELECT pg_advisory_xact_lock(:key)', {
        replacements: { key: CONFIRM_LOCK_KEY },
        transaction: t,
      });
      const batch = await selectOne<BatchRow & { huella: string | null }>(
        `SELECT ${BATCH_COLUMNS}, huella FROM import_batches WHERE id = :id FOR UPDATE`,
        { id },
        t,
      );
      if (!batch) throw AppError.notFound('Lote de importación no encontrado');
      if (batch.estado === 'CONFIRMADO') throw AppError.conflict('El lote ya fue confirmado', { confirmadoEn: batch.confirmado_en });
      if (batch.estado === 'DESCARTADO') throw AppError.conflict('El lote fue descartado; suba los archivos de nuevo');
      if (batch.expirado) throw AppError.conflict('La vista previa expiró; suba los archivos de nuevo', { expiraEn: batch.expira_en });

      // El maestro pudo cambiar desde la vista previa (otra importación, edición en la app).
      const { huella, resumen } = await classifyAndSummarize(id, t);
      if (huella !== batch.huella) {
        // Se guarda la clasificación nueva (COMMIT) para que el usuario la revise.
        await sequelize.query('UPDATE import_batches SET huella = :huella, resumen = :resumen WHERE id = :id', {
          replacements: { id, huella, resumen: JSON.stringify(resumen) },
          transaction: t,
        });
        return 'desactualizado' as const;
      }

      const resultado = await applyBatch(t);
      await sequelize.query(
        `UPDATE import_batches
         SET estado = 'CONFIRMADO', confirmado_en = now(), confirmado_por = fn_current_actor(), resultado = :resultado
         WHERE id = :id`,
        { replacements: { id, resultado: JSON.stringify(resultado) }, transaction: t },
      );
      return 'confirmado' as const;
    }, `import:${id}`);

    const detail = await getBatch(id);
    if (outcome === 'desactualizado') {
      throw AppError.conflict(
        'Los datos cambiaron desde la vista previa. Revise la clasificación actualizada y confirme de nuevo.',
        { code: 'PREVIEW_DESACTUALIZADA', lote: detail },
      );
    }
    return detail;
  },

  async discard(id: string): Promise<void> {
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
    });
  },
};
