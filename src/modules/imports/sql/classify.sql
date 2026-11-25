-- =============================================================================
-- Importación masiva — VALIDACIÓN y CLASIFICACIÓN de un lote. No escribe en el maestro.
--
-- Entrada : import_pdf_rows / import_xls_rows del lote fn_import_actual().
-- Salida  : import_items del lote (reescritos) + tablas temporales t_*_c que
--           apply.sql usa cuando la clasificación corre dentro de la confirmación.
--
-- Lo ejecuta src/modules/imports/services/import-sql.ts dentro de una transacción
-- con app.import_id fijado. Las tablas temporales son privadas de la conexión
-- (ON COMMIT DROP): dos lotes clasificándose a la vez no se ven entre sí.
--
-- Estados (por entidad):
--   NUEVO       no existe → se insertará.
--   IGNORADO    ya existe y coincide → no se toca (regla de cero sobrescritura).
--   ADVERTENCIA se procesa, con observaciones: completa campos NULL, el archivo
--               difiere de lo existente (se conserva lo existente) o la extracción
--               tuvo que estimar una celda.
--   CONFLICTO   no se carga: fila inválida, choque de llaves, depende de otra
--               entidad en conflicto, o participación existente con cambios que no
--               son una progresión válida (ver 4.4).
--
-- Revisión en línea (migración 013):
--   • import_pdf_row_overrides: correcciones de filas del PDF (estado, horas, fechas) o
--     exclusiones. Se aplican SOBRE la fila original (import_pdf_rows no se modifica) y
--     pasan por exactamente las mismas validaciones. Una fila excluida no participa en la
--     clasificación y queda como ítem FILA_PDF IGNORADO con su justificación.
--   • import_enrollment_decisions: decisión explícita sobre participaciones que la admiten.
--   • import_project_links (014): vincular un proyecto del lote a uno creado en la app con
--     la misma nombre_clave, o confirmar que es otro proyecto.
--
-- Comparación de nombres (014): las adopciones y los avisos usan fn_nombre_clave
-- (mayúsculas, tildes, NFD, NBSP y puntuación no importan). Códigos CSS y correlativos se
-- comparan sin ceros a la izquierda (fn_import_numero).
--
-- Reglas heredadas del ETL histórico (src/etl/sql/transform_load.sql):
--   proyecto = (institución por codigo_css, correlativo); el PDF manda y el Excel
--   completa; "01/01/1900" = sin fecha; Activo → sin cierre y sin horas.
-- =============================================================================

DROP TABLE IF EXISTS t_pdf, t_xls, t_rechazos, t_pdf_ok, t_xls_ok,
                     t_inst, t_proj, t_stud, t_enr,
                     t_inst_c, t_proj_c, t_stud_c, t_enr_c;

DELETE FROM import_items WHERE batch_id = fn_import_actual();

-- =============================================================================
-- 1. Filas tipadas
-- =============================================================================
CREATE TEMP TABLE t_pdf ON COMMIT DROP AS
SELECT
    r.id, r.archivo, r.pagina, r.linea,
    fn_import_limpiar(r.carnet)                                           AS carnet,
    fn_import_limpiar(fn_import_corregir_mojibake(r.nombre_completo))     AS nombre_completo,
    fn_import_numero(fn_import_limpiar(r.cod_institucion))                AS cod_institucion,
    fn_import_limpiar(fn_import_corregir_mojibake(r.institucion))         AS institucion,
    fn_import_numero(fn_import_limpiar(r.correlativo))                    AS correlativo,
    fn_import_limpiar(fn_import_corregir_mojibake(r.proyecto_nombre))     AS proyecto_nombre,
    fn_import_carrera_sin_modalidad(r.carrera)                            AS carrera_reporte,
    coalesce(
        (SELECT c.id FROM import_map_carreras m
         JOIN careers c ON c.nombre_normalizado = fn_normalize_text(m.carrera)
         WHERE m.carrera_reporte = fn_import_carrera_sin_modalidad(r.carrera)),
        (SELECT c.id FROM careers c
         WHERE c.nombre_normalizado = fn_normalize_text(fn_import_carrera_sin_modalidad(r.carrera)))
    )                                                                     AS career_id,
    fn_import_fecha(r.fecha_inicio)                                       AS fecha_inicio,
    fn_import_fecha(r.fecha_fin)                                          AS fecha_fin,
    CASE WHEN r.horas_asignadas ~ '^\d{1,6}$' THEN r.horas_asignadas::integer END AS horas,
    fn_import_limpiar(r.estado)                                           AS estado_reporte,
    e.estado,
    e.requiere_fin,
    r.fecha_inicio AS fecha_inicio_raw, r.fecha_fin AS fecha_fin_raw, r.horas_asignadas AS horas_raw,
    r.advertencias,
    r.editada,
    r.original
FROM (
    -- Fila efectiva = original del PDF + corrección vigente (solo los campos editados).
    SELECT r0.id, r0.batch_id, r0.archivo, r0.pagina, r0.linea, r0.carnet, r0.nombre_completo,
           r0.cod_institucion, r0.institucion, r0.correlativo, r0.proyecto_nombre, r0.carrera,
           coalesce(o.fecha_inicio, r0.fecha_inicio)       AS fecha_inicio,
           coalesce(o.fecha_fin, r0.fecha_fin)             AS fecha_fin,
           coalesce(o.horas_asignadas, r0.horas_asignadas) AS horas_asignadas,
           coalesce(o.estado, r0.estado)                   AS estado,
           CASE WHEN o.pdf_row_id IS NULL THEN r0.advertencias
                ELSE r0.advertencias || ARRAY['fila_editada_en_revision'] END AS advertencias,
           o.pdf_row_id IS NOT NULL                        AS editada,
           jsonb_build_object('estado', r0.estado, 'horas', r0.horas_asignadas,
                              'fechaInicio', r0.fecha_inicio, 'fechaFin', r0.fecha_fin) AS original
    FROM import_pdf_rows r0
    LEFT JOIN import_pdf_row_overrides o ON o.batch_id = r0.batch_id AND o.pdf_row_id = r0.id
    WHERE r0.batch_id = fn_import_actual()
      AND NOT coalesce(o.excluida, false)                 -- excluida en la revisión
) r
LEFT JOIN import_map_estados e ON e.estado_reporte = fn_import_limpiar(r.estado);

CREATE TEMP TABLE t_xls ON COMMIT DROP AS
SELECT
    r.id, r.archivo, r.hoja, r.fila_excel,
    fn_import_limpiar(r.area)                                             AS area,
    fn_import_numero(fn_import_limpiar(r.cod_institucion))                AS cod_institucion,
    fn_import_limpiar(fn_import_corregir_mojibake(r.institucion))         AS institucion,
    fn_import_numero(fn_import_limpiar(r.correlativo))                    AS correlativo,
    fn_import_limpiar(fn_import_corregir_mojibake(r.proyecto_nombre))     AS proyecto_nombre,
    -- Alumnos que el Excel reporta para el proyecto (inscripciones, sin deduplicar).
    CASE WHEN fn_import_limpiar(r.alumnos) ~ '^\d{1,6}$' THEN fn_import_limpiar(r.alumnos)::integer END AS alumnos,
    fn_import_fecha(r.fecha_inicio)                                       AS fecha_inicio,
    fn_import_ajustar_fin(fn_import_fecha(r.fecha_inicio), fn_import_fecha(r.fecha_fin)) AS fecha_fin,
    fn_import_fecha(r.fecha_fin) IS DISTINCT FROM
        fn_import_ajustar_fin(fn_import_fecha(r.fecha_inicio), fn_import_fecha(r.fecha_fin)) AS fin_ajustado,
    r.fecha_inicio AS fecha_inicio_raw, r.fecha_fin AS fecha_fin_raw,
    r.advertencias
FROM import_xls_rows r
WHERE r.batch_id = fn_import_actual();

-- =============================================================================
-- 2. Validación por fila → rechazos (la fila no se carga)
-- =============================================================================
CREATE TEMP TABLE t_rechazos (
    origen   text   NOT NULL,
    row_id   bigint NOT NULL,
    motivo   text   NOT NULL,
    detalle  text,
    PRIMARY KEY (origen, row_id, motivo)
) ON COMMIT DROP;

-- 2.1 PDF, por fila
INSERT INTO t_rechazos
SELECT 'PDF', v.id, m.motivo, m.detalle
FROM t_pdf v
CROSS JOIN LATERAL (VALUES
    ('carnet_invalido',          v.carnet IS NULL OR v.carnet !~ '^\d{8}$',                   v.carnet),
    ('nombre_vacio',             v.nombre_completo IS NULL,                                    NULL),
    ('cod_institucion_invalido', v.cod_institucion IS NULL OR v.cod_institucion !~ '^\d+$',   v.cod_institucion),
    ('institucion_vacia',        v.institucion IS NULL,                                        NULL),
    ('correlativo_invalido',     v.correlativo IS NULL OR v.correlativo !~ '^\d+$',           v.correlativo),
    ('proyecto_vacio',           v.proyecto_nombre IS NULL,                                    NULL),
    ('mojibake_sin_mapeo',       position('Ã' IN concat(v.nombre_completo, v.institucion, v.proyecto_nombre)) > 0,
                                 concat_ws(' | ', v.nombre_completo, v.institucion, v.proyecto_nombre)),
    ('carrera_no_encontrada',    v.career_id IS NULL,                                          v.carrera_reporte),
    ('estado_desconocido',       v.estado IS NULL,                                             v.estado_reporte),
    ('fecha_inicio_invalida',    v.fecha_inicio IS NULL,                                       v.fecha_inicio_raw),
    ('fecha_fin_invalida',       NOT coalesce(fn_import_fecha_valida(v.fecha_fin_raw), false), v.fecha_fin_raw),
    ('horas_invalidas',          v.horas IS NULL,                                              v.horas_raw),
    ('fin_antes_de_inicio',      v.fecha_fin < v.fecha_inicio,                                 v.fecha_inicio_raw || ' > ' || v.fecha_fin_raw),
    ('estado_requiere_fin',      coalesce(v.requiere_fin, false) AND v.fecha_fin IS NULL,      v.estado_reporte),
    ('activo_con_fin',           v.estado = 'EN_CURSO' AND v.fecha_fin IS NOT NULL,            v.fecha_fin_raw),
    -- Horas sin fecha de fin no tienen fecha_horas para el libro mayor.
    ('activo_con_horas',         v.estado = 'EN_CURSO' AND v.horas > 0,                        v.horas_raw)
) AS m(motivo, falla, detalle)
WHERE m.falla;

-- 2.2 PDF, entre filas del lote (se rechazan TODAS las involucradas)
INSERT INTO t_rechazos
SELECT 'PDF', v.id, 'carnet_con_varios_nombres', string_agg(DISTINCT v2.nombre_completo, ' / ')
FROM t_pdf v
JOIN t_pdf v2 ON v2.carnet = v.carnet AND v2.nombre_completo IS DISTINCT FROM v.nombre_completo
GROUP BY v.id
ON CONFLICT DO NOTHING;

INSERT INTO t_rechazos
SELECT 'PDF', v.id, 'carnet_con_varias_carreras', string_agg(DISTINCT v2.carrera_reporte, ' / ')
FROM t_pdf v
JOIN t_pdf v2 ON v2.carnet = v.carnet AND v2.career_id IS DISTINCT FROM v.career_id
GROUP BY v.id
ON CONFLICT DO NOTHING;

INSERT INTO t_rechazos
SELECT 'PDF', v.id, 'participacion_duplicada_en_lote', v.carnet || ' en ' || v.cod_institucion || '/' || v.correlativo
FROM t_pdf v
WHERE (v.carnet, v.cod_institucion, v.correlativo) IN (
    SELECT carnet, cod_institucion, correlativo FROM t_pdf GROUP BY 1, 2, 3 HAVING count(*) > 1)
ON CONFLICT DO NOTHING;

-- 2.3 Excel
INSERT INTO t_rechazos
SELECT 'XLS', v.id, m.motivo, m.detalle
FROM t_xls v
CROSS JOIN LATERAL (VALUES
    ('cod_institucion_invalido', v.cod_institucion IS NULL OR v.cod_institucion !~ '^\d+$', v.cod_institucion),
    ('institucion_vacia',        v.institucion IS NULL,                                     NULL),
    ('correlativo_invalido',     v.correlativo IS NULL OR v.correlativo !~ '^\d+$',         v.correlativo),
    ('proyecto_vacio',           v.proyecto_nombre IS NULL,                                 NULL),
    ('mojibake_sin_mapeo',       position('Ã' IN concat(v.institucion, v.proyecto_nombre)) > 0,
                                 concat_ws(' | ', v.institucion, v.proyecto_nombre)),
    ('fecha_inicio_invalida',    NOT coalesce(fn_import_fecha_valida(v.fecha_inicio_raw), false), v.fecha_inicio_raw),
    ('fecha_fin_invalida',       NOT coalesce(fn_import_fecha_valida(v.fecha_fin_raw), false),    v.fecha_fin_raw)
) AS m(motivo, falla, detalle)
WHERE m.falla;

INSERT INTO t_rechazos
SELECT 'XLS', v.id, 'proyecto_duplicado_en_lote', v.cod_institucion || '/' || v.correlativo
FROM t_xls v
WHERE (v.cod_institucion, v.correlativo) IN (
    SELECT cod_institucion, correlativo FROM t_xls GROUP BY 1, 2 HAVING count(*) > 1)
ON CONFLICT DO NOTHING;

-- Filas inválidas → ítems CONFLICTO a nivel de fila.
INSERT INTO import_items (batch_id, entidad, clave, estado, accion, motivos, datos, pdf_row_ids)
SELECT fn_import_actual(), 'FILA_PDF',
       format('%s p%s l%s', v.archivo, v.pagina, v.linea),
       'CONFLICTO', 'NINGUNA',
       array_agg(x.motivo ORDER BY x.motivo),
       jsonb_build_object(
           'archivo', v.archivo, 'pagina', v.pagina, 'linea', v.linea,
           'carnet', v.carnet, 'nombre', v.nombre_completo,
           'codigoInstitucion', v.cod_institucion, 'institucion', v.institucion,
           'correlativo', v.correlativo, 'proyecto', v.proyecto_nombre,
           'carrera', v.carrera_reporte, 'estado', v.estado_reporte,
           'fechaInicio', v.fecha_inicio_raw, 'fechaFin', v.fecha_fin_raw, 'horas', v.horas_raw,
           'detalles', jsonb_object_agg(x.motivo, x.detalle),
           -- Revisión en línea: id de la fila para editarla y lo extraído del PDF.
           'pdfRowId', v.id, 'editada', v.editada, 'original', v.original),
       ARRAY[v.id]
FROM t_pdf v
JOIN t_rechazos x ON x.origen = 'PDF' AND x.row_id = v.id
GROUP BY v.id, v.archivo, v.pagina, v.linea, v.carnet, v.nombre_completo, v.cod_institucion, v.institucion,
         v.correlativo, v.proyecto_nombre, v.carrera_reporte, v.estado_reporte,
         v.fecha_inicio_raw, v.fecha_fin_raw, v.horas_raw, v.editada, v.original;

-- Filas excluidas en la revisión → FILA_PDF IGNORADO (visibles para restaurarlas).
INSERT INTO import_items (batch_id, entidad, clave, estado, accion, motivos, datos, pdf_row_ids)
SELECT fn_import_actual(), 'FILA_PDF',
       format('%s p%s l%s', r.archivo, r.pagina, r.linea),
       'IGNORADO', 'NINGUNA', ARRAY['fila_excluida_en_revision'],
       jsonb_build_object(
           'archivo', r.archivo, 'pagina', r.pagina, 'linea', r.linea,
           'carnet', fn_import_limpiar(r.carnet), 'nombre', fn_import_limpiar(r.nombre_completo),
           'codigoInstitucion', fn_import_limpiar(r.cod_institucion), 'institucion', fn_import_limpiar(r.institucion),
           'correlativo', fn_import_limpiar(r.correlativo), 'proyecto', fn_import_limpiar(r.proyecto_nombre),
           'carrera', fn_import_limpiar(r.carrera), 'estado', coalesce(o.estado, r.estado),
           'fechaInicio', coalesce(o.fecha_inicio, r.fecha_inicio), 'fechaFin', coalesce(o.fecha_fin, r.fecha_fin),
           'horas', coalesce(o.horas_asignadas, r.horas_asignadas),
           'pdfRowId', r.id, 'excluida', true, 'justificacion', o.justificacion,
           'excluidaPor', o.actualizado_por, 'excluidaEn', o.actualizado_en,
           'original', jsonb_build_object('estado', r.estado, 'horas', r.horas_asignadas,
                                          'fechaInicio', r.fecha_inicio, 'fechaFin', r.fecha_fin)),
       ARRAY[r.id]
FROM import_pdf_rows r
JOIN import_pdf_row_overrides o ON o.batch_id = r.batch_id AND o.pdf_row_id = r.id
WHERE r.batch_id = fn_import_actual() AND o.excluida;

INSERT INTO import_items (batch_id, entidad, clave, estado, accion, motivos, datos, xls_row_ids)
SELECT fn_import_actual(), 'FILA_XLS',
       format('%s %s!f%s', v.archivo, v.hoja, v.fila_excel),
       'CONFLICTO', 'NINGUNA',
       array_agg(x.motivo ORDER BY x.motivo),
       jsonb_build_object(
           'archivo', v.archivo, 'hoja', v.hoja, 'fila', v.fila_excel,
           'codigoInstitucion', v.cod_institucion, 'institucion', v.institucion,
           'correlativo', v.correlativo, 'proyecto', v.proyecto_nombre,
           'fechaInicio', v.fecha_inicio_raw, 'fechaFin', v.fecha_fin_raw,
           'detalles', jsonb_object_agg(x.motivo, x.detalle)),
       ARRAY[v.id]
FROM t_xls v
JOIN t_rechazos x ON x.origen = 'XLS' AND x.row_id = v.id
GROUP BY v.id, v.archivo, v.hoja, v.fila_excel, v.cod_institucion, v.institucion,
         v.correlativo, v.proyecto_nombre, v.fecha_inicio_raw, v.fecha_fin_raw;

CREATE TEMP TABLE t_pdf_ok ON COMMIT DROP AS
SELECT v.* FROM t_pdf v
WHERE NOT EXISTS (SELECT 1 FROM t_rechazos x WHERE x.origen = 'PDF' AND x.row_id = v.id);

CREATE TEMP TABLE t_xls_ok ON COMMIT DROP AS
SELECT v.* FROM t_xls v
WHERE NOT EXISTS (SELECT 1 FROM t_rechazos x WHERE x.origen = 'XLS' AND x.row_id = v.id);

-- =============================================================================
-- 3. Entidades consolidadas del lote (PDF manda; el Excel completa)
-- =============================================================================
CREATE TEMP TABLE t_inst ON COMMIT DROP AS
SELECT cod_institucion AS codigo_css,
       coalesce(min(institucion) FILTER (WHERE fuente = 'PDF'), min(institucion)) AS nombre,
       array_agg(DISTINCT id) FILTER (WHERE fuente = 'PDF') AS pdf_ids,
       array_agg(DISTINCT id) FILTER (WHERE fuente = 'XLS') AS xls_ids
FROM (
    SELECT cod_institucion, institucion, id, 'PDF' AS fuente FROM t_pdf_ok
    UNION ALL
    SELECT cod_institucion, institucion, id, 'XLS' FROM t_xls_ok
) s
GROUP BY cod_institucion;

CREATE TEMP TABLE t_proj ON COMMIT DROP AS
WITH pdf AS (
    SELECT cod_institucion, correlativo,
           min(proyecto_nombre) AS titulo,
           min(fecha_inicio)    AS inicio_estudiantes,
           CASE WHEN bool_or(estado = 'EN_CURSO') THEN NULL ELSE max(fecha_fin) END AS cierre_estudiantes,
           array_agg(id) AS pdf_ids
    FROM t_pdf_ok
    GROUP BY 1, 2
)
SELECT
    coalesce(p.cod_institucion, x.cod_institucion) AS codigo_css,
    coalesce(p.correlativo, x.correlativo)         AS correlativo,
    coalesce(p.titulo, x.proyecto_nombre)          AS titulo,
    -- Las fechas de PROYECTO solo vienen en el Excel; sin él se derivan de los estudiantes.
    CASE WHEN x.id IS NOT NULL THEN x.fecha_inicio ELSE p.inicio_estudiantes END AS fecha_inicio,
    CASE WHEN x.id IS NOT NULL THEN x.fecha_fin    ELSE p.cierre_estudiantes END AS fecha_cierre,
    x.area,
    x.alumnos,
    -- Solo las fechas del Excel son fechas oficiales del proyecto. Las derivadas de los
    -- estudiantes de UN PDF son una vista parcial (otras carreras pueden seguir activas):
    -- sirven para crear un proyecto nuevo, nunca para completar o comparar uno existente.
    x.id IS NOT NULL                AS fechas_oficiales,
    coalesce(x.fin_ajustado, false) AS fin_ajustado,
    x.fecha_fin_raw                 AS fin_original,
    coalesce(p.pdf_ids, '{}')       AS pdf_ids,
    CASE WHEN x.id IS NULL THEN '{}'::bigint[] ELSE ARRAY[x.id] END AS xls_ids
FROM pdf p
FULL JOIN t_xls_ok x ON x.cod_institucion = p.cod_institucion AND x.correlativo = p.correlativo;

CREATE TEMP TABLE t_stud ON COMMIT DROP AS
SELECT DISTINCT ON (carnet) carnet, nombre_completo, career_id, carrera_reporte,
       array_agg(id) OVER (PARTITION BY carnet) AS pdf_ids
FROM t_pdf_ok
ORDER BY carnet, id;

CREATE TEMP TABLE t_enr ON COMMIT DROP AS
SELECT id, archivo, pagina, linea, carnet, nombre_completo, cod_institucion, correlativo, proyecto_nombre,
       career_id, estado, estado_reporte, horas, fecha_inicio, fecha_fin, advertencias, editada,
       fn_import_inicio_dia(fecha_inicio) AS asignada_en,
       -- Activo → sin cierre. FINALIZADA/RETIRADA → cierre = fecha de fin.
       CASE WHEN estado = 'EN_CURSO' THEN NULL ELSE fn_import_inicio_dia(fecha_fin) END AS cerrada_en
FROM t_pdf_ok;

-- =============================================================================
-- 4. Clasificación contra el maestro
-- =============================================================================

-- 4.1 Instituciones. Llave: codigo_css (sin ceros a la izquierda). Si la app ya creó la
-- institución SIN código, se adopta completando codigo_css (regla 2):
--   • mismo nombre_normalizado → se adopta (como siempre);
--   • misma nombre_clave (difiere solo en tildes, puntuación, espacios…) y es la única
--     candidata y única en el lote → se adopta con aviso;
--   • varias candidatas de la app, o varias instituciones del lote para una → CONFLICTO;
--   • parecida a otra institución con OTRO código del CSS → se crea, con aviso.
CREATE TEMP TABLE t_inst_c ON COMMIT DROP AS
WITH base AS (
    SELECT t.*,
           bc.id AS code_id, bc.nombre AS code_nombre,
           bn.id AS name_id, bn.codigo_css AS name_codigo, bn.nombre AS name_nombre,
           sim.app_n, sim.app_id, sim.app_nombre, sim.otros_codigos,
           count(*) OVER (PARTITION BY fn_normalize_text(t.nombre)) AS mismo_nombre,
           count(*) OVER (PARTITION BY fn_nombre_clave(t.nombre))   AS mismo_clave
    FROM t_inst t
    LEFT JOIN institutions bc ON fn_import_numero(bc.codigo_css) = t.codigo_css
    LEFT JOIN institutions bn ON bn.nombre_normalizado = fn_normalize_text(t.nombre)
    LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE i.codigo_css IS NULL)                               AS app_n,
               (array_agg(i.id ORDER BY i.id) FILTER (WHERE i.codigo_css IS NULL))[1]     AS app_id,
               (array_agg(i.nombre ORDER BY i.id) FILTER (WHERE i.codigo_css IS NULL))[1] AS app_nombre,
               string_agg(i.codigo_css, ', ' ORDER BY i.codigo_css) FILTER (WHERE i.codigo_css IS NOT NULL) AS otros_codigos
        FROM institutions i
        WHERE i.nombre_clave = fn_nombre_clave(t.nombre)
          AND i.nombre_normalizado <> fn_normalize_text(t.nombre)       -- lo idéntico ya lo cubre bn
          AND (i.codigo_css IS NULL OR fn_import_numero(i.codigo_css) <> t.codigo_css)
    ) sim ON true
),
caso AS (
    SELECT b.*,
           CASE
               WHEN b.code_id IS NOT NULL THEN 'CODIGO'
               WHEN b.mismo_nombre > 1 THEN 'REPETIDA_EN_LOTE'
               WHEN b.name_id IS NOT NULL AND b.name_codigo IS NULL THEN 'ADOPTA_IGUAL'
               WHEN b.name_id IS NOT NULL THEN 'NOMBRE_EN_USO'
               WHEN coalesce(b.app_n, 0) > 1 THEN 'VARIAS_APP'
               WHEN b.app_n = 1 AND b.mismo_clave = 1 THEN 'ADOPTA_SIMILAR'
               WHEN b.app_n = 1 THEN 'APP_SIMILAR_REPETIDA'
               ELSE 'NUEVA'
           END AS caso
    FROM base b
)
SELECT b.codigo_css, b.nombre, b.pdf_ids, b.xls_ids, k.*
FROM caso b
CROSS JOIN LATERAL (
    SELECT
        CASE b.caso
            WHEN 'CODIGO' THEN b.code_id
            WHEN 'ADOPTA_IGUAL' THEN b.name_id
            WHEN 'ADOPTA_SIMILAR' THEN b.app_id
        END AS institution_id,
        CASE b.caso
            WHEN 'CODIGO' THEN
                CASE WHEN fn_nombre_clave(b.code_nombre) = fn_nombre_clave(b.nombre) THEN 'IGNORADO' ELSE 'ADVERTENCIA' END
            WHEN 'ADOPTA_IGUAL' THEN 'ADVERTENCIA'
            WHEN 'ADOPTA_SIMILAR' THEN 'ADVERTENCIA'
            WHEN 'NUEVA' THEN CASE WHEN b.otros_codigos IS NOT NULL THEN 'ADVERTENCIA' ELSE 'NUEVO' END
            ELSE 'CONFLICTO'
        END AS estado,
        CASE b.caso
            WHEN 'ADOPTA_IGUAL' THEN 'COMPLETAR'
            WHEN 'ADOPTA_SIMILAR' THEN 'COMPLETAR'
            WHEN 'NUEVA' THEN 'INSERTAR'
            ELSE 'NINGUNA'
        END AS accion,
        array_remove(ARRAY[
            -- Solo cuenta como "difiere" si cambia algo más que el formato (clave fuerte).
            CASE WHEN b.caso = 'CODIGO' AND fn_nombre_clave(b.code_nombre) <> fn_nombre_clave(b.nombre)
                 THEN 'nombre_difiere_se_conserva_existente' END,
            CASE WHEN b.caso = 'REPETIDA_EN_LOTE' THEN 'nombre_repetido_con_otro_codigo_en_lote' END,
            CASE WHEN b.caso IN ('ADOPTA_IGUAL', 'ADOPTA_SIMILAR') THEN 'completa_codigo_css' END,
            CASE WHEN b.caso = 'ADOPTA_SIMILAR' THEN 'adopta_institucion_nombre_similar' END,
            CASE WHEN b.caso = 'NOMBRE_EN_USO' THEN 'nombre_en_uso_por_otro_codigo' END,
            CASE WHEN b.caso = 'VARIAS_APP' THEN 'varias_instituciones_app_similares' END,
            CASE WHEN b.caso = 'APP_SIMILAR_REPETIDA' THEN 'institucion_app_similar_repetida_en_lote' END,
            CASE WHEN b.caso = 'NUEVA' AND b.otros_codigos IS NOT NULL
                 THEN 'institucion_similar_con_otro_codigo:' || b.otros_codigos END
        ], NULL) AS motivos,
        CASE
            WHEN b.caso = 'CODIGO' THEN jsonb_build_object('id', b.code_id, 'nombre', b.code_nombre, 'codigoCss', b.codigo_css)
            WHEN b.name_id IS NOT NULL THEN jsonb_build_object('id', b.name_id, 'nombre', b.name_nombre, 'codigoCss', b.name_codigo)
            WHEN b.app_n = 1 THEN jsonb_build_object('id', b.app_id, 'nombre', b.app_nombre, 'codigoCss', NULL)
        END AS existente,
        CASE WHEN b.caso IN ('ADOPTA_IGUAL', 'ADOPTA_SIMILAR') THEN jsonb_build_object('codigo_css', b.codigo_css) END AS completar
) k;

-- 4.2 Proyectos. Llave: (institución, correlativo sin ceros a la izquierda). Si no existe
-- por correlativo, se buscan proyectos creados en la app (sin correlativo) de la misma
-- institución con la misma nombre_clave (mayúsculas, tildes, NFD, NBSP y puntuación no importan):
--   • una sola candidata y el título es único en el lote → se adopta (completa correlativo_css);
--   • si no (varios correlativos con el mismo título, o varias candidatas) NO se crean copias
--     en silencio: CONFLICTO hasta que la revisión elija VINCULAR a una candidata o
--     CREAR_NUEVO (import_project_links);
--   • dos correlativos no pueden adoptar el mismo proyecto de la app (CONFLICTO);
--   • un proyecto NUEVO parecido a uno ya importado con otro correlativo se crea con aviso.
-- Correlativos alternos (migración 016, project_correlativo_alias). Un mismo correlativo no
-- significa lo mismo en todas las instituciones ni reportes: la equivalencia nunca se deduce.
--   • (institución, correlativo) registrado como alias y el título del lote es el mismo
--     (nombre_clave) que el del proyecto destino → se usa ese proyecto (ALIAS);
--   • alias registrado pero el título difiere → CONFLICTO (no se mezcla ni se crea);
--   • correlativo nuevo, solo en los PDF (sin fila del Excel), cuyo título coincide con
--     un proyecto del reporte CSS de la misma institución → CONFLICTO hasta que la revisión
--     decida ALIAS (se registra el alias al confirmar) o CREAR_NUEVO (import_project_links).
CREATE TEMP TABLE t_proj_c ON COMMIT DROP AS
WITH lote AS (
    SELECT *, count(*) OVER (PARTITION BY codigo_css, fn_nombre_clave(titulo)) AS mismo_titulo FROM t_proj
),
cand AS (
    SELECT t.*,
           ic.institution_id, ic.estado AS inst_estado,
           p.id AS p_id,
           coalesce(app.n, 0) AS app_n, app.ids AS app_ids, app.lista AS app_lista,
           imp.lista AS similares_importados, imp.correlativos AS similares_correlativos,
           l.decision AS link_decision, l.project_id AS link_project_id,
           al.id AS alias_id, al.project_id AS alias_project_id, alp.nombre_clave AS alias_clave,
           coalesce(rep.n, 0) AS rep_n, rep.ids AS rep_ids, rep.lista AS rep_lista
    FROM lote t
    JOIN t_inst_c ic ON ic.codigo_css = t.codigo_css
    LEFT JOIN projects p ON p.institution_id = ic.institution_id AND fn_import_numero(p.correlativo_css) = t.correlativo
    LEFT JOIN LATERAL (
        SELECT count(*) AS n,
               array_agg(a.id ORDER BY a.created_at, a.id) AS ids,
               jsonb_agg(jsonb_build_object('id', a.id, 'titulo', a.titulo, 'estado', a.estado)
                         ORDER BY a.created_at, a.id) AS lista
        FROM projects a
        WHERE p.id IS NULL AND ic.institution_id IS NOT NULL
          AND a.institution_id = ic.institution_id AND a.correlativo_css IS NULL
          AND NOT (a.atributos ? 'sistema') AND a.nombre_clave = fn_nombre_clave(t.titulo)
    ) app ON true
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('id', o.id, 'titulo', o.titulo, 'correlativo', o.correlativo_css)
                         ORDER BY o.correlativo_css) AS lista,
               string_agg(o.correlativo_css, ', ' ORDER BY o.correlativo_css) AS correlativos
        FROM projects o
        WHERE p.id IS NULL AND ic.institution_id IS NOT NULL
          AND o.institution_id = ic.institution_id AND o.correlativo_css IS NOT NULL
          AND o.nombre_clave = fn_nombre_clave(t.titulo)
    ) imp ON true
    LEFT JOIN project_correlativo_alias al
           ON p.id IS NULL AND al.institution_id = ic.institution_id AND al.correlativo_css = t.correlativo
    LEFT JOIN projects alp ON alp.id = al.project_id
    -- Proyectos del reporte CSS con el mismo título en la institución (solo para filas que
    -- vienen únicamente de los PDF: una fila del Excel ES el proyecto oficial).
    LEFT JOIN LATERAL (
        SELECT count(*) AS n,
               array_agg(o.id ORDER BY o.correlativo_css) AS ids,
               jsonb_agg(jsonb_build_object('id', o.id, 'titulo', o.titulo, 'correlativo', o.correlativo_css,
                                            'estado', o.estado) ORDER BY o.correlativo_css) AS lista
        FROM projects o
        WHERE p.id IS NULL AND al.id IS NULL AND ic.institution_id IS NOT NULL
          AND cardinality(t.xls_ids) = 0
          AND o.institution_id = ic.institution_id AND o.en_reporte_css AND o.correlativo_css IS NOT NULL
          AND NOT (o.atributos ? 'sistema') AND o.nombre_clave = fn_nombre_clave(t.titulo)
    ) rep ON true
    LEFT JOIN import_project_links l
           ON l.batch_id = fn_import_actual() AND l.clave = t.codigo_css || '/' || t.correlativo
),
dec AS (
    SELECT c.*,
           CASE
               WHEN c.p_id IS NOT NULL THEN 'EXISTE'
               WHEN c.alias_id IS NOT NULL AND c.alias_clave = fn_nombre_clave(c.titulo) THEN 'ALIAS'
               WHEN c.alias_id IS NOT NULL THEN 'ALIAS_TITULO_DIFIERE'
               WHEN c.rep_n > 0 AND c.link_decision = 'ALIAS' AND c.link_project_id = ANY (c.rep_ids) THEN 'ALIAS_NUEVO'
               WHEN c.app_n = 0 AND c.rep_n = 0 THEN 'NUEVO'
               WHEN c.link_decision = 'VINCULAR' AND c.link_project_id = ANY (c.app_ids) THEN 'VINCULA'
               WHEN c.link_decision = 'CREAR_NUEVO' THEN 'NUEVO_CONFIRMADO'
               WHEN c.app_n = 0 THEN 'REQUIERE_ALIAS'
               WHEN c.app_n = 1 AND c.mismo_titulo = 1 THEN 'ADOPTA'
               ELSE 'REQUIERE_VINCULO'
           END AS resolucion
    FROM cand c
),
dec2 AS (
    SELECT d.*,
           CASE d.resolucion WHEN 'ADOPTA' THEN d.app_ids[1] WHEN 'VINCULA' THEN d.link_project_id END AS a_id,
           -- Correlativo alterno: varios correlativos pueden ser alias del mismo proyecto.
           CASE d.resolucion WHEN 'ALIAS' THEN d.alias_project_id WHEN 'ALIAS_NUEVO' THEN d.link_project_id END AS alias_destino
    FROM dec d
),
dec3 AS (
    SELECT d.*,
           CASE WHEN d.a_id IS NULL THEN 0 ELSE count(*) OVER (PARTITION BY d.a_id) END AS adopciones
    FROM dec2 d
),
base AS (
    SELECT d.*,
           CASE WHEN d.adopciones > 1 THEN NULL ELSE coalesce(d.p_id, d.alias_destino, d.a_id) END AS project_id,
           d.a_id IS NOT NULL AND d.adopciones = 1  AS adoptado,
           e.titulo        AS e_titulo,
           e.fecha_inicio  AS e_inicio,
           e.fecha_cierre  AS e_cierre,
           e.atributos     AS e_atributos,
           e.estado        AS e_estado,
           e.correlativo_css AS e_corr
    FROM dec3 d
    LEFT JOIN projects e ON e.id = CASE WHEN d.adopciones > 1 THEN NULL ELSE coalesce(d.p_id, d.alias_destino, d.a_id) END
),
fill AS (
    SELECT b.*,
           b.project_id IS NOT NULL AND b.fechas_oficiales AND b.e_inicio IS NULL AND b.fecha_inicio IS NOT NULL
               AND (b.e_cierre IS NULL OR b.fecha_inicio <= b.e_cierre) AS llenar_inicio,
           b.project_id IS NOT NULL AND b.e_atributos IS NOT NULL AND b.area IS NOT NULL
               AND b.e_atributos -> 'area_css' IS NULL AS llenar_area,
           -- alumnos_css es una foto del último Excel (crece durante el año): se actualiza
           -- si cambió, a diferencia de los demás campos, que solo completan vacíos.
           b.project_id IS NOT NULL AND b.e_atributos IS NOT NULL AND b.alumnos IS NOT NULL
               AND (b.e_atributos ->> 'alumnos_css') IS DISTINCT FROM b.alumnos::text AS llenar_alumnos
    FROM base b
),
fill2 AS (
    SELECT f.*,
           f.project_id IS NOT NULL AND f.fechas_oficiales AND f.e_cierre IS NULL AND f.fecha_cierre IS NOT NULL
               AND coalesce(f.e_inicio, CASE WHEN f.llenar_inicio THEN f.fecha_inicio END, f.fecha_cierre) <= f.fecha_cierre
               AS llenar_cierre
    FROM fill f
)
SELECT f.codigo_css, f.correlativo, f.titulo, f.fecha_inicio, f.fecha_cierre, f.area, f.alumnos,
       f.pdf_ids, f.xls_ids, f.institution_id, f.project_id,
       f.resolucion, f.app_lista, f.similares_importados, f.link_decision, f.link_project_id,
       f.rep_lista, f.e_corr, k.*
FROM fill2 f
CROSS JOIN LATERAL (
    SELECT
        nullif(jsonb_strip_nulls(jsonb_build_object(
            'correlativo_css', CASE WHEN f.adoptado THEN f.correlativo END,
            'fecha_inicio',    CASE WHEN f.llenar_inicio THEN f.fecha_inicio END,
            'fecha_cierre',    CASE WHEN f.llenar_cierre THEN f.fecha_cierre END,
            'area_css',        CASE WHEN f.llenar_area THEN f.area END,
            'alumnos_css',     CASE WHEN f.llenar_alumnos THEN f.alumnos END
        )), '{}'::jsonb) AS completar,
        array_remove(ARRAY[
            CASE WHEN f.inst_estado = 'CONFLICTO' THEN 'institucion_en_conflicto' END,
            -- Solo "difiere" si cambia algo más que el formato (clave fuerte).
            CASE WHEN f.project_id IS NOT NULL AND fn_nombre_clave(f.e_titulo) <> fn_nombre_clave(f.titulo)
                 THEN 'titulo_difiere_se_conserva_existente' END,
            CASE WHEN f.adoptado AND fn_normalize_text(f.e_titulo) <> fn_normalize_text(f.titulo)
                 THEN 'titulo_similar_no_identico' END,
            CASE WHEN f.resolucion = 'REQUIERE_VINCULO' THEN 'requiere_vincular_proyecto_app' END,
            CASE WHEN f.resolucion = 'REQUIERE_ALIAS' THEN 'requiere_decidir_correlativo_alterno' END,
            CASE WHEN f.resolucion = 'ALIAS_TITULO_DIFIERE' THEN 'correlativo_alterno_titulo_difiere' END,
            CASE WHEN f.resolucion = 'ALIAS_NUEVO' THEN 'se_registra_correlativo_alterno_de:' || f.e_corr END,
            CASE WHEN f.adopciones > 1 THEN 'vinculo_repetido' END,
            CASE WHEN f.resolucion = 'VINCULA' AND f.adoptado THEN 'vinculado_en_revision' END,
            CASE WHEN f.resolucion = 'NUEVO_CONFIRMADO' THEN 'se_crea_aunque_existe_en_app' END,
            CASE WHEN f.project_id IS NULL AND f.similares_correlativos IS NOT NULL
                 THEN 'similar_a_proyecto_importado:' || f.similares_correlativos END,
            CASE WHEN f.project_id IS NOT NULL AND f.fechas_oficiales AND f.e_inicio IS NOT NULL AND f.fecha_inicio IS NOT NULL
                      AND f.e_inicio <> f.fecha_inicio THEN 'fecha_inicio_difiere_se_conserva_existente' END,
            CASE WHEN f.project_id IS NOT NULL AND f.fechas_oficiales AND f.e_cierre IS NOT NULL AND f.fecha_cierre IS NOT NULL
                      AND f.e_cierre <> f.fecha_cierre THEN 'fecha_cierre_difiere_se_conserva_existente' END,
            CASE WHEN f.project_id IS NOT NULL AND f.fechas_oficiales AND f.e_cierre IS NULL AND f.fecha_cierre IS NOT NULL
                      AND NOT f.llenar_cierre
                 THEN 'fecha_cierre_incompatible_no_se_completa' END,
            CASE WHEN f.adoptado AND f.resolucion = 'ADOPTA' THEN 'adopta_proyecto_sin_correlativo' END,
            -- El ajuste solo importa si la fecha se va a escribir (proyecto nuevo o cierre en NULL).
            CASE WHEN f.fin_ajustado AND (f.project_id IS NULL OR f.llenar_cierre)
                 THEN 'fecha_fin_ajustada:' || f.fin_original END
        ], NULL) AS motivos,
        CASE WHEN f.project_id IS NOT NULL THEN jsonb_build_object(
            'id', f.project_id, 'titulo', f.e_titulo, 'estado', f.e_estado, 'correlativo', f.e_corr,
            'fechaInicio', f.e_inicio, 'fechaCierre', f.e_cierre, 'areaCss', f.e_atributos ->> 'area_css',
            'alumnosCss', (f.e_atributos ->> 'alumnos_css')::integer)
        END AS existente
) k;

ALTER TABLE t_proj_c ADD COLUMN estado text, ADD COLUMN accion text;
UPDATE t_proj_c SET
    estado = CASE
        WHEN motivos && ARRAY['institucion_en_conflicto', 'requiere_vincular_proyecto_app', 'vinculo_repetido',
                              'requiere_decidir_correlativo_alterno', 'correlativo_alterno_titulo_difiere'] THEN 'CONFLICTO'
        WHEN project_id IS NULL THEN CASE WHEN cardinality(motivos) > 0 THEN 'ADVERTENCIA' ELSE 'NUEVO' END
        WHEN completar IS NOT NULL OR cardinality(motivos) > 0 THEN 'ADVERTENCIA'
        ELSE 'IGNORADO'
    END,
    accion = CASE
        WHEN motivos && ARRAY['institucion_en_conflicto', 'requiere_vincular_proyecto_app', 'vinculo_repetido',
                              'requiere_decidir_correlativo_alterno', 'correlativo_alterno_titulo_difiere'] THEN 'NINGUNA'
        WHEN project_id IS NULL THEN 'INSERTAR'
        WHEN completar IS NOT NULL THEN 'COMPLETAR'
        ELSE 'NINGUNA'
    END;
-- Un proyecto en conflicto no completa nada.
UPDATE t_proj_c SET completar = NULL WHERE accion <> 'COMPLETAR';

-- 4.3 Estudiantes. Llave: carnet. Lo existente nunca se modifica.
CREATE TEMP TABLE t_stud_c ON COMMIT DROP AS
SELECT t.*, s.id AS student_id, k.*
FROM t_stud t
LEFT JOIN students s ON s.carnet = t.carnet
LEFT JOIN careers  c ON c.id = s.career_id
CROSS JOIN LATERAL (
    SELECT
        array_remove(ARRAY[
            -- Solo se compara el nombre de históricos: un perfil completado en la app usa "Nombres Apellidos".
            CASE WHEN s.id IS NOT NULL AND s.nombres IS NULL
                      AND fn_normalize_text(s.nombre_completo) <> fn_normalize_text(t.nombre_completo)
                 THEN 'nombre_difiere_se_conserva_existente' END,
            CASE WHEN s.id IS NOT NULL AND s.career_id <> t.career_id THEN 'carrera_difiere_se_conserva_existente' END,
            CASE WHEN s.id IS NULL AND EXISTS (
                     SELECT 1 FROM students o WHERE o.correo_institucional = (t.carnet || '@uca.edu.sv')::citext)
                 THEN 'correo_institucional_en_uso' END
        ], NULL) AS motivos,
        CASE WHEN s.id IS NOT NULL THEN jsonb_build_object(
            'id', s.id, 'nombre', s.nombre_completo, 'carrera', c.nombre) END AS existente
) k;

ALTER TABLE t_stud_c ADD COLUMN estado text, ADD COLUMN accion text;
UPDATE t_stud_c SET
    estado = CASE
        WHEN 'correo_institucional_en_uso' = ANY (motivos) THEN 'CONFLICTO'
        WHEN cardinality(motivos) > 0 THEN 'ADVERTENCIA'
        WHEN student_id IS NULL THEN 'NUEVO'
        ELSE 'IGNORADO'
    END,
    accion = CASE
        WHEN 'correo_institucional_en_uso' = ANY (motivos) THEN 'NINGUNA'
        WHEN student_id IS NULL THEN 'INSERTAR'
        ELSE 'NINGUNA'
    END;

-- 4.4 Participaciones. Llave: (estudiante, proyecto).
--   • Nueva para ese estudiante → entra y suma al historial (sin topes de 300/600 h).
--   • Ya existe e igual (estado, fechas, horas) → IGNORADO.
--   • Ya existe con datos distintos → se clasifica el CAMBIO (`cambio`):
--       FINALIZA      Activo/Asignada → Finalizada, misma fecha de inicio, horas que no
--                     bajan y cierre >= inicio: el estudiante terminó entre dos cortes.
--                     → ADVERTENCIA + ACTUALIZAR (estado, cierre y horas del CSS).
--       AJUSTE_HORAS  Finalizada → Finalizada con MÁS horas, misma fecha de inicio y
--                     cierre que no retrocede: corrección del reporte. Exige decisión
--                     explícita (import_enrollment_decisions): sin ella → CONFLICTO;
--                     ACEPTAR_REPORTE → ADVERTENCIA + ACTUALIZAR; CONSERVAR_BD → IGNORADO.
--                     La decisión vale solo para los valores sobre los que se tomó.
--       BLOQUEO       cualquier otro cambio (retroceso de estado, horas que bajan, fecha
--                     de inicio distinta, Retirada → otro estado, Activo → Retirada…)
--                     → CONFLICTO estricto: no se sobrescribe, se revisa a mano.
--   • Las horas comparadas excluyen las de origen MANUAL (correcciones desde el perfil):
--     ni se comparan ni se modifican nunca.
CREATE TEMP TABLE t_enr_c ON COMMIT DROP AS
WITH base AS (
    SELECT e.*,
           pc.project_id, pc.estado AS proj_estado,
           sc.student_id, sc.estado AS stud_estado,
           pe.id AS enrollment_id, pe.estado AS e_estado, pe.asignada_en AS e_asignada, pe.cerrada_en AS e_cerrada,
           -- Solo horas del CSS: las asignaciones MANUAL (migración 005) no entran en la conciliación.
           (SELECT coalesce(sum(hm.horas), 0)::integer FROM hour_movements hm
             WHERE hm.enrollment_id = pe.id AND hm.origen <> 'MANUAL') AS e_horas,
           d.decision         AS dec_decision,
           d.horas_existentes AS dec_horas_existentes,
           d.horas_reporte    AS dec_horas_reporte
    FROM t_enr e
    JOIN t_proj_c pc ON pc.codigo_css = e.cod_institucion AND pc.correlativo = e.correlativo
    JOIN t_stud_c sc ON sc.carnet = e.carnet
    LEFT JOIN project_enrollments pe ON pe.student_id = sc.student_id AND pe.project_id = pc.project_id
    LEFT JOIN import_enrollment_decisions d
           ON d.batch_id = fn_import_actual() AND d.clave = e.carnet || '@' || e.cod_institucion || '/' || e.correlativo
),
cmp AS (
    SELECT b.*,
           b.enrollment_id IS NOT NULL AND b.e_horas <> b.horas                      AS d_horas,
           b.enrollment_id IS NOT NULL AND b.e_estado <> b.estado                    AS d_estado,
           b.enrollment_id IS NOT NULL AND b.e_asignada <> b.asignada_en             AS d_inicio,
           b.enrollment_id IS NOT NULL AND b.e_cerrada IS DISTINCT FROM b.cerrada_en AS d_fin,
           -- Con correlativos alternos, dos filas del lote pueden caer en el mismo proyecto.
           CASE WHEN b.project_id IS NOT NULL THEN count(*) OVER (PARTITION BY b.carnet, b.project_id) ELSE 1 END AS repetidas
    FROM base b
),
tipo AS (
    SELECT c.*,
           CASE
               WHEN c.enrollment_id IS NULL OR NOT (c.d_horas OR c.d_estado OR c.d_inicio OR c.d_fin) THEN NULL
               WHEN c.e_estado IN ('ASIGNADA', 'EN_CURSO') AND c.estado = 'FINALIZADA'
                    AND NOT c.d_inicio AND c.horas >= c.e_horas
                    AND c.cerrada_en IS NOT NULL AND c.cerrada_en >= c.e_asignada THEN 'FINALIZA'
               WHEN c.e_estado = 'FINALIZADA' AND c.estado = 'FINALIZADA'
                    AND NOT c.d_inicio AND c.horas > c.e_horas
                    AND c.cerrada_en IS NOT NULL AND (c.e_cerrada IS NULL OR c.cerrada_en >= c.e_cerrada) THEN 'AJUSTE_HORAS'
               ELSE 'BLOQUEO'
           END AS cambio
    FROM cmp c
)
SELECT t.*, k.*
FROM tipo t
CROSS JOIN LATERAL (
    SELECT
        -- Decisión vigente: solo si se tomó sobre las mismas horas (base y reporte).
        CASE WHEN t.cambio = 'AJUSTE_HORAS' AND t.dec_decision IS NOT NULL
                  AND t.dec_horas_existentes = t.e_horas AND t.dec_horas_reporte = t.horas
             THEN t.dec_decision END AS decision,
        array_remove(ARRAY[
            CASE WHEN t.proj_estado = 'CONFLICTO' THEN 'proyecto_en_conflicto' END,
            CASE WHEN t.stud_estado = 'CONFLICTO' THEN 'estudiante_en_conflicto' END,
            CASE WHEN t.repetidas > 1 THEN 'participacion_repetida_por_correlativo_alterno' END,
            CASE WHEN t.cambio = 'BLOQUEO' AND t.d_estado AND t.e_estado IN ('FINALIZADA', 'RETIRADA', 'CANCELADA')
                 THEN 'retroceso_de_estado' END,
            CASE WHEN t.cambio = 'BLOQUEO' AND t.horas < t.e_horas THEN 'horas_disminuyen' END,
            CASE WHEN t.cambio = 'BLOQUEO' AND t.d_horas   THEN 'horas_difieren' END,
            CASE WHEN t.cambio = 'BLOQUEO' AND t.d_estado  THEN 'estado_difiere' END,
            CASE WHEN t.cambio = 'BLOQUEO' AND t.d_inicio  THEN 'fecha_inicio_difiere' END,
            CASE WHEN t.cambio = 'BLOQUEO' AND t.d_fin     THEN 'fecha_fin_difiere' END
        ], NULL) AS bloqueos,
        -- Se cargan, pero conviene mirarlas: celdas cuyo corte del PDF se estimó por posición y,
        -- en la plantilla de revisión, valores que Excel había convertido y se recuperaron
        -- (carnet sin ceros, fecha como número de serie), filas agregadas a mano o
        -- corregidas en la revisión en línea.
        ARRAY(SELECT DISTINCT w FROM unnest(t.advertencias) w
              WHERE w LIKE 'celda_dividida_por_posicion:%' OR w = 'fila_cortada_entre_paginas'
                 OR w = 'carnet_completado_con_ceros' OR w LIKE 'fecha_leida_como_fecha_de_excel:%'
                 OR w = 'fila_agregada_en_revision' OR w = 'fila_editada_en_revision') AS avisos,
        CASE WHEN t.enrollment_id IS NOT NULL THEN jsonb_build_object(
            'id', t.enrollment_id, 'estado', t.e_estado, 'horas', t.e_horas,
            'asignadaEn', t.e_asignada, 'cerradaEn', t.e_cerrada) END AS existente
) k;

ALTER TABLE t_enr_c ADD COLUMN motivos text[], ADD COLUMN estado_item text, ADD COLUMN accion text;
UPDATE t_enr_c SET
    motivos = bloqueos || array_remove(ARRAY[
        CASE WHEN cambio = 'FINALIZA'     THEN 'finaliza_en_reporte' END,
        CASE WHEN cambio = 'AJUSTE_HORAS' THEN 'ajuste_horas_finalizada' END,
        CASE WHEN cambio = 'AJUSTE_HORAS' AND decision IS NULL THEN 'requiere_decision' END,
        CASE WHEN decision = 'ACEPTAR_REPORTE' THEN 'decision_aceptar_reporte' END,
        CASE WHEN decision = 'CONSERVAR_BD'    THEN 'decision_conservar_bd' END
    ], NULL),
    estado_item = CASE
        WHEN cardinality(bloqueos) > 0 THEN 'CONFLICTO'
        WHEN cambio = 'AJUSTE_HORAS' AND decision IS NULL THEN 'CONFLICTO'
        WHEN cambio = 'AJUSTE_HORAS' AND decision = 'CONSERVAR_BD' THEN 'IGNORADO'
        WHEN cambio IN ('FINALIZA', 'AJUSTE_HORAS') THEN 'ADVERTENCIA'
        WHEN enrollment_id IS NOT NULL THEN 'IGNORADO'
        WHEN cardinality(avisos) > 0 THEN 'ADVERTENCIA'
        ELSE 'NUEVO'
    END,
    accion = CASE
        WHEN cardinality(bloqueos) > 0 THEN 'NINGUNA'
        WHEN enrollment_id IS NULL THEN 'INSERTAR'
        WHEN cambio = 'FINALIZA' THEN 'ACTUALIZAR'
        WHEN cambio = 'AJUSTE_HORAS' AND decision = 'ACEPTAR_REPORTE' THEN 'ACTUALIZAR'
        ELSE 'NINGUNA'
    END;

-- =============================================================================
-- 5. Ítems de la vista previa
-- =============================================================================
INSERT INTO import_items (batch_id, entidad, clave, estado, accion, motivos, datos, existente, completar, ref_id, pdf_row_ids, xls_row_ids)
SELECT fn_import_actual(), 'INSTITUCION', codigo_css, estado, accion, motivos,
       jsonb_build_object('codigoCss', codigo_css, 'nombre', nombre),
       existente, completar, institution_id, coalesce(pdf_ids, '{}'), coalesce(xls_ids, '{}')
FROM t_inst_c;

INSERT INTO import_items (batch_id, entidad, clave, estado, accion, motivos, datos, existente, completar, ref_id, pdf_row_ids, xls_row_ids)
SELECT fn_import_actual(), 'PROYECTO', codigo_css || '/' || correlativo, estado, accion,
       motivos || CASE WHEN completar IS NOT NULL THEN ARRAY['completa_campos_vacios'] ELSE '{}' END,
       jsonb_build_object('codigoCss', codigo_css, 'correlativo', correlativo, 'titulo', titulo,
                          'fechaInicio', fecha_inicio, 'fechaCierre', fecha_cierre, 'areaCss', area,
                          'alumnosCss', alumnos,
                          -- Revisión: proyectos de la app con la misma nombre_clave (para vincular),
                          -- importados parecidos con otro correlativo y la decisión vigente.
                          'resolucion', resolucion, 'candidatosApp', app_lista,
                          'similaresImportados', similares_importados,
                          -- Proyectos del reporte CSS con el mismo título (para decidir ALIAS) y,
                          -- si se usa un correlativo alterno, el proyecto oficial al que apunta.
                          'candidatosReporte', rep_lista,
                          'correlativoAlterno', CASE WHEN resolucion IN ('ALIAS', 'ALIAS_NUEVO')
                                                     THEN jsonb_build_object('projectId', project_id, 'correlativo', e_corr) END,
                          'vinculo', CASE WHEN link_decision IS NOT NULL
                                          THEN jsonb_build_object('decision', link_decision, 'projectId', link_project_id) END),
       existente, completar, project_id, pdf_ids, xls_ids
FROM t_proj_c;

INSERT INTO import_items (batch_id, entidad, clave, estado, accion, motivos, datos, existente, ref_id, pdf_row_ids)
SELECT fn_import_actual(), 'ESTUDIANTE', carnet, estado, accion, motivos,
       jsonb_build_object('carnet', carnet, 'nombre', nombre_completo, 'carrera', carrera_reporte),
       existente, student_id, pdf_ids
FROM t_stud_c;

INSERT INTO import_items (batch_id, entidad, clave, estado, accion, motivos, datos, existente, ref_id, pdf_row_ids)
SELECT fn_import_actual(), 'PARTICIPACION', carnet || '@' || cod_institucion || '/' || correlativo,
       estado_item, accion, motivos || avisos,
       jsonb_build_object('carnet', carnet, 'nombre', nombre_completo,
                          'codigoCss', cod_institucion, 'correlativo', correlativo, 'proyecto', proyecto_nombre,
                          'estado', estado, 'estadoReporte', estado_reporte, 'horas', horas,
                          'fechaInicio', fecha_inicio, 'fechaFin', fecha_fin,
                          'archivo', archivo, 'pagina', pagina, 'linea', linea,
                          'pdfRowId', id, 'editada', editada, 'cambio', cambio),
       existente, enrollment_id, ARRAY[id]
FROM t_enr_c;
