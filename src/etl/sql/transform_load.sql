-- =============================================================================
-- ETL histórico — fase Transform + Load: staging.* → esquema maestro.
--
-- Lo ejecuta `pnpm etl:transform` dentro de UNA transacción (sin BEGIN/COMMIT aquí);
-- con --dry-run la transacción se revierte al final.
--
-- Requisitos: migración 002_legacy_css_import_support.sql aplicada y staging cargado
-- (`pnpm etl:staging:load`).
--
-- Reglas acordadas:
--   1. Nombre: el bloque literal "APELLIDO1, APELLIDO2 NOMBRES" va a students.nombre_completo;
--      nombres/apellidos quedan NULL.
--   2. Mojibake ("PLÃ?STICO"): se corrige con el mapa staging.map_mojibake, en el Excel
--      y también en los PDFs (el texto ya venía dañado desde el sistema de origen).
--   3. Proyecto = (institución por codigo_css, correlativo_css).
--   4. Los PDFs son la fuente oficial: sus nombres ganan; el Excel completa lo que falta.
--   5. Se usan las fechas de cada estudiante, no la fecha de corte del reporte.
--   5b. Excel con fecha_fin < fecha_inicio: se respeta el inicio y se suman años al fin
--       hasta que fin >= inicio. Cada ajuste queda registrado en staging.ajustes.
--       Un proyecto es FINALIZADO solo si su cierre ya pasó (los ajustados suelen caer a futuro).
--   6. "01/01/1900" = sin fecha. Activo + 0 h → participación EN_CURSO sin cierre y sin horas.
--   + Correo institucional derivado: <carnet>@uca.edu.sv.
--
-- Idempotente: cada INSERT usa ON CONFLICT sobre la llave natural; repetirlo no duplica
-- y solo actualiza lo que cambió (WHERE ... IS DISTINCT FROM evita UPDATEs vacíos).
-- =============================================================================

SET LOCAL app.actor = 'etl:css-historico';          -- queda registrado en `auditoria`

-- Objetos de trabajo de una corrida anterior (las vistas dependen de las tablas de reglas).
DROP VIEW IF EXISTS staging.v_pdf_ok, staging.v_xls_ok, staging.v_pdf, staging.v_xls;

-- =============================================================================
-- 0. Reglas de negocio como datos (editables sin tocar la lógica)
-- =============================================================================
DROP TABLE IF EXISTS staging.map_carreras;
-- Texto del reporte (ya sin sufijo de modalidad, ver fn_carrera_sin_modalidad) → carrera
-- del catálogo oficial. La FACULTAD no se define aquí: sale de careers.faculty_id
-- (migración 003), que es la única fuente de verdad.
CREATE TABLE staging.map_carreras (
    carrera_reporte  text PRIMARY KEY,
    carrera          text NOT NULL                   -- debe existir en `careers` (migración 003)
);
INSERT INTO staging.map_carreras VALUES
    ('ARQUITECTURA',            'Arquitectura'),
    ('INGENIERIA CIVIL',        'Ingeniería Civil'),
    ('INGENIERIA DE ALIMENTOS', 'Ingeniería de Alimentos'),
    ('INGENIERIA ELECTRICA',    'Ingeniería Eléctrica'),
    ('INGENIERIA ENERGETICA',   'Ingeniería Energética'),
    ('INGENIERIA INDUSTRIAL',   'Ingeniería Industrial'),
    ('INGENIERIA MECANICA',     'Ingeniería Mecánica'),
    ('INGENIERIA QUIMICA',      'Ingeniería Química'),
    ('LIC. EN DISEÑO',          'Licenciatura en Diseño');

-- El ETL no crea facultades ni carreras: solo enlaza con el catálogo oficial.
-- Un nombre que no exista aborta la carga en vez de inventar una carrera.
DO $$
DECLARE
    v_faltantes text;
BEGIN
    SELECT string_agg(m.carrera, ', ') INTO v_faltantes
    FROM staging.map_carreras m
    WHERE NOT EXISTS (SELECT 1 FROM careers c WHERE c.nombre_normalizado = fn_normalize_text(m.carrera));
    IF v_faltantes IS NOT NULL THEN
        RAISE EXCEPTION 'Carreras del mapa que no existen en el catálogo oficial: %. ¿Falta pnpm db:migrate (003)?', v_faltantes;
    END IF;
END;
$$;

-- El origen perdió el 2.º byte UTF-8 ("Ã?"): no es reversible por código, se mapea palabra a palabra.
DROP TABLE IF EXISTS staging.map_mojibake;
CREATE TABLE staging.map_mojibake (
    roto      text PRIMARY KEY,
    correcto  text NOT NULL
);
INSERT INTO staging.map_mojibake VALUES
    ('ACOMPAÃ?AMIENTO', 'ACOMPAÑAMIENTO'),
    ('ESPAÃ?A',         'ESPAÑA'),
    ('NIÃ?EZ',          'NIÑEZ'),
    ('PLÃ?STICO',       'PLÁSTICO'),
    ('REPARACIÃ?N',     'REPARACIÓN'),
    ('SALVADOREÃ?A',    'SALVADOREÑA'),
    ('SEÃ?ORA',         'SEÑORA');

-- Estado del reporte → estado de project_enrollments.
DROP TABLE IF EXISTS staging.map_estados;
CREATE TABLE staging.map_estados (
    estado_reporte  text PRIMARY KEY,
    estado          text NOT NULL,
    requiere_fin    boolean NOT NULL                 -- ¿debe traer fecha de fin real?
);
INSERT INTO staging.map_estados VALUES
    ('Activo',     'EN_CURSO',   false),
    ('Finalizado', 'FINALIZADA', true),
    ('Abandonado', 'RETIRADA',   true);

-- =============================================================================
-- 1. Funciones de limpieza (en staging: desaparecen con `pnpm etl:staging:drop`)
-- =============================================================================

-- Trim + colapsar espacios. '' → NULL.
CREATE OR REPLACE FUNCTION staging.fn_limpiar(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT NULLIF(regexp_replace(btrim(p), '\s+', ' ', 'g'), '');
$$;

-- "dd/mm/aaaa" → date. NULL para el centinela 01/01/1900 y para fechas inválidas
-- (31/02/2026 no pasa: se exige ida y vuelta exacta). Usar con fn_fecha_valida.
CREATE OR REPLACE FUNCTION staging.fn_fecha(p text)
RETURNS date LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v date;
BEGIN
    IF p IS NULL OR p !~ '^\d{2}/\d{2}/\d{4}$' OR p = '01/01/1900' THEN
        RETURN NULL;
    END IF;
    v := to_date(p, 'DD/MM/YYYY');
    RETURN CASE WHEN to_char(v, 'DD/MM/YYYY') = p THEN v END;
END;
$$;

-- true si es una fecha real o el centinela "sin fecha".
CREATE OR REPLACE FUNCTION staging.fn_fecha_valida(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    SELECT p = '01/01/1900' OR staging.fn_fecha(p) IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION staging.fn_corregir_mojibake(p text)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
    r record;
BEGIN
    IF p IS NULL OR position('Ã' IN p) = 0 THEN
        RETURN p;
    END IF;
    FOR r IN SELECT roto, correcto FROM staging.map_mojibake LOOP
        p := replace(p, r.roto, r.correcto);
    END LOOP;
    RETURN p;
END;
$$;

-- Quita el sufijo de modalidad: "INGENIERIA CIVIL (SEMIPRESENCIAL)" → "INGENIERIA CIVIL".
-- Misma regla que ck_careers_nombre_sin_modalidad (migración 003).
CREATE OR REPLACE FUNCTION staging.fn_carrera_sin_modalidad(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT staging.fn_limpiar(regexp_replace(
        p, '\s*\(\s*(semi\s*-?\s*presencial|presencial|virtual)\s*\)', '', 'gi'));
$$;

-- Regla 5b: fin anterior al inicio → sumar años al fin hasta alcanzar el inicio.
CREATE OR REPLACE FUNCTION staging.fn_ajustar_fin(p_inicio date, p_fin date)
RETURNS date LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v date := p_fin;
BEGIN
    IF p_inicio IS NULL OR v IS NULL THEN
        RETURN v;
    END IF;
    WHILE v < p_inicio LOOP
        v := (v + interval '1 year')::date;
    END LOOP;
    RETURN v;
END;
$$;

-- Fecha local de El Salvador → timestamptz (medianoche local).
CREATE OR REPLACE FUNCTION staging.fn_inicio_dia(p date)
RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
    SELECT (p::timestamp AT TIME ZONE 'America/El_Salvador');
$$;

-- =============================================================================
-- 2. Vistas tipadas (texto crudo → tipos del esquema maestro)
-- =============================================================================
CREATE OR REPLACE VIEW staging.v_pdf AS
SELECT
    r.id,
    r.archivo,
    r.pagina,
    staging.fn_limpiar(r.carnet)                  AS carnet,
    -- El mojibake viene del sistema de origen: también aparece en los PDFs.
    staging.fn_limpiar(staging.fn_corregir_mojibake(r.nombre_completo)) AS nombre_completo,
    staging.fn_limpiar(r.cod_institucion)         AS cod_institucion,
    staging.fn_limpiar(staging.fn_corregir_mojibake(r.institucion))     AS institucion,
    staging.fn_limpiar(r.correlativo)             AS correlativo,
    staging.fn_limpiar(staging.fn_corregir_mojibake(r.proyecto_nombre)) AS proyecto_nombre,
    staging.fn_carrera_sin_modalidad(r.carrera)   AS carrera_reporte,
    staging.fn_fecha(r.fecha_inicio)              AS fecha_inicio,
    staging.fn_fecha(r.fecha_fin)                 AS fecha_fin,
    CASE WHEN r.horas_asignadas ~ '^\d+$' THEN r.horas_asignadas::integer END AS horas,
    staging.fn_limpiar(r.estado)                  AS estado_reporte,
    -- crudos, para validar
    r.fecha_inicio                                AS fecha_inicio_raw,
    r.fecha_fin                                   AS fecha_fin_raw,
    r.horas_asignadas                             AS horas_raw
FROM staging.pdf_hour_rows r;

CREATE OR REPLACE VIEW staging.v_xls AS
SELECT
    r.id,
    r.fila_excel,
    staging.fn_limpiar(r.area)                                             AS area,
    staging.fn_limpiar(r.cod_institucion)                                  AS cod_institucion,
    staging.fn_limpiar(staging.fn_corregir_mojibake(r.institucion))        AS institucion,
    staging.fn_limpiar(r.correlativo)                                      AS correlativo,
    staging.fn_limpiar(staging.fn_corregir_mojibake(r.proyecto_nombre))    AS proyecto_nombre,
    CASE WHEN r.alumnos ~ '^\d+$' THEN r.alumnos::integer END              AS alumnos,
    staging.fn_fecha(r.fecha_inicio)                                       AS fecha_inicio,
    staging.fn_ajustar_fin(staging.fn_fecha(r.fecha_inicio), staging.fn_fecha(r.fecha_fin)) AS fecha_fin,
    r.fecha_inicio                                                         AS fecha_inicio_raw,
    r.fecha_fin                                                            AS fecha_fin_raw
FROM staging.xls_project_rows r;

-- =============================================================================
-- 3. Validación → cuarentena. Una fila con al menos un motivo NO se carga.
-- =============================================================================
DROP TABLE IF EXISTS staging.rechazos;
CREATE TABLE staging.rechazos (
    origen       text   NOT NULL,                    -- 'PDF' | 'XLS'
    staging_id   bigint NOT NULL,                    -- id en staging.pdf_hour_rows / xls_project_rows
    motivo       text   NOT NULL,
    detalle      text,
    PRIMARY KEY (origen, staging_id, motivo)
);

-- Correcciones automáticas aplicadas (la fila SÍ se carga, pero con el valor ajustado).
DROP TABLE IF EXISTS staging.ajustes;
CREATE TABLE staging.ajustes (
    origen          text   NOT NULL,
    staging_id      bigint NOT NULL,
    campo           text   NOT NULL,
    valor_original  text,
    valor_ajustado  text,
    regla           text   NOT NULL,
    PRIMARY KEY (origen, staging_id, campo)
);

INSERT INTO staging.ajustes (origen, staging_id, campo, valor_original, valor_ajustado, regla)
SELECT 'XLS', v.id, 'fecha_fin', v.fecha_fin_raw, to_char(v.fecha_fin, 'DD/MM/YYYY'),
       'fin_antes_de_inicio: +1 año hasta fin >= inicio (' || v.fecha_inicio_raw || ')'
FROM staging.v_xls v
WHERE v.fecha_fin IS DISTINCT FROM staging.fn_fecha(v.fecha_fin_raw);

-- 3.1 Reglas por fila (PDF)
INSERT INTO staging.rechazos (origen, staging_id, motivo, detalle)
SELECT 'PDF', v.id, m.motivo, m.detalle
FROM staging.v_pdf v
CROSS JOIN LATERAL (VALUES
    ('carnet_invalido',        v.carnet IS NULL OR v.carnet !~ '^\d{8}$',                         v.carnet),
    ('nombre_vacio',           v.nombre_completo IS NULL,                                          NULL),
    ('cod_institucion_invalido', v.cod_institucion IS NULL OR v.cod_institucion !~ '^\d+$',       v.cod_institucion),
    ('institucion_vacia',      v.institucion IS NULL,                                              NULL),
    ('correlativo_invalido',   v.correlativo IS NULL OR v.correlativo !~ '^\d+$',                  v.correlativo),
    ('proyecto_vacio',         v.proyecto_nombre IS NULL,                                          NULL),
    ('mojibake_sin_mapeo',     position('Ã' IN coalesce(v.nombre_completo, '') || coalesce(v.institucion, '')
                                               || coalesce(v.proyecto_nombre, '')) > 0,
                               concat_ws(' | ', v.nombre_completo, v.institucion, v.proyecto_nombre)),
    ('carrera_sin_mapeo',      NOT EXISTS (SELECT 1 FROM staging.map_carreras c
                                           WHERE c.carrera_reporte = v.carrera_reporte),         v.carrera_reporte),
    ('estado_sin_mapeo',       NOT EXISTS (SELECT 1 FROM staging.map_estados e
                                           WHERE e.estado_reporte = v.estado_reporte),           v.estado_reporte),
    ('fecha_inicio_invalida',  v.fecha_inicio IS NULL,                                             v.fecha_inicio_raw),
    ('fecha_fin_invalida',     NOT coalesce(staging.fn_fecha_valida(v.fecha_fin_raw), false),     v.fecha_fin_raw),
    ('horas_invalidas',        v.horas IS NULL,                                                    v.horas_raw),
    ('fin_antes_de_inicio',    v.fecha_fin < v.fecha_inicio,
                               v.fecha_inicio_raw || ' > ' || v.fecha_fin_raw),
    -- Regla 6 y su contraparte: el estado y la fecha de fin deben ser coherentes.
    ('estado_requiere_fin',    EXISTS (SELECT 1 FROM staging.map_estados e
                                       WHERE e.estado_reporte = v.estado_reporte AND e.requiere_fin)
                               AND v.fecha_fin IS NULL,                                            v.estado_reporte),
    ('activo_con_fin',         v.estado_reporte = 'Activo' AND v.fecha_fin IS NOT NULL,            v.fecha_fin_raw),
    -- Horas sin fecha de fin no tienen fecha_horas para el libro mayor.
    ('activo_con_horas',       v.estado_reporte = 'Activo' AND v.horas > 0,                        v.horas_raw)
) AS m(motivo, falla, detalle)
WHERE m.falla;

-- 3.2 Reglas entre filas (PDF): se rechazan TODAS las filas involucradas.
INSERT INTO staging.rechazos (origen, staging_id, motivo, detalle)
SELECT 'PDF', v.id, 'carnet_con_varios_nombres', string_agg(DISTINCT v2.nombre_completo, ' / ')
FROM staging.v_pdf v
JOIN staging.v_pdf v2 ON v2.carnet = v.carnet AND v2.nombre_completo IS DISTINCT FROM v.nombre_completo
GROUP BY v.id
ON CONFLICT DO NOTHING;

INSERT INTO staging.rechazos (origen, staging_id, motivo, detalle)
SELECT 'PDF', v.id, 'carnet_con_varias_carreras', string_agg(DISTINCT v2.carrera_reporte, ' / ')
FROM staging.v_pdf v
JOIN staging.v_pdf v2 ON v2.carnet = v.carnet AND v2.carrera_reporte IS DISTINCT FROM v.carrera_reporte
GROUP BY v.id
ON CONFLICT DO NOTHING;

INSERT INTO staging.rechazos (origen, staging_id, motivo, detalle)
SELECT 'PDF', v.id, 'participacion_duplicada', v.carnet || ' en ' || v.cod_institucion || '/' || v.correlativo
FROM staging.v_pdf v
WHERE (v.carnet, v.cod_institucion, v.correlativo) IN (
    SELECT carnet, cod_institucion, correlativo FROM staging.v_pdf
    GROUP BY 1, 2, 3 HAVING count(*) > 1)
ON CONFLICT DO NOTHING;

-- 3.3 Reglas por fila (Excel)
INSERT INTO staging.rechazos (origen, staging_id, motivo, detalle)
SELECT 'XLS', v.id, m.motivo, m.detalle
FROM staging.v_xls v
CROSS JOIN LATERAL (VALUES
    ('cod_institucion_invalido', v.cod_institucion IS NULL OR v.cod_institucion !~ '^\d+$', v.cod_institucion),
    ('institucion_vacia',        v.institucion IS NULL,                                     NULL),
    ('correlativo_invalido',     v.correlativo IS NULL OR v.correlativo !~ '^\d+$',         v.correlativo),
    ('proyecto_vacio',           v.proyecto_nombre IS NULL,                                 NULL),
    ('mojibake_sin_mapeo',       position('Ã' IN coalesce(v.institucion, '') || coalesce(v.proyecto_nombre, '')) > 0,
                                 v.institucion || ' | ' || v.proyecto_nombre),
    ('fecha_inicio_invalida',    NOT coalesce(staging.fn_fecha_valida(v.fecha_inicio_raw), false), v.fecha_inicio_raw),
    ('fecha_fin_invalida',       NOT coalesce(staging.fn_fecha_valida(v.fecha_fin_raw), false),    v.fecha_fin_raw),
    ('fin_antes_de_inicio',      v.fecha_fin < v.fecha_inicio, v.fecha_inicio_raw || ' > ' || v.fecha_fin_raw)
) AS m(motivo, falla, detalle)
WHERE m.falla;

INSERT INTO staging.rechazos (origen, staging_id, motivo, detalle)
SELECT 'XLS', v.id, 'proyecto_duplicado', v.cod_institucion || '/' || v.correlativo
FROM staging.v_xls v
WHERE (v.cod_institucion, v.correlativo) IN (
    SELECT cod_institucion, correlativo FROM staging.v_xls GROUP BY 1, 2 HAVING count(*) > 1)
ON CONFLICT DO NOTHING;

-- 3.4 Filas válidas
CREATE OR REPLACE VIEW staging.v_pdf_ok AS
SELECT v.*, c.carrera, e.estado
FROM staging.v_pdf v
JOIN staging.map_carreras c ON c.carrera_reporte = v.carrera_reporte
JOIN staging.map_estados  e ON e.estado_reporte  = v.estado_reporte
WHERE NOT EXISTS (SELECT 1 FROM staging.rechazos x WHERE x.origen = 'PDF' AND x.staging_id = v.id);

CREATE OR REPLACE VIEW staging.v_xls_ok AS
SELECT v.*
FROM staging.v_xls v
WHERE NOT EXISTS (SELECT 1 FROM staging.rechazos x WHERE x.origen = 'XLS' AND x.staging_id = v.id);

-- =============================================================================
-- 4. Conjuntos consolidados (PDF manda; el Excel completa)
-- =============================================================================
CREATE TEMP TABLE tmp_institutions ON COMMIT DROP AS
SELECT cod_institucion AS codigo_css,
       -- regla 4: el nombre del PDF gana sobre el del Excel
       coalesce(min(institucion) FILTER (WHERE fuente = 'PDF'), min(institucion)) AS nombre
FROM (
    SELECT cod_institucion, institucion, 'PDF' AS fuente FROM staging.v_pdf_ok
    UNION ALL
    SELECT cod_institucion, institucion, 'XLS' FROM staging.v_xls_ok
) s
GROUP BY cod_institucion;

CREATE TEMP TABLE tmp_projects ON COMMIT DROP AS
WITH pdf AS (
    SELECT cod_institucion, correlativo,
           min(proyecto_nombre)                                AS titulo,
           min(fecha_inicio)                                   AS inicio_estudiantes,
           -- Sin estudiantes activos, el proyecto cerró con la última fecha de fin.
           CASE WHEN bool_or(estado = 'EN_CURSO') THEN NULL ELSE max(fecha_fin) END AS cierre_estudiantes
    FROM staging.v_pdf_ok
    GROUP BY 1, 2
)
SELECT
    coalesce(p.cod_institucion, x.cod_institucion)  AS codigo_css,
    coalesce(p.correlativo, x.correlativo)          AS correlativo_css,
    coalesce(p.titulo, x.proyecto_nombre)           AS titulo,
    -- Las fechas de PROYECTO solo existen en el Excel; si no está, se derivan de los estudiantes.
    CASE WHEN x.id IS NOT NULL THEN x.fecha_inicio ELSE p.inicio_estudiantes END AS fecha_inicio,
    CASE WHEN x.id IS NOT NULL THEN x.fecha_fin    ELSE p.cierre_estudiantes END AS fecha_cierre,
    x.area
FROM pdf p
FULL JOIN staging.v_xls_ok x
       ON x.cod_institucion = p.cod_institucion AND x.correlativo = p.correlativo;

-- =============================================================================
-- 5. Carga al esquema maestro (orden de dependencias)
-- =============================================================================

-- 5.1 Facultades y carreras: NO se cargan aquí. Son el catálogo oficial de la migración 003;
-- los estudiantes se enlazan a él por students.career_id (paso 5.6).

-- 5.2 Instituciones.
-- Si la app ya creó la institución con el mismo nombre pero sin código, se adopta
-- (evita violar uq_institutions_nombre y no duplica la institución).
UPDATE institutions i
SET codigo_css = t.codigo_css
FROM tmp_institutions t
WHERE i.codigo_css IS NULL
  AND i.nombre_normalizado = fn_normalize_text(t.nombre)
  AND NOT EXISTS (SELECT 1 FROM institutions o WHERE o.codigo_css = t.codigo_css);

INSERT INTO institutions (codigo_css, nombre)
SELECT codigo_css, nombre FROM tmp_institutions
ON CONFLICT (codigo_css) DO UPDATE
    SET nombre = EXCLUDED.nombre
    WHERE institutions.nombre IS DISTINCT FROM EXCLUDED.nombre;

-- 5.3 Atributo dinámico para el área temática del CSS (projects.atributos se valida
-- contra project_fields en la app).
INSERT INTO project_fields (clave, etiqueta, tipo, orden)
VALUES ('area_css', 'Área temática (CSS)', 'TEXTO', 100)
ON CONFLICT (clave) DO NOTHING;

-- 5.4 Proyectos. Llave natural: (institution_id, correlativo_css).
INSERT INTO projects (institution_id, correlativo_css, titulo, descripcion, naturaleza, estado,
                      fecha_inicio, fecha_cierre, atributos)
SELECT
    i.id,
    t.correlativo_css,
    t.titulo,
    '',                                              -- las fuentes no traen descripción
    'EXTERNA',
    -- Cierre ya ocurrido → FINALIZADO. Sin cierre o con cierre futuro (p. ej. ajustado por 5b) → ACTIVO.
    CASE WHEN t.fecha_cierre <= current_date THEN 'FINALIZADO' ELSE 'ACTIVO' END,
    t.fecha_inicio,
    t.fecha_cierre,
    CASE WHEN t.area IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('area_css', t.area) END
FROM tmp_projects t
JOIN institutions i ON i.codigo_css = t.codigo_css
ON CONFLICT (institution_id, correlativo_css) DO UPDATE
    SET titulo       = EXCLUDED.titulo,
        estado       = EXCLUDED.estado,
        fecha_inicio = EXCLUDED.fecha_inicio,
        fecha_cierre = EXCLUDED.fecha_cierre,
        atributos    = projects.atributos || EXCLUDED.atributos
    WHERE (projects.titulo, projects.estado, projects.fecha_inicio, projects.fecha_cierre)
              IS DISTINCT FROM
          (EXCLUDED.titulo, EXCLUDED.estado, EXCLUDED.fecha_inicio, EXCLUDED.fecha_cierre)
       OR NOT projects.atributos @> EXCLUDED.atributos;

-- 5.5 Carreras de cada proyecto (según las carreras de sus estudiantes).
INSERT INTO project_careers (project_id, career_id)
SELECT DISTINCT p.id, c.id
FROM staging.v_pdf_ok v
JOIN institutions i ON i.codigo_css = v.cod_institucion
JOIN projects p     ON p.institution_id = i.id AND p.correlativo_css = v.correlativo
JOIN careers c      ON c.nombre_normalizado = fn_normalize_text(v.carrera)
ON CONFLICT (project_id, career_id) DO NOTHING;

-- 5.6 Estudiantes. Solo se actualizan mientras sigan siendo "históricos" (nombres NULL):
-- un estudiante que ya completó su perfil en la app no se toca.
INSERT INTO students (carnet, nombres, apellidos, nombre_completo, correo_institucional, career_id)
SELECT DISTINCT ON (v.carnet)
    v.carnet,
    NULL,
    NULL,
    v.nombre_completo,                               -- regla 1: bloque literal
    v.carnet || '@uca.edu.sv',
    c.id
FROM staging.v_pdf_ok v
JOIN careers c ON c.nombre_normalizado = fn_normalize_text(v.carrera)
ORDER BY v.carnet, v.id
ON CONFLICT (carnet) DO UPDATE
    SET nombre_completo = EXCLUDED.nombre_completo,
        career_id       = EXCLUDED.career_id
    WHERE students.nombres IS NULL
      AND (students.nombre_completo, students.career_id)
          IS DISTINCT FROM (EXCLUDED.nombre_completo, EXCLUDED.career_id);

-- 5.7 Participaciones. Llave natural: (student_id, project_id).
INSERT INTO project_enrollments (project_id, student_id, cargo, estado, asignada_en, cerrada_en)
SELECT
    p.id,
    s.id,
    'ESTUDIANTE',
    v.estado,
    staging.fn_inicio_dia(v.fecha_inicio),
    -- regla 6: Activo → sin cierre. FINALIZADA/RETIRADA → cierre = fecha de fin.
    CASE WHEN v.estado = 'EN_CURSO' THEN NULL ELSE staging.fn_inicio_dia(v.fecha_fin) END
FROM staging.v_pdf_ok v
JOIN students s     ON s.carnet = v.carnet
JOIN institutions i ON i.codigo_css = v.cod_institucion
JOIN projects p     ON p.institution_id = i.id AND p.correlativo_css = v.correlativo
ON CONFLICT (student_id, project_id) DO UPDATE
    SET estado      = EXCLUDED.estado,
        asignada_en = EXCLUDED.asignada_en,
        cerrada_en  = EXCLUDED.cerrada_en
    WHERE (project_enrollments.estado, project_enrollments.asignada_en, project_enrollments.cerrada_en)
          IS DISTINCT FROM (EXCLUDED.estado, EXCLUDED.asignada_en, EXCLUDED.cerrada_en);

-- 5.8 Libro mayor de horas: un movimiento por participación con horas > 0.
-- solicitud_id determinista (md5 del origen) → reejecutar no duplica horas.
INSERT INTO hour_movements (enrollment_id, horas, naturaleza, fecha_horas, descripcion, solicitud_id)
SELECT
    pe.id,
    v.horas,
    p.naturaleza,
    v.fecha_fin,
    format('Carga histórica CSS: %s, p. %s', v.archivo, v.pagina),
    md5(format('etl-css|%s|%s|%s', v.carnet, v.cod_institucion, v.correlativo))::uuid
FROM staging.v_pdf_ok v
JOIN students s             ON s.carnet = v.carnet
JOIN institutions i         ON i.codigo_css = v.cod_institucion
JOIN projects p             ON p.institution_id = i.id AND p.correlativo_css = v.correlativo
JOIN project_enrollments pe ON pe.student_id = s.id AND pe.project_id = p.id
WHERE v.horas > 0                                    -- regla 6: 0 horas no genera movimiento
ON CONFLICT (solicitud_id) DO UPDATE
    SET enrollment_id = EXCLUDED.enrollment_id,
        horas         = EXCLUDED.horas,
        naturaleza    = EXCLUDED.naturaleza,
        fecha_horas   = EXCLUDED.fecha_horas,
        descripcion   = EXCLUDED.descripcion
    WHERE (hour_movements.enrollment_id, hour_movements.horas, hour_movements.naturaleza,
           hour_movements.fecha_horas, hour_movements.descripcion)
          IS DISTINCT FROM
          (EXCLUDED.enrollment_id, EXCLUDED.horas, EXCLUDED.naturaleza,
           EXCLUDED.fecha_horas, EXCLUDED.descripcion);
