-- =============================================================================
-- Importación masiva — INSERCIÓN ESTRICTA de un lote confirmado.
--
-- Requiere las tablas temporales t_*_c de classify.sql en la MISMA transacción
-- (la confirmación reclasifica bajo advisory lock justo antes de esto).
--
-- Reglas:
--   • Solo se escribe lo clasificado como INSERTAR, COMPLETAR o ACTUALIZAR. CONFLICTO nunca se toca.
--   • Todo INSERT usa ON CONFLICT DO NOTHING: si algo apareció entre medio, se ignora.
--   • Códigos CSS y correlativos se comparan sin ceros a la izquierda (fn_import_numero,
--     migración 014), igual que en classify.sql; se guardan ya normalizados.
--   • Correlativos alternos (migración 016): el proyecto de cada fila es el que resolvió
--     la clasificación (t_proj_c.project_id, que puede ser el proyecto oficial de un
--     alias); solo los proyectos recién insertados se buscan por su correlativo. Los alias
--     decididos en la revisión (ALIAS) se registran aquí, con su justificación.
--   • COMPLETAR solo llena columnas en NULL (coalesce(existente, nuevo)); el trigger
--     fn_auditoria deja el antes/después en `auditoria` con actor import:<lote>.
--   • Las horas se registran sobre participaciones CREADAS en este lote y, desde la
--     migración 013, sobre participaciones existentes clasificadas ACTUALIZAR
--     (Activo → Finalizada, o ajuste de horas aceptado explícitamente). En ese caso solo
--     se toca el movimiento del CSS (origen IMPORTACION, solicitud_id determinista): las
--     horas MANUAL nunca se modifican.
--
-- Formato: cada bloque "-- @step <nombre>" se ejecuta por separado y devuelve
-- (opcionalmente) una fila con la columna `n` = filas escritas.
-- =============================================================================

-- @step preparar
CREATE TEMP TABLE IF NOT EXISTS t_enr_nuevas (
    enrollment_id uuid NOT NULL,
    project_id    uuid NOT NULL,
    student_id    uuid NOT NULL
) ON COMMIT DROP;
CREATE TEMP TABLE IF NOT EXISTS t_enr_actualizadas (
    enrollment_id uuid NOT NULL
) ON COMMIT DROP;
CREATE TEMP TABLE IF NOT EXISTS t_enr_destino (
    pdf_row_id bigint NOT NULL,
    project_id uuid   NOT NULL
) ON COMMIT DROP;

-- @step instituciones_completadas
WITH upd AS (
    UPDATE institutions i
    SET codigo_css = t.codigo_css
    FROM t_inst_c t
    WHERE t.accion = 'COMPLETAR'
      AND i.id = t.institution_id
      AND i.codigo_css IS NULL
      AND NOT EXISTS (SELECT 1 FROM institutions o WHERE fn_import_numero(o.codigo_css) = t.codigo_css)
    RETURNING 1
)
SELECT count(*)::int AS n FROM upd;

-- @step instituciones_insertadas
WITH ins AS (
    INSERT INTO institutions (codigo_css, nombre)
    SELECT codigo_css, nombre FROM t_inst_c WHERE accion = 'INSERTAR'
    ON CONFLICT DO NOTHING
    RETURNING 1
)
SELECT count(*)::int AS n FROM ins;

-- @step campo_area_css
-- projects.atributos se valida contra project_fields en la app.
INSERT INTO project_fields (clave, etiqueta, tipo, orden)
SELECT 'area_css', 'Área temática (CSS)', 'TEXTO', 100
WHERE EXISTS (SELECT 1 FROM t_proj_c WHERE area IS NOT NULL AND accion <> 'NINGUNA')
ON CONFLICT (clave) DO NOTHING;

-- @step proyectos_completados
WITH upd AS (
    UPDATE projects p
    SET correlativo_css = coalesce(p.correlativo_css, t.completar ->> 'correlativo_css'),
        fecha_inicio    = coalesce(p.fecha_inicio, (t.completar ->> 'fecha_inicio')::date),
        fecha_cierre    = coalesce(p.fecha_cierre, (t.completar ->> 'fecha_cierre')::date),
        -- area_css solo completa vacíos; alumnos_css (foto del último Excel) se reemplaza.
        atributos       = p.atributos || jsonb_strip_nulls(jsonb_build_object(
                              'area_css',    CASE WHEN p.atributos -> 'area_css' IS NULL
                                                  THEN t.completar -> 'area_css' END,
                              'alumnos_css', t.completar -> 'alumnos_css'))
    FROM t_proj_c t
    WHERE t.accion = 'COMPLETAR' AND p.id = t.project_id
    RETURNING 1
)
SELECT count(*)::int AS n FROM upd;

-- @step proyectos_insertados
WITH ins AS (
    INSERT INTO projects (institution_id, correlativo_css, titulo, descripcion, naturaleza, estado,
                          fecha_inicio, fecha_cierre, atributos)
    SELECT i.id, t.correlativo, t.titulo,
           '',                                        -- las fuentes no traen descripción
           'EXTERNA',
           CASE WHEN t.fecha_cierre <= current_date THEN 'FINALIZADO' ELSE 'ACTIVO' END,
           t.fecha_inicio, t.fecha_cierre,
           jsonb_strip_nulls(jsonb_build_object('area_css', t.area, 'alumnos_css', t.alumnos))
    FROM t_proj_c t
    JOIN institutions i ON fn_import_numero(i.codigo_css) = t.codigo_css
    WHERE t.accion = 'INSERTAR'
    ON CONFLICT DO NOTHING
    RETURNING 1
)
SELECT count(*)::int AS n FROM ins;

-- @step proyectos_en_reporte_css
-- Marca (migración 015) los proyectos del lote que vienen en el Excel CSS, nuevos o ya
-- existentes, aunque no haya nada más que completar. Solo de false a true.
WITH upd AS (
    UPDATE projects p
    SET en_reporte_css = true
    FROM t_proj_c t
    JOIN institutions i ON fn_import_numero(i.codigo_css) = t.codigo_css
    WHERE cardinality(t.xls_ids) > 0
      AND p.institution_id = i.id
      AND fn_import_numero(p.correlativo_css) = t.correlativo
      AND NOT p.en_reporte_css
    RETURNING 1
)
SELECT count(*)::int AS n FROM upd;

-- @step correlativos_alternos
-- Decisión ALIAS de la revisión: el correlativo del lote es alterno de un proyecto del
-- reporte CSS. fn_alias_validar (016) vuelve a exigir misma institución, mismo título y
-- que la llave no sea de otro proyecto.
WITH ins AS (
    INSERT INTO project_correlativo_alias
        (institution_id, correlativo_css, project_id, nombre_clave_reporte, origen, justificacion)
    SELECT i.id, t.correlativo, t.project_id, fn_nombre_clave(t.titulo), 'REVISION_IMPORTACION', l.justificacion
    FROM t_proj_c t
    JOIN institutions i ON fn_import_numero(i.codigo_css) = t.codigo_css
    JOIN import_project_links l ON l.batch_id = fn_import_actual() AND l.clave = t.codigo_css || '/' || t.correlativo
    WHERE t.resolucion = 'ALIAS_NUEVO' AND l.decision = 'ALIAS' AND t.project_id IS NOT NULL
    ON CONFLICT (institution_id, correlativo_css) DO NOTHING
    RETURNING 1
)
SELECT count(*)::int AS n FROM ins;

-- @step destino_de_participaciones
-- Proyecto de cada fila del lote: el resuelto por la clasificación (existente, adoptado o
-- alias) o, si era nuevo, el recién insertado con esa institución y correlativo.
WITH ins AS (
    INSERT INTO t_enr_destino (pdf_row_id, project_id)
    SELECT t.id, coalesce(t.project_id, p.id)
    FROM t_enr_c t
    JOIN institutions i ON fn_import_numero(i.codigo_css) = t.cod_institucion
    LEFT JOIN projects p ON t.project_id IS NULL AND p.institution_id = i.id
                        AND fn_import_numero(p.correlativo_css) = t.correlativo
    WHERE coalesce(t.project_id, p.id) IS NOT NULL
    RETURNING 1
)
SELECT count(*)::int AS n FROM ins;

-- @step estudiantes_insertados
WITH ins AS (
    INSERT INTO students (carnet, nombres, apellidos, nombre_completo, correo_institucional, career_id)
    SELECT carnet, NULL, NULL, nombre_completo, carnet || '@uca.edu.sv', career_id
    FROM t_stud_c
    WHERE accion = 'INSERTAR'
    ON CONFLICT DO NOTHING
    RETURNING 1
)
SELECT count(*)::int AS n FROM ins;

-- @step participaciones_insertadas
WITH ins AS (
    INSERT INTO project_enrollments (project_id, student_id, cargo, estado, asignada_en, cerrada_en)
    SELECT d.project_id, s.id, 'ESTUDIANTE', t.estado, t.asignada_en, t.cerrada_en
    FROM t_enr_c t
    JOIN students s       ON s.carnet = t.carnet
    JOIN t_enr_destino d  ON d.pdf_row_id = t.id
    WHERE t.accion = 'INSERTAR'
    ON CONFLICT DO NOTHING
    RETURNING id, project_id, student_id
),
nuevas AS (
    INSERT INTO t_enr_nuevas SELECT id, project_id, student_id FROM ins
    RETURNING 1
)
SELECT count(*)::int AS n FROM nuevas;

-- @step participaciones_actualizadas
-- Participación existente (estudiante + proyecto) clasificada ACTUALIZAR: estado y cierre
-- del reporte. Solo si la base sigue como se clasificó (si cambió entre la clasificación y
-- este paso, no se escribe y la reimportación la mostrará de nuevo).
WITH upd AS (
    UPDATE project_enrollments pe
    SET estado = t.estado, cerrada_en = t.cerrada_en
    FROM t_enr_c t
    WHERE t.accion = 'ACTUALIZAR'
      AND pe.id = t.enrollment_id
      AND pe.estado = t.e_estado
      AND pe.asignada_en = t.e_asignada
      AND pe.cerrada_en IS NOT DISTINCT FROM t.e_cerrada
    RETURNING pe.id
),
hechas AS (
    INSERT INTO t_enr_actualizadas SELECT id FROM upd
    RETURNING 1
)
SELECT count(*)::int AS n FROM hechas;

-- @step movimientos_actualizados
-- Horas del CSS de esas participaciones: el movimiento con el solicitud_id determinista
-- (el mismo que usa la inserción) queda con lo que falta para que el total CSS de la
-- participación sea el del reporte. Se crea si no existía (Activo con 0 h); nunca se
-- duplica; solo se actualiza si es de origen IMPORTACION y de esa participación.
WITH obj AS (
    SELECT t.enrollment_id, t.horas, t.fecha_fin, t.archivo, t.pagina, p.naturaleza,
           md5(format('etl-css|%s|%s|%s', t.carnet, t.cod_institucion, t.correlativo))::uuid AS sid
    FROM t_enr_c t
    JOIN t_enr_actualizadas a ON a.enrollment_id = t.enrollment_id
    JOIN projects p ON p.id = t.project_id
),
calc AS (
    SELECT o.*,
           o.horas - coalesce((SELECT sum(hm.horas) FROM hour_movements hm
                               WHERE hm.enrollment_id = o.enrollment_id
                                 AND hm.origen <> 'MANUAL'
                                 AND hm.solicitud_id IS DISTINCT FROM o.sid), 0)::int AS horas_mov
    FROM obj o
),
up AS (
    INSERT INTO hour_movements (enrollment_id, horas, naturaleza, fecha_horas, descripcion, solicitud_id, origen)
    SELECT c.enrollment_id, c.horas_mov, c.naturaleza, c.fecha_fin,
           format('Importación %s (actualización): %s, p. %s', fn_import_actual(), c.archivo, c.pagina),
           c.sid, 'IMPORTACION'
    FROM calc c
    WHERE c.horas_mov > 0
    ON CONFLICT (solicitud_id) DO UPDATE
        SET horas = EXCLUDED.horas, fecha_horas = EXCLUDED.fecha_horas, descripcion = EXCLUDED.descripcion
        WHERE hour_movements.origen = 'IMPORTACION'
          AND hour_movements.enrollment_id = EXCLUDED.enrollment_id
          AND hour_movements.horas IS DISTINCT FROM EXCLUDED.horas
    RETURNING horas
)
SELECT count(*)::int AS n, coalesce(sum(horas), 0)::int AS horas FROM up;

-- @step carreras_de_proyecto
WITH ins AS (
    INSERT INTO project_careers (project_id, career_id)
    SELECT DISTINCT n.project_id, t.career_id
    FROM t_enr_c t
    JOIN students s      ON s.carnet = t.carnet
    JOIN t_enr_destino d ON d.pdf_row_id = t.id
    JOIN t_enr_nuevas n  ON n.student_id = s.id AND n.project_id = d.project_id
    ON CONFLICT DO NOTHING
    RETURNING 1
)
SELECT count(*)::int AS n FROM ins;

-- @step movimientos_de_horas
-- solicitud_id determinista con el mismo formato del ETL histórico: nunca duplica horas.
WITH ins AS (
    INSERT INTO hour_movements (enrollment_id, horas, naturaleza, fecha_horas, descripcion, solicitud_id, origen)
    SELECT n.enrollment_id, t.horas, p.naturaleza, t.fecha_fin,
           format('Importación %s: %s, p. %s', fn_import_actual(), t.archivo, t.pagina),
           md5(format('etl-css|%s|%s|%s', t.carnet, t.cod_institucion, t.correlativo))::uuid,
           'IMPORTACION'
    FROM t_enr_c t
    JOIN students s      ON s.carnet = t.carnet
    JOIN t_enr_destino d ON d.pdf_row_id = t.id
    JOIN projects p      ON p.id = d.project_id
    JOIN t_enr_nuevas n  ON n.student_id = s.id AND n.project_id = d.project_id
    WHERE t.horas > 0                                  -- 0 horas no genera movimiento
    ON CONFLICT DO NOTHING
    RETURNING horas
)
SELECT count(*)::int AS n, coalesce(sum(horas), 0)::int AS horas FROM ins;

-- @step estados_de_proyecto
-- Proyectos del lote (existentes, recién insertados o destino de un correlativo alterno).
-- Ver migración 007:
--   • proyectos que NO están en el reporte CSS: se completa el cierre de los que ya no
--     tienen estudiantes activos (fecha derivada de los estudiantes) y se finalizan los
--     vencidos;
--   • proyectos del reporte CSS (en_reporte_css, ya marcado en este lote por el paso
--     proyectos_en_reporte_css): mandan sus fechas y estado oficiales del Excel. Nunca se
--     les deriva el cierre de los estudiantes; solo se finalizan si su fecha de cierre
--     oficial ya pasó. (Un arreglo vacío no sincroniza nada; NULL sería "todos".)
WITH lote AS (
    SELECT DISTINCT coalesce(t.project_id, p.id) AS id
    FROM t_proj_c t
    JOIN institutions i ON fn_import_numero(i.codigo_css) = t.codigo_css
    LEFT JOIN projects p ON t.project_id IS NULL AND p.institution_id = i.id
                        AND fn_import_numero(p.correlativo_css) = t.correlativo
    WHERE coalesce(t.project_id, p.id) IS NOT NULL
),
sync AS (
    SELECT s.* FROM fn_sincronizar_estado_proyectos(
        ARRAY(SELECT l.id FROM lote l JOIN projects x ON x.id = l.id WHERE NOT x.en_reporte_css), true) s
    UNION ALL
    SELECT s.* FROM fn_sincronizar_estado_proyectos(
        ARRAY(SELECT l.id FROM lote l JOIN projects x ON x.id = l.id WHERE x.en_reporte_css), false) s
)
SELECT coalesce(sum(finalizados), 0)::int AS n, coalesce(sum(fechas_completadas), 0)::int AS fechas_completadas
FROM sync;
