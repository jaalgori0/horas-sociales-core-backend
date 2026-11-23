/**
 * Regresión de la importación con revisión en línea (Fase B + Fase A, migración 013).
 *
 *   pnpm test:regresion [--data-dir data] [--keep-db]
 *
 * Seguro por diseño: crea una base DESECHABLE (TEST_DB_NAME, por defecto
 * "hs_regresion_import"; debe empezar por "hs_regresion"), aplica todas las migraciones,
 * corre los escenarios y la borra al final (--keep-db para inspeccionarla). Nunca toca la
 * base de DB_NAME. Necesita los reportes reales en la carpeta de datos (data/ no está en
 * git): sin ellos, termina con código 3 y no prueba nada.
 *
 * Escenarios:
 *   1. Carga inicial e idempotencia (reimportar = 0 nuevos, 0 actualizaciones).
 *   2. Corte anterior fabricado en la base:
 *        Activo → Finalizado (3)           ADVERTENCIA + ACTUALIZAR
 *        Finalizada con más horas (1)      CONFLICTO con decisión requerida
 *        retroceso Finalizada → Activo (1) CONFLICTO estricto
 *        horas que disminuyen (1)          CONFLICTO estricto
 *        horas MANUAL en una que finaliza  no se comparan ni se tocan
 *   3. Revisión en línea: quitar fecha de fin, marcar Finalizado (sigue estricto),
 *      duplicado resuelto excluyendo una fila, edición de horas y reversión, recálculo
 *      del cuadre, justificación obligatoria, bitácora inmutable.
 *   4. Concurrencia (huella), vencimiento, purga con revisión guardada y renovación.
 *   5. Confirmación: impacto estimado = impacto real; MANUAL intacto; reimportación estable.
 *   6. Formatos de nombre (migración 014): mayúsculas/minúsculas, tildes, puntuación, NBSP,
 *      NFD, institución con punto final, varios correlativos con el mismo título (vincular /
 *      crear nuevo / vínculo repetido), correlativo y código con ceros a la izquierda, y
 *      creación manual posterior (409 PROYECTO_SIMILAR / INSTITUCION_SIMILAR).
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import 'dotenv/config';
import { QueryTypes, Sequelize } from 'sequelize';

const args = process.argv.slice(2);
const dataDir = path.resolve(process.cwd(), args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1]! : 'data');
const keepDb = args.includes('--keep-db');
const TEST_DB = process.env.TEST_DB_NAME ?? 'hs_regresion_import';
if (!/^hs_regresion/.test(TEST_DB)) throw new Error(`TEST_DB_NAME debe empezar por "hs_regresion" (recibido "${TEST_DB}")`);
if (TEST_DB === process.env.DB_NAME) throw new Error('TEST_DB_NAME no puede ser la base de la aplicación');

let fallas = 0;
let pasos = 0;
function check(nombre: string, ok: boolean, detalle?: unknown): void {
  pasos++;
  if (ok) console.log(`  ✔ ${nombre}`);
  else {
    fallas++;
    console.log(`  ✖ ${nombre}${detalle !== undefined ? ` → ${JSON.stringify(detalle)}` : ''}`);
  }
}
async function expectError(nombre: string, fn: () => Promise<unknown>, code: string | RegExp): Promise<void> {
  try {
    await fn();
    check(nombre, false, 'no lanzó error');
  } catch (error) {
    const e = error as { details?: { code?: string }; message?: string; original?: { message?: string } };
    const texto = `${e.details?.code ?? ''} ${e.message ?? ''} ${e.original?.message ?? ''}`;
    check(nombre, typeof code === 'string' ? e.details?.code === code : code.test(texto), texto.trim());
  }
}

/** Conexión a la base de mantenimiento "postgres" (crear/borrar la base desechable). */
async function admin<T>(fn: (c: { query: (sql: string) => Promise<unknown> }) => Promise<T>): Promise<T> {
  const client = new Sequelize('postgres', process.env.DB_USER!, process.env.DB_PASSWORD!, {
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), dialect: 'postgres', logging: false,
  });
  try { return await fn({ query: (sql) => client.query(sql) }); } finally { await client.close(); }
}

/** Forma de un ítem de la vista previa (getBatch lo tipa como registro genérico). */
interface ItemT {
  id: number; entidad: string; clave: string; estado: string; accion: string;
  motivos: string[]; datos: Record<string, unknown>; existente: Record<string, unknown> | null;
}

async function main(): Promise<void> {
  const nombres = (await readdir(dataDir).catch(() => [] as string[])).filter((n) => /\.(pdf|xlsx?)$/i.test(n)).sort();
  if (nombres.length === 0) {
    console.error(`✖ No hay reportes en ${dataDir}: la regresión necesita los PDF/Excel del CSS.`);
    process.exitCode = 3;
    return;
  }

  console.log(`Base desechable: ${TEST_DB}`);
  await admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${TEST_DB}`);
  });
  process.env.DB_NAME = TEST_DB;
  execFileSync(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'src/database/migrate.ts', 'up'], {
    env: { ...process.env, DB_NAME: TEST_DB }, stdio: ['ignore', 'ignore', 'inherit'],
  });

  // Importar DESPUÉS de fijar DB_NAME: la configuración lee el entorno al cargarse.
  const { sequelize } = await import('../core/config/database.js');
  const { importsService } = await import('../modules/imports/services/imports.service.js');
  const { importReviewService } = await import('../modules/imports/services/import-review.service.js');
  const { rowActionBodySchema, editRowBodySchema } = await import('../modules/imports/schemas/import.schemas.js');
  const { buildReviewTemplate } = await import('../etl/extract/xlsx-plantilla-revision.js');
  const { projectsService } = await import('../modules/projects/services/projects.service.js');
  const { institutionsService } = await import('../modules/institutions/services/institutions.service.js');
  const { createProjectSchema } = await import('../modules/projects/schemas/project.schemas.js');
  const { createInstitutionSchema } = await import('../modules/institutions/schemas/institution.schemas.js');
  const db = await sequelize.query<{ d: string }>('SELECT current_database() AS d', { type: QueryTypes.SELECT });
  if (db[0]?.d !== TEST_DB) throw new Error(`Conectado a ${db[0]?.d}, no a ${TEST_DB}`);

  const q = <T extends object = Record<string, unknown>>(sql: string, replacements: Record<string, unknown> = {}) =>
    sequelize.query(sql, { type: QueryTypes.SELECT, replacements }) as Promise<T[]>;
  const files = await Promise.all(nombres.map(async (n) => {
    const buffer = await readFile(path.join(dataDir, n));
    return { originalname: n, buffer, size: buffer.length };
  }));
  type Lote = Omit<Awaited<ReturnType<typeof importsService.getBatch>>, 'items' | 'archivos'> & {
    items: ItemT[];
    archivos: Array<{ archivo: string; conciliacion: unknown }>;
  };
  const L = (lote: Awaited<ReturnType<typeof importsService.getBatch>>) => lote as unknown as Lote;
  const items = (lote: Lote, f: (i: ItemT) => boolean) => lote.items.filter(f);
  const part = (lote: Lote, clave: string) => lote.items.find((i) => i.entidad === 'PARTICIPACION' && i.clave === clave);
  const filaPdf = (lote: Lote, carnet: string) =>
    lote.items.find((i) => i.entidad === 'FILA_PDF' && i.datos.carnet === carnet);
  const conteo = (lote: Lote, entidad: string, estado: string) => lote.items.filter((i) => i.entidad === entidad && i.estado === estado).length;
  const actor = 'regresion@prueba';

  try {
    // ── 1. Carga inicial e idempotencia ─────────────────────────────────────
    console.log('\n1) Carga inicial e idempotencia');
    const inicial = L(await importsService.createPreview(files, actor));
    check('vista previa con impacto estimado', (inicial.resumen as { impacto?: { ok: boolean } }).impacto?.ok === true);
    await importsService.confirm(inicial.id, actor, inicial.huella ?? undefined);
    const re = L(await importsService.createPreview(files, actor));
    check('reimportar: 0 participaciones nuevas', conteo(re, 'PARTICIPACION', 'NUEVO') === 0);
    check('reimportar: 0 actualizaciones', items(re, (i) => i.accion === 'ACTUALIZAR').length === 0);
    check('reimportar: 0 conflictos de participación', conteo(re, 'PARTICIPACION', 'CONFLICTO') === 0);
    await importsService.discard(re.id, actor);

    // ── 2. Corte anterior fabricado ─────────────────────────────────────────
    console.log('\n2) Corte anterior fabricado en la base');
    type Fila = { id: string; clave: string; horas: number };
    const candidatas = await q<Fila>(
      `SELECT pe.id, s.carnet || '@' || i.codigo_css || '/' || p.correlativo_css AS clave, sum(hm.horas)::int AS horas
       FROM project_enrollments pe
       JOIN students s ON s.id = pe.student_id JOIN projects p ON p.id = pe.project_id
       JOIN institutions i ON i.id = p.institution_id
       JOIN hour_movements hm ON hm.enrollment_id = pe.id AND hm.origen = 'IMPORTACION'
       WHERE pe.estado = 'FINALIZADA'
       GROUP BY pe.id, s.carnet, i.codigo_css, p.correlativo_css
       HAVING sum(hm.horas) > 150
       ORDER BY s.carnet LIMIT 5`,
    );
    const [act] = await q<{ id: string; clave: string }>(
      `SELECT pe.id, s.carnet || '@' || i.codigo_css || '/' || p.correlativo_css AS clave
       FROM project_enrollments pe JOIN students s ON s.id = pe.student_id
       JOIN projects p ON p.id = pe.project_id JOIN institutions i ON i.id = p.institution_id
       WHERE pe.estado = 'EN_CURSO' ORDER BY s.carnet LIMIT 1`,
    );
    const finaliza = candidatas.slice(0, 3);
    const ajuste = candidatas[3]!;
    const disminuye = candidatas[4]!;
    for (const f of finaliza) {
      await sequelize.query(`DELETE FROM hour_movements WHERE enrollment_id = :id AND origen = 'IMPORTACION'`, { replacements: { id: f.id } });
      await sequelize.query(`UPDATE project_enrollments SET estado = 'EN_CURSO', cerrada_en = NULL WHERE id = :id`, { replacements: { id: f.id } });
    }
    await sequelize.query(
      `INSERT INTO hour_movements (enrollment_id, horas, naturaleza, fecha_horas, descripcion, solicitud_id, origen, concepto)
       VALUES (:id, 40, 'EXTERNA', current_date, 'manual de prueba', gen_random_uuid(), 'MANUAL', 'Convalidación de prueba')`,
      { replacements: { id: finaliza[0]!.id } },
    );
    await sequelize.query(`UPDATE hour_movements SET horas = horas - 100 WHERE enrollment_id = :id AND origen = 'IMPORTACION'`, { replacements: { id: ajuste.id } });
    await sequelize.query(`UPDATE hour_movements SET horas = horas + 50 WHERE enrollment_id = :id AND origen = 'IMPORTACION'`, { replacements: { id: disminuye.id } });
    await sequelize.query(
      `UPDATE project_enrollments SET estado = 'FINALIZADA', cerrada_en = asignada_en + interval '10 days' WHERE id = :id`,
      { replacements: { id: act!.id } },
    );

    let lote = L(await importsService.createPreview(files, actor));
    for (const f of finaliza) {
      const it = part(lote, f.clave);
      check(`Activo→Finalizado ${f.clave}: ADVERTENCIA + ACTUALIZAR`, it?.estado === 'ADVERTENCIA' && it.accion === 'ACTUALIZAR', it);
    }
    const itAjuste = part(lote, ajuste.clave);
    check('Finalizada con más horas: CONFLICTO con decisión requerida',
      itAjuste?.estado === 'CONFLICTO' && itAjuste.motivos.includes('requiere_decision'), itAjuste?.motivos);
    const itRetro = part(lote, act!.clave);
    check('retroceso Finalizada→Activo: CONFLICTO estricto',
      itRetro?.estado === 'CONFLICTO' && itRetro.motivos.includes('retroceso_de_estado') && !itRetro.motivos.includes('requiere_decision'), itRetro?.motivos);
    const itBaja = part(lote, disminuye.clave);
    check('horas que disminuyen: CONFLICTO estricto',
      itBaja?.estado === 'CONFLICTO' && itBaja.motivos.includes('horas_disminuyen'), itBaja?.motivos);
    check('MANUAL no se compara (la que finaliza sigue con 0 h CSS en la base)',
      Number((part(lote, finaliza[0]!.clave)?.existente as { horas?: number } | null)?.horas) === 0);
    const imp = (lote.resumen as { impacto?: { ok: boolean; delta?: Record<string, number> } }).impacto;
    const horasFinaliza = finaliza.reduce((s, f) => s + f.horas, 0);
    check('impacto: −3 activas, +3 finalizadas, +horas de las 3',
      imp?.ok === true && imp.delta?.participacionesActivas === -3 && imp.delta?.participacionesFinalizadas === 3
        && imp.delta?.horasTotales === horasFinaliza, imp?.delta);

    // Decisión: con huella vieja → 409; con la vigente → ACTUALIZAR.
    await expectError('decisión con huella vieja → 409 REVISION_DESACTUALIZADA',
      () => importReviewService.decide(lote.id, { huella: 'vieja', clave: ajuste.clave, decision: 'ACEPTAR_REPORTE', justificacion: 'El CSS corrigió horas' }, actor),
      'REVISION_DESACTUALIZADA');
    await expectError('decisión en una participación que no la admite → 422',
      () => importReviewService.decide(lote.id, { huella: lote.huella!, clave: act!.clave, decision: 'ACEPTAR_REPORTE', justificacion: 'No debería poder' }, actor),
      /no admite decisión/);
    lote = L(await importReviewService.decide(lote.id, { huella: lote.huella!, clave: ajuste.clave, decision: 'CONSERVAR_BD', justificacion: 'Verificar con el CSS' }, actor));
    check('CONSERVAR_BD → IGNORADO', part(lote, ajuste.clave)?.estado === 'IGNORADO');
    lote = L(await importReviewService.decide(lote.id, { huella: lote.huella!, clave: ajuste.clave, decision: 'ACEPTAR_REPORTE', justificacion: 'El CSS confirmó la corrección' }, actor));
    const itAj2 = part(lote, ajuste.clave);
    check('ACEPTAR_REPORTE → ADVERTENCIA + ACTUALIZAR', itAj2?.estado === 'ADVERTENCIA' && itAj2.accion === 'ACTUALIZAR', itAj2);

    // ── 3. Revisión en línea de filas ───────────────────────────────────────
    console.log('\n3) Revisión en línea de filas del PDF');
    const conActivoFin = items(lote, (i) => i.entidad === 'FILA_PDF' && i.motivos.includes('activo_con_fin'));
    check('hay filas "Activo con fecha de fin"', conActivoFin.length >= 2, conActivoFin.length);
    const [filaA, filaB] = conActivoFin;
    const rowA = Number((filaA!.datos as { pdfRowId: number }).pdfRowId);
    const carnetA = String((filaA!.datos as { carnet: string }).carnet);
    lote = L(await importReviewService.editRow(lote.id, rowA, { huella: lote.huella!, justificacion: 'Activo: se quita la fecha de fin', cambios: { fechaFin: '01/01/1900' } }, actor));
    check('quitar fecha de fin: la fila deja de estar en conflicto', !filaPdf(lote, carnetA));
    const partA = lote.items.find((i) => i.entidad === 'PARTICIPACION' && i.clave.startsWith(`${carnetA}@`));
    check('… y su participación entra marcada como editada', partA?.accion === 'INSERTAR' && partA.motivos.includes('fila_editada_en_revision'), partA);

    const rowB = Number((filaB!.datos as { pdfRowId: number }).pdfRowId);
    const carnetB = String((filaB!.datos as { carnet: string }).carnet);
    lote = L(await importReviewService.editRow(lote.id, rowB, { huella: lote.huella!, justificacion: 'Marcar como finalizado', cambios: { estado: 'Finalizado' } }, actor));
    const fB = filaPdf(lote, carnetB);
    check('marcar Finalizado con fin < inicio: sigue en CONFLICTO (regla estricta)',
      fB?.estado === 'CONFLICTO' && fB.motivos.includes('fin_antes_de_inicio') && !fB.motivos.includes('activo_con_fin'), fB?.motivos);

    // Horas: edición y reversión con recálculo del cuadre.
    const archivoB = String((filaB!.datos as { archivo: string }).archivo);
    lote = L(await importReviewService.editRow(lote.id, rowB, { huella: lote.huella!, justificacion: 'Prueba de cuadre de horas', cambios: { horas: 5 } }, actor));
    const cuadreB = lote.archivos.find((a) => a.archivo === archivoB)?.conciliacion as Array<{ control: string; ajuste?: number; ok: boolean }>;
    const horasB = cuadreB.find((c) => c.control === 'horas');
    check('editar horas: el cuadre muestra el ajuste justificado y sigue ok', horasB?.ajuste === -5 && horasB.ok, horasB);
    lote = L(await importReviewService.editRow(lote.id, rowB, { huella: lote.huella!, justificacion: 'Revertir horas', cambios: { horas: null } }, actor));
    const horasB2 = (lote.archivos.find((a) => a.archivo === archivoB)?.conciliacion as Array<{ control: string; ajuste?: number }>).find((c) => c.control === 'horas');
    check('revertir horas: el ajuste desaparece', horasB2?.ajuste === undefined, horasB2);

    // Duplicado en el lote: excluir una fila conserva la otra.
    const dups = items(lote, (i) => i.entidad === 'FILA_PDF' && i.motivos.includes('participacion_duplicada_en_lote'));
    check('hay una participación duplicada en el lote', dups.length === 2, dups.length);
    const activa = dups.find((d) => (d.datos as { estado: string }).estado === 'Activo')!;
    const carnetDup = String((activa.datos as { carnet: string }).carnet);
    const archivoDup = String((activa.datos as { archivo: string }).archivo);
    lote = L(await importReviewService.excludeRow(lote.id, Number((activa.datos as { pdfRowId: number }).pdfRowId), { huella: lote.huella!, justificacion: 'Fila repetida del reporte; se conserva la finalizada' }, actor));
    const partDup = lote.items.find((i) => i.entidad === 'PARTICIPACION' && i.clave.startsWith(`${carnetDup}@`));
    check('duplicado: se conserva la fila válida (INSERTAR)', partDup?.accion === 'INSERTAR' && (partDup.datos as { estado: string }).estado === 'FINALIZADA', partDup);
    check('la fila excluida queda en Ignorados con su justificación',
      filaPdf(lote, carnetDup)?.estado === 'IGNORADO' && filaPdf(lote, carnetDup)?.motivos.includes('fila_excluida_en_revision') === true);
    const alumnosDup = (lote.archivos.find((a) => a.archivo === archivoDup)?.conciliacion as Array<{ control: string; extraido: number; ajuste?: number; reporte: number; ok: boolean }>).find((c) => c.control === 'alumnos');
    check('cuadre recalculado: extraído + ajuste = reporte', alumnosDup !== undefined && alumnosDup.extraido + (alumnosDup.ajuste ?? 0) === alumnosDup.reporte && alumnosDup.ok, alumnosDup);
    await expectError('editar una fila excluida → 409', () => importReviewService.editRow(lote.id, Number((activa.datos as { pdfRowId: number }).pdfRowId), { huella: lote.huella!, justificacion: 'No debería', cambios: { horas: 1 } }, actor), /excluida/);

    check('justificación obligatoria al excluir', !rowActionBodySchema.safeParse({ huella: 'x' }).success);
    check('justificación de menos de 5 caracteres se rechaza', !rowActionBodySchema.safeParse({ huella: 'x', justificacion: 'ok' }).success);
    check('fecha inexistente se rechaza', !editRowBodySchema.safeParse({ huella: 'x', justificacion: 'fecha mala', cambios: { fechaFin: '31/02/2026' } }).success);

    const log = (await importReviewService.log(lote.id)) as Array<Record<string, unknown>>;
    check('bitácora con cada acción (2 decisiones + 4 ediciones + 1 exclusión)', log.length === 7, log.length);
    check('bitácora guarda original y nuevo', log.every((l) => 'valorOriginal' in l && 'valorNuevo' in l && typeof l.justificacion === 'string'));
    await expectError('bitácora inmutable (UPDATE rechazado)', () => sequelize.query('UPDATE import_review_log SET justificacion = :j', { replacements: { j: 'alterada' } }), /solo inserción/);
    const [filaIntacta] = await q<{ fecha_fin: string }>('SELECT fecha_fin FROM import_pdf_rows WHERE id = :id', { id: rowA });
    check('import_pdf_rows conserva el valor original del PDF', filaIntacta?.fecha_fin !== '01/01/1900', filaIntacta);

    // ── 4. Concurrencia, vencimiento, purga y renovación ────────────────────
    console.log('\n4) Concurrencia, vencimiento, purga y renovación');
    await expectError('confirmar con huella vieja → 409 PREVIEW_DESACTUALIZADA', () => importsService.confirm(lote.id, actor, 'vieja'), 'PREVIEW_DESACTUALIZADA');
    await sequelize.query(`UPDATE import_batches SET expira_en = now() - interval '1 hour' WHERE id = :id`, { replacements: { id: lote.id } });
    await expectError('editar una vista previa vencida → 409 PREVIEW_VENCIDA',
      () => importReviewService.editRow(lote.id, rowB, { huella: lote.huella!, justificacion: 'Tarde', cambios: { horas: 1 } }, actor), 'PREVIEW_VENCIDA');
    const otro = L(await importsService.createPreview(files.slice(0, 1), actor)); // dispara la purga
    await importsService.discard(otro.id, actor);
    const [sigue] = await q<{ n: number }>('SELECT count(*)::int AS n FROM import_batches WHERE id = :id', { id: lote.id });
    check('la purga conserva la vista previa vencida con revisión guardada', sigue?.n === 1);
    lote = L(await importReviewService.renew(lote.id, actor));
    check('renovar: vuelve a estar vigente con sus correcciones', !lote.expirado && lote.revision.ediciones >= 2 && lote.revision.exclusiones === 1, lote.revision);

    // ── 5. Confirmación ──────────────────────────────────────────────────────
    console.log('\n5) Confirmación e idempotencia');
    const estimado = (lote.resumen as { impacto?: { ok: boolean; despues?: Record<string, number> } }).impacto;
    const [manualAntes] = await q<{ horas: number }>(`SELECT coalesce(sum(horas), 0)::int AS horas FROM hour_movements WHERE origen = 'MANUAL'`);
    const confirmado = L(await importsService.confirm(lote.id, actor, lote.huella!));
    const res = confirmado.resultado as Record<string, { n: number }>;
    check('participaciones actualizadas = 3 finalizan + 1 ajuste aceptado', res.participaciones_actualizadas?.n === 4, res.participaciones_actualizadas);
    const medidas = await q<Record<string, number>>(
      `SELECT (SELECT count(*) FROM project_enrollments WHERE estado IN ('ASIGNADA','EN_CURSO'))::int AS "participacionesActivas",
              (SELECT count(*) FROM project_enrollments WHERE estado = 'FINALIZADA')::int AS "participacionesFinalizadas",
              (SELECT coalesce(sum(horas), 0) FROM hour_movements)::int AS "horasTotales"`,
    );
    check('impacto estimado = resultado real',
      estimado?.ok === true && ['participacionesActivas', 'participacionesFinalizadas', 'horasTotales'].every((k) => estimado.despues?.[k] === medidas[0]?.[k]),
      { estimado: estimado?.despues, real: medidas[0] });
    const [manualDespues] = await q<{ horas: number }>(`SELECT coalesce(sum(horas), 0)::int AS horas FROM hour_movements WHERE origen = 'MANUAL'`);
    check('horas MANUAL intactas', manualDespues?.horas === manualAntes?.horas && manualAntes?.horas === 40);
    const css = await q<{ id: string; horas: number; movs: number }>(
      `SELECT pe.id, coalesce(sum(hm.horas) FILTER (WHERE hm.origen = 'IMPORTACION'), 0)::int AS horas,
              count(hm.id) FILTER (WHERE hm.origen = 'IMPORTACION')::int AS movs
       FROM project_enrollments pe LEFT JOIN hour_movements hm ON hm.enrollment_id = pe.id
       WHERE pe.id IN (:ids) GROUP BY pe.id`,
      { ids: [...finaliza, ajuste].map((f) => f.id) },
    );
    const esperado = new Map([...finaliza, ajuste].map((f) => [f.id, f.horas]));
    check('horas CSS = reporte, un solo movimiento CSS por participación',
      css.length === 4 && css.every((c) => c.horas === esperado.get(c.id) && c.movs === 1), css);

    const fin = L(await importsService.createPreview(files, actor));
    check('reimportar tras confirmar: 0 actualizaciones pendientes', items(fin, (i) => i.accion === 'ACTUALIZAR').length === 0);
    check('reimportar tras confirmar: 0 participaciones nuevas', conteo(fin, 'PARTICIPACION', 'NUEVO') + items(fin, (i) => i.entidad === 'PARTICIPACION' && i.accion === 'INSERTAR').length === 0);
    check('solo quedan los 2 conflictos estrictos fabricados',
      conteo(fin, 'PARTICIPACION', 'CONFLICTO') === 2 && part(fin, act!.clave)?.estado === 'CONFLICTO' && part(fin, disminuye.clave)?.estado === 'CONFLICTO',
      items(fin, (i) => i.entidad === 'PARTICIPACION' && i.estado === 'CONFLICTO').map((i) => i.clave));
    await importsService.discard(fin.id, actor);

    // ── 6. Formatos de nombre (migración 014) ───────────────────────────────
    console.log('\n6) Formatos de nombre: mayúsculas, tildes, puntuación, NBSP, NFD, correlativos');
    let carnetSeq = 99_000_000;
    type FilaLote = { cod: string; institucion: string; corr: string; proyecto: string; carnet?: string };
    /** Plantilla de revisión sintética: entra por el flujo real de importación (con su cuadre). */
    const plantilla = (nombre: string, filas: FilaLote[]) => {
      const archivo = `${nombre}.pdf`;
      const pdfRows = filas.map((f, idx) => {
        const carnet = f.carnet ?? String(++carnetSeq).padStart(8, '0');
        return {
          archivo, pagina: 1, linea: idx + 1, bloque: null, proyectoNombre: f.proyecto, correlativo: f.corr, carnet,
          nombreCompleto: `PRUEBA, CLAVE ALUMNO ${carnet}`, fechaInicio: '01/02/2026', fechaFin: '01/03/2026',
          codInstitucion: f.cod, institucion: f.institucion, carrera: 'INGENIERIA CIVIL', horasAsignadas: '100',
          estado: 'Finalizado', textoOriginal: '', advertencias: [] as string[],
        };
      });
      const total = (metrica: 'ALUMNOS' | 'HORAS', valor: number) =>
        ({ archivo, ubicacion: 'p1', alcance: 'ARCHIVO' as const, bloque: null, clave: null, metrica, valor: String(valor) });
      const buffer = buildReviewTemplate({
        extractions: [{
          file: { archivo, tipo: 'PDF_DETALLE_HORAS', sha256: randomBytes(32).toString('hex'), paginas: 1,
                  titulo: 'Detalle de Horas por Proyecto', periodoDesde: '01/01/2026', periodoHasta: '20/11/2026', generadoEn: null },
          pdfRows, xlsRows: [], controlTotals: [total('ALUMNOS', pdfRows.length), total('HORAS', pdfRows.length * 100)], unparsed: [],
        }],
        rechazados: [],
        generadoEn: new Date(),
      });
      return { file: { originalname: `${nombre}.xlsx`, buffer, size: buffer.length }, carnets: pdfRows.map((r) => r.carnet) };
    };
    const item = (lote: Lote, entidad: string, clave: string) => lote.items.find((i) => i.entidad === entidad && i.clave === clave);
    const nuevaInstitucion = async (nombre: string) =>
      (await institutionsService.create(createInstitutionSchema.parse({ nombre }))) as unknown as { id: string };
    const nuevoProyecto = async (institutionId: string, titulo: string, confirmarSimilar?: boolean) =>
      (await projectsService.create(createProjectSchema.parse({ institutionId, titulo, ...(confirmarSimilar ? { confirmarSimilar } : {}) }))) as unknown as { id: string };

    const [norm] = await q<Record<string, string>>(
      `SELECT fn_nombre_clave('APOYO JURÍDICO ADMINISTRATIVO') AS a, fn_nombre_clave('apoyo  juridico-administrativo.') AS b,
              fn_nombre_clave('APOYO' || chr(160) || 'JURI' || chr(769) || 'DICO, ADMINISTRATIVO') AS c,
              fn_import_numero('007') AS n`,
    );
    check('nombre_clave: mayúsculas, tildes, puntuación, NBSP y NFD dan la misma clave',
      norm?.a === 'apoyo juridico administrativo' && norm.b === norm.a && norm.c === norm.a, norm);
    check('fn_import_numero: "007" → "7"', norm?.n === '7');

    // Datos creados en la app (sin código CSS ni correlativo).
    const instS1 = await nuevaInstitucion('Fundación Prueba Clave');
    const projS1 = await nuevoProyecto(instS1.id, 'APOYO JURÍDICO ADMINISTRATIVO');
    const instS2 = await nuevaInstitucion('Asociación Ágape Prueba');
    const projS2 = await nuevoProyecto(instS2.id, 'Refuerzo escolar, niñez');
    const instS4 = await nuevaInstitucion('Centro Prueba Multi');
    const projS4 = await nuevoProyecto(instS4.id, 'REFUERZO ACADEMICO PRUEBA');
    const [fiscalia] = await q<{ codigo_css: string }>(
      `SELECT codigo_css FROM institutions WHERE nombre_clave = fn_nombre_clave('Fiscalía General de la República') AND codigo_css IS NOT NULL`,
    );

    const lote6 = plantilla('formatos-nombre', [
      { cod: '90001', institucion: 'FUNDACION PRUEBA CLAVE', corr: '1', proyecto: 'apoyo juridico administrativo' },
      { cod: '90002', institucion: 'ASOCIACION AGAPE PRUEBA.', corr: '1', proyecto: 'REFUERZO ESCOLAR NIÑEZ' },
      { cod: '90003', institucion: 'Fiscalía General de la República', corr: '1', proyecto: 'APOYO EN RESOLUCIONES PRUEBA' },
      { cod: '90004', institucion: 'CENTRO PRUEBA MULTI', corr: '5', proyecto: 'Refuerzo académico prueba' },
      { cod: '90004', institucion: 'CENTRO PRUEBA MULTI', corr: '6', proyecto: 'Refuerzo académico prueba' },
    ]);
    let l6 = L(await importsService.createPreview([lote6.file], actor));

    const i1 = item(l6, 'INSTITUCION', '90001');
    const p1 = item(l6, 'PROYECTO', '90001/1');
    check('mayúsculas/minúsculas: adopta la institución de la app (completa código)', i1?.accion === 'COMPLETAR' && i1.existente?.id === instS1.id, i1);
    check('mayúsculas/minúsculas: adopta el proyecto de la app, sin crear otro',
      p1?.accion === 'COMPLETAR' && p1.existente?.id === projS1.id && p1.motivos.includes('adopta_proyecto_sin_correlativo'), p1);

    const i2 = item(l6, 'INSTITUCION', '90002');
    const p2 = item(l6, 'PROYECTO', '90002/1');
    check('institución con punto final: se adopta por nombre equivalente (con aviso)',
      i2?.accion === 'COMPLETAR' && i2.existente?.id === instS2.id && i2.motivos.includes('adopta_institucion_nombre_similar'), i2);
    check('NBSP + NFD + coma: adopta el proyecto de la app y avisa que el título no es idéntico',
      p2?.accion === 'COMPLETAR' && p2.existente?.id === projS2.id && p2.motivos.includes('titulo_similar_no_identico'), p2);

    if (fiscalia) {
      const i3 = item(l6, 'INSTITUCION', '90003');
      check(`institución parecida a otra con otro código (${fiscalia.codigo_css}): se crea con aviso`,
        i3?.accion === 'INSERTAR' && i3.estado === 'ADVERTENCIA' && i3.motivos.some((m) => m.startsWith('institucion_similar_con_otro_codigo:')), i3);
    } else {
      check('(datos) existe la Fiscalía importada para el escenario de punto final', false);
    }

    const p5 = item(l6, 'PROYECTO', '90004/5');
    const p6 = item(l6, 'PROYECTO', '90004/6');
    check('varios correlativos con el mismo título: CONFLICTO "vincular", no copias silenciosas',
      p5?.estado === 'CONFLICTO' && p6?.estado === 'CONFLICTO' && p5.motivos.includes('requiere_vincular_proyecto_app')
        && Array.isArray(p5.datos.candidatosApp) && (p5.datos.candidatosApp as Array<{ id: string }>)[0]?.id === projS4.id, { p5, p6 });
    const partS4 = l6.items.filter((i) => i.entidad === 'PARTICIPACION' && i.clave.includes('@90004/'));
    check('… y sus participaciones esperan la decisión (proyecto en conflicto)',
      partS4.length === 2 && partS4.every((i) => i.estado === 'CONFLICTO' && i.motivos.includes('proyecto_en_conflicto')), partS4.map((i) => i.motivos));

    await expectError('vincular un proyecto sin coincidencias en la app → 422',
      () => importReviewService.linkProject(l6.id, { huella: l6.huella!, clave: '90003/1', decision: 'CREAR_NUEVO', justificacion: 'No aplica aquí' }, actor),
      /no coincide/);
    l6 = L(await importReviewService.linkProject(l6.id, { huella: l6.huella!, clave: '90004/5', decision: 'VINCULAR', projectId: projS4.id, justificacion: 'Es el proyecto creado en la app' }, actor));
    l6 = L(await importReviewService.linkProject(l6.id, { huella: l6.huella!, clave: '90004/6', decision: 'VINCULAR', projectId: projS4.id, justificacion: 'Prueba de vínculo repetido' }, actor));
    check('dos correlativos vinculados al mismo proyecto de la app: CONFLICTO "vínculo repetido"',
      ['90004/5', '90004/6'].every((c) => item(l6, 'PROYECTO', c)?.motivos.includes('vinculo_repetido')));
    l6 = L(await importReviewService.linkProject(l6.id, { huella: l6.huella!, clave: '90004/6', decision: 'CREAR_NUEVO', justificacion: 'Es otro proyecto del CSS' }, actor));
    const v5 = item(l6, 'PROYECTO', '90004/5');
    const v6 = item(l6, 'PROYECTO', '90004/6');
    check('VINCULAR: adopta el proyecto de la app', v5?.accion === 'COMPLETAR' && v5.existente?.id === projS4.id && v5.motivos.includes('vinculado_en_revision'), v5);
    check('CREAR_NUEVO: se crea a sabiendas (con aviso)', v6?.accion === 'INSERTAR' && v6.motivos.includes('se_crea_aunque_existe_en_app'), v6);

    await importsService.confirm(l6.id, actor, l6.huella!);
    const proyectos = await q<{ cod: string; correlativo: string | null; id: string }>(
      `SELECT i.codigo_css AS cod, p.correlativo_css AS correlativo, p.id
       FROM projects p JOIN institutions i ON i.id = p.institution_id
       WHERE i.id IN (:ids) ORDER BY 1, 2`,
      { ids: [instS1.id, instS2.id, instS4.id] },
    );
    check('tras confirmar: los proyectos de la app recibieron su correlativo, sin copias',
      proyectos.length === 4
        && proyectos.find((p) => p.id === projS1.id)?.correlativo === '1'
        && proyectos.find((p) => p.id === projS2.id)?.correlativo === '1'
        && proyectos.find((p) => p.id === projS4.id)?.correlativo === '5'
        && proyectos.filter((p) => p.cod === '90004').length === 2,
      proyectos);

    // Correlativo y código con ceros a la izquierda: mismo proyecto, ninguna copia.
    const ceros = plantilla('ceros-izquierda', [
      { cod: '090004', institucion: 'CENTRO PRUEBA MULTI', corr: '05', proyecto: 'REFUERZO ACADEMICO PRUEBA' },
      { cod: '090004', institucion: 'CENTRO PRUEBA MULTI', corr: '006', proyecto: 'Refuerzo académico prueba' },
    ]);
    const lc = L(await importsService.createPreview([ceros.file], actor));
    check('código "090004" y correlativos "05"/"006": emparejan con 90004/5 y 90004/6',
      item(lc, 'INSTITUCION', '90004')?.accion === 'NINGUNA'
        && item(lc, 'PROYECTO', '90004/5') !== undefined && item(lc, 'PROYECTO', '90004/6') !== undefined
        && items(lc, (i) => (i.entidad === 'PROYECTO' || i.entidad === 'INSTITUCION') && i.accion === 'INSERTAR').length === 0,
      lc.items.filter((i) => i.entidad !== 'PARTICIPACION' && i.entidad !== 'ESTUDIANTE').map((i) => `${i.entidad} ${i.clave} ${i.accion}`));
    await importsService.discard(lc.id, actor);

    // Creación manual posterior en la app.
    await expectError('crear en la app un proyecto equivalente a uno importado → 409 PROYECTO_SIMILAR',
      () => nuevoProyecto(instS4.id, 'refuerzo académico prueba.'), 'PROYECTO_SIMILAR');
    try {
      await nuevoProyecto(instS4.id, 'refuerzo académico prueba.');
    } catch (error) {
      const d = (error as { details?: { similares?: Array<{ correlativoCss: string | null }>; puedeConfirmar?: boolean } }).details;
      check('… la respuesta lista los existentes con su correlativo y permite confirmar',
        d?.puedeConfirmar === true && (d.similares ?? []).map((x) => x.correlativoCss).sort().join(',') === '5,6', d);
    }
    const confirmado6 = await nuevoProyecto(instS4.id, 'refuerzo académico prueba.', true);
    check('confirmar: se crea a sabiendas', typeof confirmado6.id === 'string');
    try {
      await nuevoProyecto(instS4.id, 'REFUERZO ACADÉMICO PRUEBA.', true);
      check('duplicado exacto de un proyecto de la app no se puede confirmar', false);
    } catch (error) {
      const d = (error as { details?: { code?: string; puedeConfirmar?: boolean } }).details;
      check('duplicado exacto de un proyecto de la app no se puede confirmar', d?.code === 'PROYECTO_SIMILAR' && d.puedeConfirmar === false, d);
    }
    await expectError('renombrar un proyecto a un nombre equivalente → 409 PROYECTO_SIMILAR',
      () => projectsService.update(projS1.id, { titulo: 'Refuerzo académico prueba', institutionId: instS4.id } as never), 'PROYECTO_SIMILAR');
    await expectError('crear en la app una institución equivalente → 409 INSTITUCION_SIMILAR',
      () => nuevaInstitucion('CENTRO PRUEBA MULTI.'), 'INSTITUCION_SIMILAR');
    const instConfirmada = (await institutionsService.create(
      createInstitutionSchema.parse({ nombre: 'CENTRO PRUEBA MULTI.', confirmarSimilar: true }),
    )) as unknown as { id: string };
    check('institución equivalente confirmada: se crea a sabiendas', typeof instConfirmada.id === 'string');
  } finally {
    await sequelize.close();
    if (!keepDb) await admin((c) => c.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`));
    else console.log(`\n(base ${TEST_DB} conservada por --keep-db)`);
  }

  console.log(`\n${fallas === 0 ? '✔' : '✖'} ${pasos - fallas}/${pasos} verificaciones correctas`);
  if (fallas > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\n✖ Error en la regresión:', error);
  process.exitCode = 1;
});
