-- =============================================================================
-- 008_institution_contact_project_classifications.sql
-- Descripción: datos de contacto de instituciones y clasificación múltiple de
-- proyectos.
--
-- 1. institutions: persona de contacto, correo y teléfono (opcionales).
--
-- 2. project_classifications: un proyecto puede tener varias clasificaciones a
--    la vez (hasta las 4):
--      SS_INTERNO         Servicio social interno
--      SS_EXTERNO         Servicio social externo
--      PROFESIONALIZANTE  Profesionalizante
--      CONTACTO_REALIDAD  Contacto con la realidad
--
-- 3. projects.naturaleza (INTERNA/EXTERNA) se conserva: es la naturaleza con la
--    que se registran las horas (hour_movements.naturaleza) al importar o al
--    asignar horas manuales. Desde ahora se DERIVA de las clasificaciones:
--      con SS_INTERNO → INTERNA; en cualquier otro caso → EXTERNA.
--    La mantiene un trigger; ningún código debe escribirla directamente.
--    Las horas ya registradas no cambian (cada movimiento guarda su naturaleza).
--
-- 4. Todo proyecto nuevo recibe la clasificación equivalente a su naturaleza
--    (trigger AFTER INSERT): así la importación del CSS y el ETL, que insertan
--    'EXTERNA', quedan como SS_EXTERNO sin cambios en su SQL. La aplicación
--    ajusta después las clasificaciones elegidas por el usuario.
-- =============================================================================

SELECT set_config('app.actor', 'migracion:008_institution_contact_project_classifications', true);

-- -----------------------------------------------------------------------------
-- 1. Contacto de la institución
-- -----------------------------------------------------------------------------
ALTER TABLE institutions
    ADD COLUMN contacto_nombre text,
    ADD COLUMN contacto_email  text,
    ADD COLUMN telefono        text;

ALTER TABLE institutions
    ADD CONSTRAINT ck_institutions_contacto_nombre
        CHECK (contacto_nombre IS NULL OR btrim(contacto_nombre) <> ''),
    ADD CONSTRAINT ck_institutions_contacto_email
        CHECK (contacto_email IS NULL OR contacto_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    ADD CONSTRAINT ck_institutions_telefono
        CHECK (telefono IS NULL OR telefono ~ '^[0-9+\-\s]{8,20}$');

COMMENT ON COLUMN institutions.contacto_nombre IS 'Persona de contacto en la institución.';
COMMENT ON COLUMN institutions.contacto_email IS 'Correo de contacto de la institución.';
COMMENT ON COLUMN institutions.telefono IS 'Teléfono de contacto (dígitos, espacios, + y -; 8 a 20 caracteres).';

-- -----------------------------------------------------------------------------
-- 2. Clasificaciones de proyecto
-- -----------------------------------------------------------------------------
CREATE TABLE project_classifications (
    project_id     uuid        NOT NULL,
    clasificacion  text        NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_project_classifications PRIMARY KEY (project_id, clasificacion),
    CONSTRAINT fk_project_classifications_project FOREIGN KEY (project_id)
        REFERENCES projects (id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT ck_project_classifications_clasificacion CHECK (clasificacion IN
        ('SS_INTERNO', 'SS_EXTERNO', 'PROFESIONALIZANTE', 'CONTACTO_REALIDAD'))
);
CREATE INDEX ix_project_classifications_clasificacion ON project_classifications (clasificacion);

COMMENT ON TABLE project_classifications IS
    'Clasificaciones (no excluyentes) de un proyecto. SS_INTERNO determina projects.naturaleza = INTERNA.';

-- Datos existentes: la naturaleza actual define la clasificación inicial.
-- (Antes de crear el trigger de auditoría: es un relleno, no una edición de usuarios.)
INSERT INTO project_classifications (project_id, clasificacion)
SELECT p.id, CASE WHEN p.naturaleza = 'INTERNA' THEN 'SS_INTERNO' ELSE 'SS_EXTERNO' END
FROM projects p
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. projects.naturaleza derivada de las clasificaciones
-- -----------------------------------------------------------------------------
CREATE FUNCTION fn_project_sync_naturaleza(p_project_id uuid)
RETURNS void
LANGUAGE sql
AS $$
    UPDATE projects p
    SET naturaleza = n.valor
    FROM (
        SELECT CASE WHEN EXISTS (
                   SELECT 1 FROM project_classifications pc
                    WHERE pc.project_id = p_project_id AND pc.clasificacion = 'SS_INTERNO'
               ) THEN 'INTERNA' ELSE 'EXTERNA' END AS valor
    ) n
    WHERE p.id = p_project_id
      AND p.naturaleza IS DISTINCT FROM n.valor;
$$;

CREATE FUNCTION fn_project_classifications_sync()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        PERFORM fn_project_sync_naturaleza(OLD.project_id);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        PERFORM fn_project_sync_naturaleza(NEW.project_id);
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_project_classifications_sync
    AFTER INSERT OR UPDATE OR DELETE ON project_classifications
    FOR EACH ROW EXECUTE FUNCTION fn_project_classifications_sync();

-- -----------------------------------------------------------------------------
-- 4. Clasificación inicial de todo proyecto nuevo
-- -----------------------------------------------------------------------------
CREATE FUNCTION fn_projects_clasificacion_inicial()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO project_classifications (project_id, clasificacion)
    VALUES (NEW.id, CASE WHEN NEW.naturaleza = 'INTERNA' THEN 'SS_INTERNO' ELSE 'SS_EXTERNO' END)
    ON CONFLICT DO NOTHING;
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_projects_clasificacion_inicial
    AFTER INSERT ON projects
    FOR EACH ROW EXECUTE FUNCTION fn_projects_clasificacion_inicial();

-- -----------------------------------------------------------------------------
-- 5. Auditoría
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_project_classifications_auditoria
    AFTER INSERT OR UPDATE OR DELETE ON project_classifications
    FOR EACH ROW EXECUTE FUNCTION fn_auditoria('project_id');
