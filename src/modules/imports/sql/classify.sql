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
--               entidad en conflicto, o participación existente con datos distintos.
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
    fn_import_limpiar(r.cod_institucion)                                  AS cod_institucion,
    fn_import_limpiar(fn_import_corregir_mojibake(r.institucion))         AS institucion,
    fn_import_limpiar(r.correlativo)                                      AS correlativo,
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
    r.advertencias
FROM import_pdf_rows r
LEFT JOIN import_map_estados e ON e.estado_reporte = fn_import_limpiar(r.estado)
WHERE r.batch_id = fn_import_actual();

CREATE TEMP TABLE t_xls ON COMMIT DROP AS
SELECT
    r.id, r.archivo, r.hoja, r.fila_excel,
    fn_import_limpiar(r.area)                                             AS area,
    fn_import_limpiar(r.cod_institucion)                                  AS cod_institucion,
    fn_import_limpiar(fn_import_corregir_mojibake(r.institucion))         AS institucion,
    fn_import_limpiar(r.correlativo)                                      AS correlativo,
    fn_import_limpiar(fn_import_corregir_mojibake(r.proyecto_nombre))     AS proyecto_nombre,
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
           'detalles', jsonb_object_agg(x.motivo, x.detalle)),
       ARRAY[v.id]
FROM t_pdf v
JOIN t_rechazos x ON x.origen = 'PDF' AND x.row_id = v.id
GROUP BY v.id, v.archivo, v.pagina, v.linea, v.carnet, v.nombre_completo, v.cod_institucion, v.institucion,
         v.correlativo, v.proyecto_nombre, v.carrera_reporte, v.estado_reporte,
         v.fecha_inicio_raw, v.fecha_fin_raw, v.horas_raw;

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
SELECT id, archivo, pagina, carnet, nombre_completo, cod_institucion, correlativo, proyecto_nombre,
       career_id, estado, estado_reporte, horas, fecha_inicio, fecha_fin, advertencias,
       fn_import_inicio_dia(fecha_inicio) AS asignada_en,
       -- Activo → sin cierre. FINALIZADA/RETIRADA → cierre = fecha de fin.
       CASE WHEN estado = 'EN_CURSO' THEN NULL ELSE fn_import_inicio_dia(fecha_fin) END AS cerrada_en
FROM t_pdf_ok;

-- =============================================================================
-- 4. Clasificación contra el maestro
-- =============================================================================

-- 4.1 Instituciones. Llave: codigo_css. Si la app ya creó la institución con el mismo
-- nombre y SIN código, se adopta completando codigo_css (regla 2).
CREATE TEMP TABLE t_inst_c ON COMMIT DROP AS
WITH base AS (
    SELECT t.*,
           bc.id AS code_id, bc.nombre AS code_nombre,
           bn.id AS name_id, bn.codigo_css AS name_codigo, bn.nombre AS name_nombre,
           count(*) OVER (PARTITION BY fn_normalize_text(t.nombre)) AS mismo_nombre
    FROM t_inst t
    LEFT JOIN institutions bc ON bc.codigo_css = t.codigo_css
    LEFT JOIN institutions bn ON bn.nombre_normalizado = fn_normalize_text(t.nombre)
)
SELECT b.codigo_css, b.nombre, b.pdf_ids, b.xls_ids, k.*
FROM base b
CROSS JOIN LATERAL (
    SELECT
        CASE
            WHEN b.code_id IS NOT NULL THEN b.code_id
            WHEN b.mismo_nombre = 1 AND b.name_id IS NOT NULL AND b.name_codigo IS NULL THEN b.name_id
        END AS institution_id,
        CASE
            WHEN b.code_id IS NOT NULL THEN
                CASE WHEN fn_normalize_text(b.code_nombre) = fn_normalize_text(b.nombre) THEN 'IGNORADO' ELSE 'ADVERTENCIA' END
            WHEN b.mismo_nombre > 1 THEN 'CONFLICTO'
            WHEN b.name_id IS NOT NULL AND b.name_codigo IS NULL THEN 'ADVERTENCIA'
            WHEN b.name_id IS NOT NULL THEN 'CONFLICTO'
            ELSE 'NUEVO'
        END AS estado,
        CASE
            WHEN b.code_id IS NOT NULL THEN 'NINGUNA'
            WHEN b.mismo_nombre > 1 THEN 'NINGUNA'
            WHEN b.name_id IS NOT NULL AND b.name_codigo IS NULL THEN 'COMPLETAR'
            WHEN b.name_id IS NOT NULL THEN 'NINGUNA'
            ELSE 'INSERTAR'
        END AS accion,
        array_remove(ARRAY[
            CASE WHEN b.code_id IS NOT NULL AND fn_normalize_text(b.code_nombre) <> fn_normalize_text(b.nombre)
                 THEN 'nombre_difiere_se_conserva_existente' END,
            CASE WHEN b.code_id IS NULL AND b.mismo_nombre > 1 THEN 'nombre_repetido_con_otro_codigo_en_lote' END,
            CASE WHEN b.code_id IS NULL AND b.mismo_nombre = 1 AND b.name_id IS NOT NULL AND b.name_codigo IS NULL
                 THEN 'completa_codigo_css' END,
            CASE WHEN b.code_id IS NULL AND b.name_id IS NOT NULL AND b.name_codigo IS NOT NULL
                 THEN 'nombre_en_uso_por_otro_codigo' END
        ], NULL) AS motivos,
        CASE
            WHEN b.code_id IS NOT NULL THEN jsonb_build_object('id', b.code_id, 'nombre', b.code_nombre, 'codigoCss', b.codigo_css)
            WHEN b.name_id IS NOT NULL THEN jsonb_build_object('id', b.name_id, 'nombre', b.name_nombre, 'codigoCss', b.name_codigo)
        END AS existente,
        CASE WHEN b.code_id IS NULL AND b.mismo_nombre = 1 AND b.name_id IS NOT NULL AND b.name_codigo IS NULL
             THEN jsonb_build_object('codigo_css', b.codigo_css) END AS completar
) k;

-- 4.2 Proyectos. Llave: (institución, correlativo). Un proyecto creado en la app sin
-- correlativo y con el mismo título se adopta (completa correlativo_css) si es único en el lote.
CREATE TEMP TABLE t_proj_c ON COMMIT DROP AS
WITH base AS (
    SELECT t.*,
           ic.institution_id, ic.estado AS inst_estado,
           coalesce(p.id, CASE WHEN t.mismo_titulo = 1 THEN a.id END) AS project_id,
           p.id IS NULL AND t.mismo_titulo = 1 AND a.id IS NOT NULL   AS adoptado,
           coalesce(p.titulo, a.titulo)               AS e_titulo,
           coalesce(p.fecha_inicio, a.fecha_inicio)   AS e_inicio,
           coalesce(p.fecha_cierre, a.fecha_cierre)   AS e_cierre,
           coalesce(p.atributos, a.atributos)         AS e_atributos,
           coalesce(p.estado, a.estado)               AS e_estado
    FROM (SELECT *, count(*) OVER (PARTITION BY codigo_css, fn_normalize_text(titulo)) AS mismo_titulo FROM t_proj) t
    JOIN t_inst_c ic ON ic.codigo_css = t.codigo_css
    LEFT JOIN projects p ON p.institution_id = ic.institution_id AND p.correlativo_css = t.correlativo
    LEFT JOIN projects a ON p.id IS NULL
                        AND a.institution_id = ic.institution_id
                        AND a.correlativo_css IS NULL
                        AND a.nombre_normalizado = fn_normalize_text(t.titulo)
),
fill AS (
    SELECT b.*,
           b.project_id IS NOT NULL AND b.fechas_oficiales AND b.e_inicio IS NULL AND b.fecha_inicio IS NOT NULL
               AND (b.e_cierre IS NULL OR b.fecha_inicio <= b.e_cierre) AS llenar_inicio,
           b.project_id IS NOT NULL AND b.e_atributos IS NOT NULL AND b.area IS NOT NULL
               AND b.e_atributos -> 'area_css' IS NULL AS llenar_area
    FROM base b
),
fill2 AS (
    SELECT f.*,
           f.project_id IS NOT NULL AND f.fechas_oficiales AND f.e_cierre IS NULL AND f.fecha_cierre IS NOT NULL
               AND coalesce(f.e_inicio, CASE WHEN f.llenar_inicio THEN f.fecha_inicio END, f.fecha_cierre) <= f.fecha_cierre
               AS llenar_cierre
    FROM fill f
)
SELECT f.codigo_css, f.correlativo, f.titulo, f.fecha_inicio, f.fecha_cierre, f.area,
       f.pdf_ids, f.xls_ids, f.institution_id, f.project_id, k.*
FROM fill2 f
CROSS JOIN LATERAL (
    SELECT
        nullif(jsonb_strip_nulls(jsonb_build_object(
            'correlativo_css', CASE WHEN f.adoptado THEN f.correlativo END,
            'fecha_inicio',    CASE WHEN f.llenar_inicio THEN f.fecha_inicio END,
            'fecha_cierre',    CASE WHEN f.llenar_cierre THEN f.fecha_cierre END,
            'area_css',        CASE WHEN f.llenar_area THEN f.area END
        )), '{}'::jsonb) AS completar,
        array_remove(ARRAY[
            CASE WHEN f.inst_estado = 'CONFLICTO' THEN 'institucion_en_conflicto' END,
            CASE WHEN f.project_id IS NOT NULL AND fn_normalize_text(f.e_titulo) <> fn_normalize_text(f.titulo)
                 THEN 'titulo_difiere_se_conserva_existente' END,
            CASE WHEN f.project_id IS NOT NULL AND f.fechas_oficiales AND f.e_inicio IS NOT NULL AND f.fecha_inicio IS NOT NULL
                      AND f.e_inicio <> f.fecha_inicio THEN 'fecha_inicio_difiere_se_conserva_existente' END,
            CASE WHEN f.project_id IS NOT NULL AND f.fechas_oficiales AND f.e_cierre IS NOT NULL AND f.fecha_cierre IS NOT NULL
                      AND f.e_cierre <> f.fecha_cierre THEN 'fecha_cierre_difiere_se_conserva_existente' END,
            CASE WHEN f.project_id IS NOT NULL AND f.fechas_oficiales AND f.e_cierre IS NULL AND f.fecha_cierre IS NOT NULL
                      AND NOT f.llenar_cierre
                 THEN 'fecha_cierre_incompatible_no_se_completa' END,
            CASE WHEN f.adoptado THEN 'adopta_proyecto_sin_correlativo' END,
            -- El ajuste solo importa si la fecha se va a escribir (proyecto nuevo o cierre en NULL).
            CASE WHEN f.fin_ajustado AND (f.project_id IS NULL OR f.llenar_cierre)
                 THEN 'fecha_fin_ajustada:' || f.fin_original END
        ], NULL) AS motivos,
        CASE WHEN f.project_id IS NOT NULL THEN jsonb_build_object(
            'id', f.project_id, 'titulo', f.e_titulo, 'estado', f.e_estado,
            'fechaInicio', f.e_inicio, 'fechaCierre', f.e_cierre, 'areaCss', f.e_atributos ->> 'area_css')
        END AS existente
) k;

ALTER TABLE t_proj_c ADD COLUMN estado text, ADD COLUMN accion text;
UPDATE t_proj_c SET
    estado = CASE
        WHEN 'institucion_en_conflicto' = ANY (motivos) THEN 'CONFLICTO'
        WHEN project_id IS NULL THEN CASE WHEN cardinality(motivos) > 0 THEN 'ADVERTENCIA' ELSE 'NUEVO' END
        WHEN completar IS NOT NULL OR cardinality(motivos) > 0 THEN 'ADVERTENCIA'
        ELSE 'IGNORADO'
    END,
    accion = CASE
        WHEN 'institucion_en_conflicto' = ANY (motivos) THEN 'NINGUNA'
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
--   • Ya existe con datos distintos → CONFLICTO: no se sobrescribe, se revisa a mano.
CREATE TEMP TABLE t_enr_c ON COMMIT DROP AS
WITH base AS (
    SELECT e.*,
           pc.project_id, pc.estado AS proj_estado,
           sc.student_id, sc.estado AS stud_estado,
           pe.id AS enrollment_id, pe.estado AS e_estado, pe.asignada_en AS e_asignada, pe.cerrada_en AS e_cerrada,
           (SELECT coalesce(sum(hm.horas), 0)::integer FROM hour_movements hm WHERE hm.enrollment_id = pe.id) AS e_horas
    FROM t_enr e
    JOIN t_proj_c pc ON pc.codigo_css = e.cod_institucion AND pc.correlativo = e.correlativo
    JOIN t_stud_c sc ON sc.carnet = e.carnet
    LEFT JOIN project_enrollments pe ON pe.student_id = sc.student_id AND pe.project_id = pc.project_id
)
SELECT b.*, k.*
FROM base b
CROSS JOIN LATERAL (
    SELECT
        array_remove(ARRAY[
            CASE WHEN b.proj_estado = 'CONFLICTO' THEN 'proyecto_en_conflicto' END,
            CASE WHEN b.stud_estado = 'CONFLICTO' THEN 'estudiante_en_conflicto' END,
            CASE WHEN b.enrollment_id IS NOT NULL AND b.e_horas <> b.horas THEN 'horas_difieren' END,
            CASE WHEN b.enrollment_id IS NOT NULL AND b.e_estado <> b.estado THEN 'estado_difiere' END,
            CASE WHEN b.enrollment_id IS NOT NULL AND b.e_asignada <> b.asignada_en THEN 'fecha_inicio_difiere' END,
            CASE WHEN b.enrollment_id IS NOT NULL AND b.e_cerrada IS DISTINCT FROM b.cerrada_en THEN 'fecha_fin_difiere' END
        ], NULL) AS motivos,
        -- Celdas cuyo corte se estimó por posición: se cargan, pero conviene mirarlas.
        ARRAY(SELECT DISTINCT w FROM unnest(b.advertencias) w
              WHERE w LIKE 'celda_dividida_por_posicion:%' OR w = 'fila_cortada_entre_paginas') AS avisos,
        CASE WHEN b.enrollment_id IS NOT NULL THEN jsonb_build_object(
            'id', b.enrollment_id, 'estado', b.e_estado, 'horas', b.e_horas,
            'asignadaEn', b.e_asignada, 'cerradaEn', b.e_cerrada) END AS existente
) k;

ALTER TABLE t_enr_c ADD COLUMN estado_item text, ADD COLUMN accion text;
UPDATE t_enr_c SET
    estado_item = CASE
        WHEN cardinality(motivos) > 0 THEN 'CONFLICTO'
        WHEN enrollment_id IS NOT NULL THEN 'IGNORADO'
        WHEN cardinality(avisos) > 0 THEN 'ADVERTENCIA'
        ELSE 'NUEVO'
    END,
    accion = CASE WHEN cardinality(motivos) = 0 AND enrollment_id IS NULL THEN 'INSERTAR' ELSE 'NINGUNA' END;

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
                          'fechaInicio', fecha_inicio, 'fechaCierre', fecha_cierre, 'areaCss', area),
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
                          'archivo', archivo, 'pagina', pagina),
       existente, enrollment_id, ARRAY[id]
FROM t_enr_c;
