-- =============================================================================
-- 016_project_correlativo_alias.sql
-- Descripción: correlativos alternos de un proyecto del reporte CSS (revisión del
-- 23–25/11/2026).
--
-- Contexto: los PDF de horas por carrera a veces reportan a un estudiante con la
-- institución donde presta el servicio y el correlativo del MISMO programa registrado en
-- otra institución. Para la importación, (institución, correlativo) es la llave del
-- proyecto, así que cada combinación nueva creaba un proyecto aparte que el Excel CSS
-- («Memoria de Labores») no lista, aunque sí cuenta a esos alumnos en su proyecto oficial.
-- Un mismo correlativo NO significa lo mismo en todas las instituciones ni en todos los
-- reportes: la equivalencia nunca se deduce sola, se registra explícitamente.
--
-- 1. project_correlativo_alias: "en esta institución, el correlativo N del reporte de
--    horas es el proyecto oficial P". Lo crean la fusión revisada de proyectos (origen
--    FUSION) o una decisión en la revisión de una importación (REVISION_IMPORTACION),
--    siempre con justificación. Reglas (fn_alias_validar), para no mezclar proyectos
--    distintos:
--      • P es de la MISMA institución, está en el reporte CSS (en_reporte_css), tiene
--        correlativo propio y no es el proyecto de sistema;
--      • el título del reporte con el que se verificó la equivalencia (nombre_clave) es
--        el MISMO que el de P (mayúsculas, tildes y puntuación no importan; palabras
--        distintas u otro orden, sí);
--      • no existe un proyecto real con esa institución y ese correlativo (la llave no
--        puede significar dos cosas).
-- 2. projects: no se puede crear ni mover un proyecto a una (institución, correlativo)
--    que ya es alias de otro (fn_projects_sin_alias). La importación nunca llega a ese
--    caso porque resuelve el alias antes; el error protege cargas que no lo conozcan.
-- 3. import_project_links: nueva decisión ALIAS (el proyecto del lote es un correlativo
--    alterno de un proyecto del reporte CSS; exige project_id).
-- =============================================================================

SELECT set_config('app.actor', 'migracion:016_project_correlativo_alias', true);

CREATE TABLE project_correlativo_alias (
    id                   bigint      GENERATED ALWAYS AS IDENTITY,
    institution_id       uuid        NOT NULL,
    correlativo_css      text        NOT NULL,   -- sin ceros a la izquierda (fn_import_numero)
    project_id           uuid        NOT NULL,   -- proyecto oficial del reporte CSS
    nombre_clave_reporte text        NOT NULL,   -- fn_nombre_clave del título con que se verificó
    origen               text        NOT NULL,
    justificacion        text        NOT NULL,
    creado_por           text        NOT NULL DEFAULT fn_current_actor(),
    creado_en            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_project_correlativo_alias PRIMARY KEY (id),
    CONSTRAINT uq_project_correlativo_alias UNIQUE (institution_id, correlativo_css),
    CONSTRAINT fk_project_correlativo_alias_institution FOREIGN KEY (institution_id)
        REFERENCES institutions (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_project_correlativo_alias_project FOREIGN KEY (project_id)
        REFERENCES projects (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT ck_project_correlativo_alias_correlativo
        CHECK (btrim(correlativo_css) <> '' AND correlativo_css = fn_import_numero(correlativo_css)),
    CONSTRAINT ck_project_correlativo_alias_origen CHECK (origen IN ('FUSION', 'REVISION_IMPORTACION')),
    CONSTRAINT ck_project_correlativo_alias_justificacion CHECK (length(btrim(justificacion)) >= 5)
);

CREATE INDEX ix_project_correlativo_alias_project ON project_correlativo_alias (project_id);

COMMENT ON TABLE project_correlativo_alias IS
    'Correlativo alterno (de los PDF de horas) de un proyecto del reporte CSS en la misma institución. Ver migración 016.';

CREATE FUNCTION fn_alias_validar()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_destino record;
BEGIN
    SELECT p.institution_id, p.correlativo_css, p.en_reporte_css, p.nombre_clave,
           (p.atributos ? 'sistema') AS es_sistema
      INTO v_destino
      FROM projects p WHERE p.id = NEW.project_id;

    IF v_destino.institution_id IS DISTINCT FROM NEW.institution_id THEN
        RAISE EXCEPTION 'alias de correlativo: el proyecto destino es de otra institución'
            USING ERRCODE = 'check_violation';
    END IF;
    IF v_destino.es_sistema OR NOT v_destino.en_reporte_css OR v_destino.correlativo_css IS NULL THEN
        RAISE EXCEPTION 'alias de correlativo: el destino debe ser un proyecto del reporte CSS con correlativo propio'
            USING ERRCODE = 'check_violation';
    END IF;
    IF fn_import_numero(v_destino.correlativo_css) = NEW.correlativo_css THEN
        RAISE EXCEPTION 'alias de correlativo: % ya es el correlativo propio del proyecto', NEW.correlativo_css
            USING ERRCODE = 'check_violation';
    END IF;
    IF v_destino.nombre_clave IS DISTINCT FROM NEW.nombre_clave_reporte THEN
        RAISE EXCEPTION 'alias de correlativo: el título del reporte no coincide con el del proyecto destino'
            USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM projects o
               WHERE o.institution_id = NEW.institution_id
                 AND fn_import_numero(o.correlativo_css) = NEW.correlativo_css) THEN
        RAISE EXCEPTION 'alias de correlativo: ya existe un proyecto con la institución y el correlativo %', NEW.correlativo_css
            USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_project_correlativo_alias_validar
    BEFORE INSERT OR UPDATE ON project_correlativo_alias
    FOR EACH ROW EXECUTE FUNCTION fn_alias_validar();

CREATE TRIGGER trg_project_correlativo_alias_auditoria
    AFTER INSERT OR UPDATE OR DELETE ON project_correlativo_alias
    FOR EACH ROW EXECUTE FUNCTION fn_auditoria('id');

CREATE FUNCTION fn_projects_sin_alias()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.correlativo_css IS NOT NULL AND EXISTS (
        SELECT 1 FROM project_correlativo_alias a
        WHERE a.institution_id = NEW.institution_id
          AND a.correlativo_css = fn_import_numero(NEW.correlativo_css)
          AND a.project_id <> NEW.id) THEN
        RAISE EXCEPTION 'El correlativo % de esta institución ya es un correlativo alterno de otro proyecto del reporte CSS',
            NEW.correlativo_css USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_projects_sin_alias
    BEFORE INSERT OR UPDATE OF correlativo_css, institution_id ON projects
    FOR EACH ROW EXECUTE FUNCTION fn_projects_sin_alias();

ALTER TABLE import_project_links
    DROP CONSTRAINT ck_import_project_links_decision,
    DROP CONSTRAINT ck_import_project_links_proyecto,
    ADD CONSTRAINT ck_import_project_links_decision CHECK (decision IN ('VINCULAR', 'ALIAS', 'CREAR_NUEVO')),
    ADD CONSTRAINT ck_import_project_links_proyecto CHECK ((decision IN ('VINCULAR', 'ALIAS')) = (project_id IS NOT NULL));

COMMENT ON COLUMN import_project_links.project_id IS
    'VINCULAR: proyecto de la app (sin correlativo) que se adopta. ALIAS: proyecto del reporte CSS del que el correlativo del lote es alterno.';
