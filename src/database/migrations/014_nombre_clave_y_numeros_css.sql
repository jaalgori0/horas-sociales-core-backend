-- =============================================================================
-- 014_nombre_clave_y_numeros_css.sql
-- Descripción: blindaje contra proyectos e instituciones duplicados por diferencias de
-- formato entre la app y los reportes del CSS (revisión del 22/11/2026).
--
-- 1. fn_nombre_clave(texto): clave de comparación FUERTE. NFC → sin diacríticos (también
--    los que no son á é í ó ú ü ñ y las tildes descompuestas NFD) → minúsculas →
--    cualquier carácter que no sea letra o número (puntuación, NBSP, guiones…) pasa a
--    espacio → espacios colapsados. "FISCALÍA GENERAL DE LA REPÚBLICA." y
--    "fiscalia  general de la republica" tienen la misma clave.
--    NO reemplaza a fn_normalize_text: esa sigue alimentando nombre_normalizado y sus
--    índices únicos (cambiarla dejaría inconsistentes las columnas generadas guardadas).
-- 2. projects.nombre_clave / institutions.nombre_clave: columnas GENERADAS (no se edita
--    ningún dato) con índices NO únicos: hay proyectos distintos con el mismo nombre en
--    una institución (p. ej. 524, correlativos 33 y 34) y duplicados históricos que se
--    revisan aparte. La app y la importación las usan para AVISAR, no para impedir.
-- 3. fn_import_numero(texto): "07" → "7" para códigos CSS y correlativos (solo si son
--    dígitos). Hoy ningún valor guardado tiene ceros a la izquierda: no cambia ninguna llave.
-- 4. import_project_links: decisión en la vista previa cuando un proyecto del lote
--    coincide por nombre_clave con un proyecto creado en la app (sin correlativo):
--    VINCULAR (lo adopta) o CREAR_NUEVO. Queda en la bitácora (acción VINCULAR).
-- =============================================================================

SELECT set_config('app.actor', 'migracion:014_nombre_clave_y_numeros_css', true);

CREATE FUNCTION fn_nombre_clave(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
    SELECT nullif(btrim(regexp_replace(
        lower(translate(
            -- Marcas combinantes que NFC no pudo componer (U+0300–U+036F).
            regexp_replace(normalize(p_value, NFC), '[\u0300-\u036f]', '', 'g'),
            'ÁÀÂÄÃÅÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇÝáàâäãåéèêëíìîïóòôöõúùûüñçýÿ',
            'AAAAAAEEEEIIIIOOOOOUUUUNCYaaaaaaeeeeiiiiooooouuuuncyy')),
        '[^a-z0-9]+', ' ', 'g')), '');
$$;
COMMENT ON FUNCTION fn_nombre_clave(text) IS
    'Clave de comparación de nombres: NFC, sin diacríticos, minúsculas, puntuación/NBSP → espacio, espacios colapsados.';

CREATE FUNCTION fn_import_numero(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
    SELECT CASE WHEN p_value ~ '^\d+$' THEN coalesce(nullif(ltrim(p_value, '0'), ''), '0') ELSE p_value END;
$$;
COMMENT ON FUNCTION fn_import_numero(text) IS 'Código CSS / correlativo sin ceros a la izquierda ("07" → "7"); otros valores sin cambio.';

ALTER TABLE projects ADD COLUMN nombre_clave text GENERATED ALWAYS AS (fn_nombre_clave(titulo)) STORED;
CREATE INDEX ix_projects_institution_clave ON projects (institution_id, nombre_clave);

ALTER TABLE institutions ADD COLUMN nombre_clave text GENERATED ALWAYS AS (fn_nombre_clave(nombre)) STORED;
CREATE INDEX ix_institutions_clave ON institutions (nombre_clave);

CREATE TABLE import_project_links (
    batch_id       uuid        NOT NULL,
    clave          text        NOT NULL,   -- import_items.clave del proyecto: codigo/correlativo
    decision       text        NOT NULL,
    project_id     uuid,                   -- VINCULAR: proyecto de la app que se adopta
    justificacion  text        NOT NULL,
    decidido_por   text        NOT NULL DEFAULT fn_current_actor(),
    decidido_en    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_import_project_links PRIMARY KEY (batch_id, clave),
    CONSTRAINT fk_import_project_links_batch FOREIGN KEY (batch_id)
        REFERENCES import_batches (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_import_project_links_project FOREIGN KEY (project_id)
        REFERENCES projects (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT ck_import_project_links_decision CHECK (decision IN ('VINCULAR', 'CREAR_NUEVO')),
    CONSTRAINT ck_import_project_links_proyecto CHECK ((decision = 'VINCULAR') = (project_id IS NOT NULL)),
    CONSTRAINT ck_import_project_links_justificacion CHECK (length(btrim(justificacion)) >= 5)
);

ALTER TABLE import_review_log DROP CONSTRAINT ck_import_review_log_accion;
ALTER TABLE import_review_log ADD CONSTRAINT ck_import_review_log_accion
    CHECK (accion IN ('EDITAR', 'EXCLUIR', 'RESTAURAR', 'DECIDIR', 'VINCULAR'));
ALTER TABLE import_review_log DROP CONSTRAINT ck_import_review_log_objetivo;
ALTER TABLE import_review_log ADD CONSTRAINT ck_import_review_log_objetivo CHECK (
    (accion IN ('DECIDIR', 'VINCULAR')) = (clave IS NOT NULL)
    AND (accion IN ('DECIDIR', 'VINCULAR')) = (pdf_row_id IS NULL));

-- Red de seguridad: la clave fuerte agrupa lo que debe agrupar.
DO $$
BEGIN
    IF fn_nombre_clave('FISCALÍA  GENERAL DE LA REPÚBLICA.') <> fn_nombre_clave('fiscalia general de la republica')
       OR fn_nombre_clave('APOYO' || chr(160) || 'JURI' || chr(769) || 'DICO-ADMINISTRATIVO') <> 'apoyo juridico administrativo'
       OR fn_nombre_clave('NIN' || chr(771) || 'EZ') <> 'ninez'
       OR fn_import_numero('007') <> '7' OR fn_import_numero('0') <> '0' THEN
        RAISE EXCEPTION 'fn_nombre_clave / fn_import_numero no normalizan como se espera';
    END IF;
END;
$$;
