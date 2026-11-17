-- =============================================================================
-- Importación masiva — INSERCIÓN ESTRICTA de un lote confirmado.
--
-- Requiere las tablas temporales t_*_c de classify.sql en la MISMA transacción
-- (la confirmación reclasifica bajo advisory lock justo antes de esto).
--
-- Reglas:
--   • Solo se escribe lo clasificado como INSERTAR o COMPLETAR. CONFLICTO nunca se toca.
--   • Todo INSERT usa ON CONFLICT DO NOTHING: si algo apareció entre medio, se ignora.
--   • COMPLETAR solo llena columnas en NULL (coalesce(existente, nuevo)); el trigger
--     fn_auditoria deja el antes/después en `auditoria` con actor import:<lote>.
--   • Las horas solo se registran sobre participaciones CREADAS en este lote: una
--     participación existente jamás recibe horas nuevas por importación.
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

-- @step instituciones_completadas
WITH upd AS (
    UPDATE institutions i
    SET codigo_css = t.codigo_css
    FROM t_inst_c t
    WHERE t.accion = 'COMPLETAR'
      AND i.id = t.institution_id
      AND i.codigo_css IS NULL
      AND NOT EXISTS (SELECT 1 FROM institutions o WHERE o.codigo_css = t.codigo_css)
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
        atributos       = CASE
                              WHEN p.atributos -> 'area_css' IS NULL AND t.completar ->> 'area_css' IS NOT NULL
                              THEN p.atributos || jsonb_build_object('area_css', t.completar ->> 'area_css')
                              ELSE p.atributos
                          END
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
           CASE WHEN t.area IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('area_css', t.area) END
    FROM t_proj_c t
    JOIN institutions i ON i.codigo_css = t.codigo_css
    WHERE t.accion = 'INSERTAR'
    ON CONFLICT DO NOTHING
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
    SELECT p.id, s.id, 'ESTUDIANTE', t.estado, t.asignada_en, t.cerrada_en
    FROM t_enr_c t
    JOIN students s     ON s.carnet = t.carnet
    JOIN institutions i ON i.codigo_css = t.cod_institucion
    JOIN projects p     ON p.institution_id = i.id AND p.correlativo_css = t.correlativo
    WHERE t.accion = 'INSERTAR'
    ON CONFLICT DO NOTHING
    RETURNING id, project_id, student_id
),
nuevas AS (
    INSERT INTO t_enr_nuevas SELECT id, project_id, student_id FROM ins
    RETURNING 1
)
SELECT count(*)::int AS n FROM nuevas;

-- @step carreras_de_proyecto
WITH ins AS (
    INSERT INTO project_careers (project_id, career_id)
    SELECT DISTINCT n.project_id, t.career_id
    FROM t_enr_c t
    JOIN students s     ON s.carnet = t.carnet
    JOIN institutions i ON i.codigo_css = t.cod_institucion
    JOIN projects p     ON p.institution_id = i.id AND p.correlativo_css = t.correlativo
    JOIN t_enr_nuevas n ON n.student_id = s.id AND n.project_id = p.id
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
    JOIN students s     ON s.carnet = t.carnet
    JOIN institutions i ON i.codigo_css = t.cod_institucion
    JOIN projects p     ON p.institution_id = i.id AND p.correlativo_css = t.correlativo
    JOIN t_enr_nuevas n ON n.student_id = s.id AND n.project_id = p.id
    WHERE t.horas > 0                                  -- 0 horas no genera movimiento
    ON CONFLICT DO NOTHING
    RETURNING horas
)
SELECT count(*)::int AS n, coalesce(sum(horas), 0)::int AS horas FROM ins;
