-- =============================================================================
-- 002_legacy_css_import_support.sql
-- Descripción: soporte para importar el histórico del CSS (PDFs "Detalle de Horas
-- por Proyecto" y Excel "Memoria de Labores"). Ver src/etl/.
--
-- 1. students: los reportes solo traen el nombre como bloque literal
--    "APELLIDO1, APELLIDO2 NOMBRES", y separarlo sería interpretarlo. Por eso:
--      • nombre_completo deja de ser GENERADA y pasa a ser columna normal NOT NULL.
--      • nombres/apellidos admiten NULL (ambos a la vez) para registros históricos.
--      • Un trigger mantiene nombre_completo = nombres || ' ' || apellidos cuando
--        ambos existen: para la app el comportamiento no cambia.
-- 2. institutions.codigo_css: código de la institución en el sistema del CSS.
-- 3. projects.correlativo_css: correlativo del proyecto en el CSS. La llave natural
--    pasa a ser (institution_id, correlativo_css): el CSS tiene proyectos distintos
--    con el mismo nombre en una institución (p. ej. inst. 524, correlativos 33 y 34).
--    La unicidad por nombre se conserva solo para proyectos sin correlativo.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. students.nombre_completo
-- -----------------------------------------------------------------------------
DROP VIEW v_student_hours;                          -- depende de nombre_completo; se recrea abajo
ALTER TABLE students DROP COLUMN nombre_completo;  -- arrastra ix_students_nombre_completo
ALTER TABLE students ADD COLUMN nombre_completo text;
UPDATE students SET nombre_completo = nombres || ' ' || apellidos;
ALTER TABLE students ALTER COLUMN nombre_completo SET NOT NULL;

ALTER TABLE students ALTER COLUMN nombres DROP NOT NULL;
ALTER TABLE students ALTER COLUMN apellidos DROP NOT NULL;
ALTER TABLE students DROP CONSTRAINT ck_students_nombres;
ALTER TABLE students ADD CONSTRAINT ck_students_nombres CHECK (
    (nombres IS NULL) = (apellidos IS NULL)
    AND (nombres IS NULL OR (btrim(nombres) <> '' AND btrim(apellidos) <> ''))
);
ALTER TABLE students ADD CONSTRAINT ck_students_nombre_completo CHECK (btrim(nombre_completo) <> '');
CREATE INDEX ix_students_nombre_completo ON students (lower(nombre_completo));

COMMENT ON COLUMN students.nombre_completo IS
    'Derivado de nombres + apellidos por trigger. En históricos del CSS (nombres/apellidos NULL) '
    'guarda el bloque literal del reporte: "APELLIDO1, APELLIDO2 NOMBRES".';

CREATE OR REPLACE FUNCTION fn_students_nombre_completo()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.nombres IS NOT NULL AND NEW.apellidos IS NOT NULL THEN
        NEW.nombre_completo := NEW.nombres || ' ' || NEW.apellidos;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_students_nombre_completo
    BEFORE INSERT OR UPDATE OF nombres, apellidos, nombre_completo ON students
    FOR EACH ROW EXECUTE FUNCTION fn_students_nombre_completo();

-- Misma definición que en 001.
CREATE VIEW v_student_hours AS
SELECT
    s.id                                                                AS student_id,
    s.carnet,
    s.nombre_completo,
    COALESCE(SUM(hm.horas) FILTER (WHERE hm.naturaleza = 'INTERNA'), 0)::integer AS horas_internas,
    COALESCE(SUM(hm.horas) FILTER (WHERE hm.naturaleza = 'EXTERNA'), 0)::integer AS horas_externas,
    COALESCE(SUM(hm.horas), 0)::integer                                 AS horas_totales,
    COUNT(DISTINCT pe.id)::integer                                      AS participaciones
FROM students s
LEFT JOIN project_enrollments pe ON pe.student_id = s.id
LEFT JOIN hour_movements hm      ON hm.enrollment_id = pe.id
GROUP BY s.id;

-- -----------------------------------------------------------------------------
-- 2. institutions.codigo_css
-- -----------------------------------------------------------------------------
ALTER TABLE institutions ADD COLUMN codigo_css text;
ALTER TABLE institutions ADD CONSTRAINT uq_institutions_codigo_css UNIQUE (codigo_css);
ALTER TABLE institutions ADD CONSTRAINT ck_institutions_codigo_css
    CHECK (codigo_css IS NULL OR btrim(codigo_css) <> '');
COMMENT ON COLUMN institutions.codigo_css IS 'Código de la institución en el sistema del CSS (columna COD. de los reportes).';

-- -----------------------------------------------------------------------------
-- 3. projects.correlativo_css
-- -----------------------------------------------------------------------------
ALTER TABLE projects ADD COLUMN correlativo_css text;
ALTER TABLE projects ADD CONSTRAINT uq_projects_institution_correlativo UNIQUE (institution_id, correlativo_css);
ALTER TABLE projects ADD CONSTRAINT ck_projects_correlativo_css
    CHECK (correlativo_css IS NULL OR btrim(correlativo_css) <> '');
COMMENT ON COLUMN projects.correlativo_css IS 'Correlativo del proyecto en el CSS; único por institución.';

ALTER TABLE projects DROP CONSTRAINT uq_projects_institution_nombre;
CREATE UNIQUE INDEX uq_projects_institution_nombre
    ON projects (institution_id, nombre_normalizado)
    WHERE correlativo_css IS NULL;
